//! Host-owned grants and a bounded, atomic recovery journal. Only metadata is retained in memory.
use crate::text_annotations::{self, Highlight};
use crate::{
    files::{version, Fault, Result},
    text_files::{self, Encoding, Eol, Identity, TextFile, TextSave, FILE_LIMIT},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const META_LIMIT: usize = 128 * 1024;
const BODY_LIMIT: u64 = 64 * 1024 * 1024;
const DISK_LIMIT: u64 = 128 * 1024 * 1024;
static SEQUENCE: AtomicU64 = AtomicU64::new(1);
fn nonce() -> String {
    format!(
        "{:x}-{:x}-{:x}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}
fn recovery_error(message: impl Into<String>) -> Fault {
    Fault::new("text-recovery", message)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextRecord {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub highlights: Vec<Highlight>,
    pub id: String,
    pub path: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    pub length: usize,
    pub version: String,
    pub encoding: Encoding,
    pub eol: Eol,
    pub revision: u64,
    pub saved_revision: u64,
    pub cursor: usize,
    pub anchor: usize,
    pub scroll: f64,
    pub language: String,
    pub tab_size: u8,
    pub indent_with_tabs: bool,
    pub wrap: bool,
    #[serde(default)]
    pub readonly: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<Fault>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextSnapshot {
    pub schema: u8,
    pub generation: u64,
    pub documents: Vec<TextRecord>,
    pub views: Vec<String>,
    pub active: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}
impl Default for TextSnapshot {
    fn default() -> Self {
        Self {
            schema: 1,
            generation: 0,
            documents: Vec::new(),
            views: Vec::new(),
            active: 0,
            warning: None,
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextCommit {
    pub generation: u64,
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTextStatus {
    pub generation: u64,
    pub confirmed_generation: Option<u64>,
    pub lifecycle_ready: bool,
    pub documents: usize,
    pub disk_bytes: u64,
    pub resident_body_bytes: usize,
    pub window_visible: Option<bool>,
    pub idle_pending: bool,
}
#[derive(Default)]
pub struct ProfileSelection {
    pub open: Option<Vec<PathBuf>>,
    pub save: Option<ProfileSaveSelection>,
}
pub struct ProfileSaveSelection {
    pub path: Option<PathBuf>,
    pub baseline: Option<(Identity, String)>,
}
#[derive(Default, Serialize)]
pub struct TextOpenResult {
    pub files: Vec<TextFile>,
    pub errors: Vec<Fault>,
    pub notes: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum TextProbeResult {
    Unchanged {
        id: String,
        version: String,
        size: u64,
        readonly: bool,
    },
    Changed {
        file: TextFile,
    },
}
/// Calls without knownVersion retain the original, unwrapped TextFile response.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum TextReadReply {
    Full(TextFile),
    Probed(TextProbeResult),
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Grant {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    encoding: Option<Encoding>,
    path: PathBuf,
    identity: Identity,
    epoch: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Grants {
    schema: u8,
    records: BTreeMap<String, Grant>,
    hash: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Blob {
    name: String,
    hash: String,
    bytes: u64,
    length: usize,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    snapshot: TextSnapshot,
    blobs: BTreeMap<String, Blob>,
    hash: String,
}
#[derive(Clone)]
struct NoteOwner {
    path: PathBuf,
    identity: Identity,
    relative: String,
}
pub struct TextStore {
    root: PathBuf,
    grants: BTreeMap<String, Grant>,
    manifest: Manifest,
    active: BTreeMap<String, usize>,
    notes: Vec<NoteOwner>,
    generation: u64,
    confirmed: Option<(u64, String)>,
    blocked: Option<Fault>,
    body_blocked: BTreeMap<String, Fault>,
    pending_warning: Option<String>,
    grants_dirty: bool,
    grants_quarantine: bool,
    session_changed: bool,
}
fn json<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(|e| recovery_error(format!("恢复记录无法序列化：{e}")))
}
fn bounded_read(path: &Path, limit: usize) -> Result<Vec<u8>> {
    let file = fs::File::open(path)?;
    if file.metadata()?.len() > limit as u64 {
        return Err(recovery_error("恢复记录超过安全上限，已保留原数据。"));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit {
        return Err(recovery_error("恢复记录读取期间超过上限。"));
    }
    Ok(bytes)
}
fn atomic_metadata(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temp = tempfile::Builder::new()
        .prefix(".text-meta-")
        .tempfile_in(path.parent().unwrap())?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    temp.persist(path).map_err(|e| Fault::from(e.error))?;
    Ok(())
}
fn manifest_hash(manifest: &Manifest) -> Result<String> {
    Ok(version(&json(&(&manifest.snapshot, &manifest.blobs))?))
}
fn validate(snapshot: &TextSnapshot) -> Result<()> {
    let mut ids = HashSet::new();
    if snapshot.schema != 1
        || snapshot.documents.len() > 12
        || (!snapshot.documents.is_empty() && snapshot.views.is_empty())
        || snapshot.views.len() > 2
        || (!snapshot.views.is_empty() && snapshot.active >= snapshot.views.len())
        || (snapshot.views.is_empty() && snapshot.active != 0)
    {
        return Err(recovery_error("文本会话结构或视图数量无效。"));
    }
    let mut total = 0usize;
    let mut marks = 0usize;
    for doc in &snapshot.documents {
        text_annotations::validate(&doc.highlights, doc.length)?;
        marks += doc.highlights.len();
        if marks > text_annotations::SESSION_MARK_LIMIT {
            return Err(recovery_error("全部文本标注超过 1024 处。"));
        }
        if !text_files::valid_id(&doc.id)
            || !ids.insert(doc.id.clone())
            || ![2, 4, 8].contains(&doc.tab_size)
            || !doc.scroll.is_finite()
            || doc.scroll < 0.0
            || doc.name.len() > 1024
            || doc.language.len() > 100
            || doc.version.len() > 128
            || doc.path.as_ref().is_some_and(|p| p.len() > 32768)
            || doc.saved_revision > doc.revision
        {
            return Err(recovery_error("文本恢复包含无效文档元数据。"));
        }
        if let Some(body) = &doc.text {
            if body.encode_utf16().count() != doc.length || body.contains('\0') {
                return Err(recovery_error("草稿正文长度或字符无效。"));
            }
        }
        total = total
            .checked_add(doc.length)
            .ok_or_else(|| recovery_error("文本正文配额溢出。"))?;
        if total > FILE_LIMIT || doc.cursor > doc.length || doc.anchor > doc.length {
            return Err(recovery_error("文本正文或光标超过允许的上限。"));
        }
    }
    let mut views = HashSet::new();
    for id in &snapshot.views {
        if !ids.contains(id) || !views.insert(id) {
            return Err(recovery_error("文本视图引用了无效或重复文档。"));
        }
    }
    let mut metadata = snapshot.clone();
    for doc in &mut metadata.documents {
        doc.text = None;
    }
    if json(&metadata)?.len() > META_LIMIT {
        return Err(recovery_error("文本恢复元数据超过 128 KiB。"));
    }
    Ok(())
}
impl TextStore {
    pub fn load(data: &Path) -> Self {
        let root = data.join("text-recovery");
        let mut store = Self {
            root,
            grants: BTreeMap::new(),
            manifest: Manifest::default(),
            active: BTreeMap::new(),
            notes: Vec::new(),
            generation: 0,
            confirmed: None,
            blocked: None,
            body_blocked: BTreeMap::new(),
            pending_warning: None,
            grants_dirty: false,
            grants_quarantine: false,
            session_changed: false,
        };
        if let Err(e) = store.load_metadata() {
            store.blocked = Some(e);
        }
        store
    }
    fn load_metadata(&mut self) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        let grant_result =
            bounded_read(&self.root.join("grants.json"), META_LIMIT).and_then(|bytes| {
                let grants: Grants = serde_json::from_slice(&bytes)
                    .map_err(|_| recovery_error("文本授权记录损坏，已保留；需重新选择文件。"))?;
                if grants.schema != 1
                    || grants.hash != version(&json(&grants.records)?)
                    || grants.records.iter().any(|(id, g)| {
                        !text_files::valid_id(id) || !g.path.is_absolute() || g.epoch.len() > 100
                    })
                {
                    return Err(recovery_error("文本授权记录完整性校验失败，已保留。"));
                }
                Ok(grants.records)
            });
        match grant_result {
            Ok(grants) => self.grants = grants,
            Err(e) if e.code == "missing" => {}
            Err(e) => {
                self.grants_quarantine = true;
                self.pending_warning = Some(format!(
                    "文本原文件授权不可用，原记录已保留；草稿仍可暂存，原文件须重新授权。{}",
                    e.message
                ));
            }
        }
        match bounded_read(&self.root.join("manifest.json"), META_LIMIT) {
            Ok(bytes) => {
                let manifest: Manifest = serde_json::from_slice(&bytes)
                    .map_err(|_| recovery_error("文本恢复清单损坏，已保留，不能用空会话覆盖。"))?;
                validate(&manifest.snapshot)?;
                if manifest.hash != manifest_hash(&manifest)?
                    || manifest
                        .snapshot
                        .documents
                        .iter()
                        .any(|doc| doc.text.is_some())
                    || manifest.blobs.len() != manifest.snapshot.documents.len()
                {
                    return Err(recovery_error("文本恢复清单完整性校验失败，已保留。"));
                }
                let mut size = 0;
                for doc in &manifest.snapshot.documents {
                    let blob = manifest
                        .blobs
                        .get(&doc.id)
                        .ok_or_else(|| recovery_error("恢复清单缺少正文引用。"))?;
                    if blob.name != format!("{}.txt", blob.hash)
                        || blob.hash.len() != 64
                        || !blob.hash.bytes().all(|b| b.is_ascii_hexdigit())
                        || blob.bytes > BODY_LIMIT
                        || blob.length != doc.length
                    {
                        return Err(recovery_error("恢复正文引用无效，已保留。"));
                    }
                    size += blob.bytes;
                    self.active.insert(doc.id.clone(), doc.length);
                }
                if size > BODY_LIMIT {
                    return Err(recovery_error("恢复正文单代超过 64 MiB。"));
                }
                self.generation = manifest.snapshot.generation;
                self.manifest = manifest;
            }
            Err(e) if e.code == "missing" => {}
            Err(e) => return Err(e),
        }
        // No body is loaded at startup. A commit confirmation belongs to this WebView's lifecycle.
        Ok(())
    }
    fn metadata_readable(&self) -> Result<()> {
        match &self.blocked {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
    fn writable(&self) -> Result<()> {
        self.metadata_readable()?;
        if let Some(error) = self.body_blocked.values().next() {
            return Err(error.clone());
        }
        Ok(())
    }
    fn persist_grants(&mut self) -> Result<()> {
        self.writable()?;
        let grants = Grants {
            schema: 1,
            records: self.grants.clone(),
            hash: version(&json(&self.grants)?),
        };
        let bytes = json(&grants)?;
        if bytes.len() > META_LIMIT {
            return Err(recovery_error("文本授权记录超过安全上限。"));
        }
        self.reserve(bytes.len() as u64)?;
        if self.grants_quarantine {
            // Quarantine stays in this same bounded directory, is never GC'ed,
            // and contributes its entire size to the 128 MiB hard limit.
            let source = self.root.join("grants.json");
            let target = self.root.join(format!("grants-corrupt-{}.json", nonce()));
            if source.exists() {
                fs::rename(&source, &target)?;
            }
            self.grants_quarantine = false;
        }
        atomic_metadata(&self.root.join("grants.json"), &bytes)
    }
    fn disk_usage(&self) -> Result<u64> {
        let mut total = 0u64;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if !metadata.is_file() {
                return Err(recovery_error(
                    "恢复目录包含未知目录，已保留，无法安全计算配额。",
                ));
            }
            total = total
                .checked_add(metadata.len())
                .ok_or_else(|| recovery_error("恢复配额溢出。"))?;
        }
        Ok(total)
    }
    fn reserve(&self, additional: u64) -> Result<()> {
        if self.disk_usage()?.saturating_add(additional) > DISK_LIMIT {
            return Err(recovery_error(
                "本机恢复数据达到 128 MiB 配额，请重试清理或关闭不再需要的草稿；有效草稿已保留。",
            ));
        }
        Ok(())
    }
    pub fn invalidate(&mut self, generation: u64) {
        if generation >= self.generation {
            self.session_changed = true;
            self.generation = generation;
            self.confirmed = None;
        }
    }
    pub fn lifecycle_ready(&self) -> Result<()> {
        // A damaged journal is retained untouched. If this WebView never accepted
        // new text state, it has no text buffers to lose and must not trap notes/clipboard.
        if (self.blocked.is_some() || !self.body_blocked.is_empty()) && !self.session_changed {
            return Ok(());
        }
        self.writable()?;
        if self
            .confirmed
            .as_ref()
            .is_some_and(|(generation, _)| *generation == self.generation)
        {
            Ok(())
        } else {
            Err(recovery_error(
                "最新文本草稿尚未完整暂存，请重试后再隐藏或退出。",
            ))
        }
    }
    pub fn profile_status(&self) -> Result<ProfileTextStatus> {
        Ok(ProfileTextStatus {
            generation: self.generation,
            confirmed_generation: self.confirmed.as_ref().map(|(generation, _)| *generation),
            lifecycle_ready: self.lifecycle_ready().is_ok(),
            documents: self.active.len(),
            disk_bytes: self.disk_usage()?,
            resident_body_bytes: 0,
            window_visible: None,
            idle_pending: false,
        })
    }
    pub fn note_owner(&self, path: &Path) -> Result<Option<String>> {
        let canonical = text_files::ordinary_path(path, true)?;
        let identity = text_files::identity(&canonical)?;
        Ok(self
            .active
            .keys()
            .find(|id| {
                self.grants.get(*id).is_some_and(|grant| {
                    text_files::path_key(&grant.path) == text_files::path_key(&canonical)
                        || grant.identity == identity
                })
            })
            .cloned())
    }
    fn owning_note(&self, path: &Path, identity: &Identity) -> Option<String> {
        self.notes
            .iter()
            .find(|owner| {
                owner.identity == *identity
                    || text_files::path_key(&owner.path) == text_files::path_key(path)
            })
            .map(|owner| owner.relative.clone())
    }
    pub fn sync_notes(&mut self, paths: Vec<(PathBuf, String)>) -> Result<()> {
        if paths.len() > 2 {
            return Err(Fault::new("session", "笔记最多保留两个会话。"));
        }
        let mut next = Vec::new();
        for (path, relative) in paths {
            if self.note_owner(&path)?.is_some() {
                return Err(Fault::new("text-owned", "该文件已在文本编辑中打开。"));
            }
            next.push(NoteOwner {
                identity: text_files::identity(&path)?,
                path,
                relative,
            });
        }
        self.notes = next;
        Ok(())
    }
    pub fn remember_note(&mut self, path: PathBuf, relative: String) -> Result<()> {
        if self.note_owner(&path)?.is_some() {
            return Err(Fault::new(
                "text-owned",
                "该文件已在文本编辑中打开，请切换到已有文本标签。",
            ));
        }
        let identity = text_files::identity(&path)?;
        if !self.notes.iter().any(|note| note.identity == identity) {
            self.notes.push(NoteOwner {
                path,
                identity,
                relative,
            });
        }
        Ok(())
    }
    pub fn clear_notes(&mut self) {
        self.notes.clear();
    }
    pub fn notes_moved(&mut self, source: &Path, target: &Path, root: &Path) {
        for note in &mut self.notes {
            if let Ok(suffix) = note.path.strip_prefix(source) {
                note.path = target.join(suffix);
                if let Ok(relative) = note.path.strip_prefix(root) {
                    note.relative = relative.to_string_lossy().replace('\\', "/");
                }
                if let Ok(identity) = text_files::identity(&note.path) {
                    note.identity = identity;
                }
            }
        }
    }
    pub fn notes_recycled(&mut self, path: &Path) {
        self.notes.retain(|note| !note.path.starts_with(path));
    }
    pub fn note_saved(&mut self, path: &Path) {
        if let Ok(identity) = text_files::identity(path) {
            for note in &mut self.notes {
                if text_files::path_key(&note.path) == text_files::path_key(path) {
                    note.identity = identity.clone();
                }
            }
        }
    }
    pub fn protect(&self, path: &Path) -> Result<()> {
        let key = text_files::path_key(path);
        let identity = if path.is_file() {
            text_files::identity(path).ok()
        } else {
            None
        };
        let ids: Vec<&str> = self
            .active
            .keys()
            .filter(|id| {
                self.grants.get(*id).is_some_and(|grant| {
                    let g = text_files::path_key(&grant.path);
                    g == key
                        || g.starts_with(&(key.clone() + "/"))
                        || identity.as_ref() == Some(&grant.identity)
                })
            })
            .map(String::as_str)
            .collect();
        if !ids.is_empty() {
            return Err(Fault::new(
                "text-owned",
                format!("这些文本标签正占用目标，请先切换并关闭：{}", ids.join("、")),
            ));
        }
        Ok(())
    }
    /// 仅接收宿主原生选择对话框、文件拖放或隔离测试提供的路径。
    pub fn open_selected(&mut self, path: &Path) -> Result<std::result::Result<TextFile, String>> {
        self.open_selected_with_encoding(path, None)
    }
    pub fn open_selected_with_encoding(
        &mut self,
        path: &Path,
        encoding: Option<Encoding>,
    ) -> Result<std::result::Result<TextFile, String>> {
        self.writable()?;
        let path = text_files::ordinary_path(path, true)?;
        let identity = text_files::identity(&path)?;
        if let Some(note) = self.owning_note(&path, &identity) {
            return Ok(Err(note));
        }
        let duplicate = self
            .active
            .keys()
            .find(|id| {
                self.grants.get(*id).is_some_and(|g| {
                    g.identity == identity
                        || text_files::path_key(&g.path) == text_files::path_key(&path)
                })
            })
            .cloned();
        if duplicate.is_none() && self.active.len() >= 12 {
            return Err(Fault::new(
                "text-tabs",
                "文本标签已达 12 个，请先关闭一个标签。",
            ));
        }
        let id = duplicate
            .clone()
            .unwrap_or_else(|| format!("text-{}", nonce()));
        // Selecting a hard-link alias activates the existing document and preserves
        // its label/authority; it must not silently migrate a dirty tab's path.
        if let Some(existing) = duplicate.as_ref().and_then(|id| self.grants.get(id)) {
            if existing.identity == identity {
                return Ok(Ok(text_annotations::attach(
                    &self.root,
                    text_files::read_file_with_encoding(
                        &id,
                        &existing.path,
                        Some(&identity),
                        existing.encoding,
                    )?
                    .0,
                )?));
            }
        }
        let (file, identity) =
            text_files::read_file_with_encoding(&id, &path, Some(&identity), encoding)?;
        let file = text_annotations::attach(&self.root, file)?;
        let length = file.text.encode_utf16().count();
        let other: usize = self
            .active
            .iter()
            .filter(|(key, _)| **key != id)
            .map(|(_, length)| *length)
            .sum();
        if other + length > FILE_LIMIT {
            return Err(Fault::new(
                "text-quota",
                "全部文本正文超过 16 Mi UTF-16 代码单元，未打开此文件。",
            ));
        }
        let previous = self.grants.insert(
            id.clone(),
            Grant {
                encoding,
                path,
                identity,
                epoch: nonce(),
            },
        );
        if let Err(error) = self.persist_grants() {
            if let Some(previous) = previous {
                self.grants.insert(id, previous);
            } else {
                self.grants.remove(&id);
            }
            return Err(error);
        }
        self.active.insert(id, length);
        self.session_changed = true;
        self.confirmed = None;
        Ok(Ok(file))
    }
    pub fn read(&self, id: &str) -> Result<TextFile> {
        if !self.active.contains_key(id) {
            return Err(Fault::new("authorization", "该文本会话未授权或已关闭。"));
        }
        let grant = self
            .grants
            .get(id)
            .ok_or_else(|| Fault::new("authorization", "未命名草稿只能从本机恢复读取。"))?;
        text_annotations::attach(
            &self.root,
            text_files::read_file_with_encoding(
                id,
                &grant.path,
                Some(&grant.identity),
                grant.encoding,
            )?
            .0,
        )
    }
    pub fn reopen(&mut self, id: &str, encoding: Encoding) -> Result<TextFile> {
        self.writable()?;
        if !self.active.contains_key(id) {
            return Err(Fault::new("authorization", "该文本会话未授权或已关闭。"));
        }
        let old = self
            .grants
            .get(id)
            .cloned()
            .ok_or_else(|| Fault::new("authorization", "未命名文本不能从磁盘重载。"))?;
        let file = text_files::read_file_with_encoding(
            id,
            &old.path,
            Some(&old.identity),
            Some(encoding),
        )?
        .0;
        let file = text_annotations::attach(&self.root, file)?;
        let length = file.text.encode_utf16().count();
        if self
            .active
            .iter()
            .filter(|(key, _)| key.as_str() != id)
            .map(|(_, n)| *n)
            .sum::<usize>()
            + length
            > FILE_LIMIT
        {
            return Err(Fault::new(
                "text-quota",
                "重载后的全部文本正文超过上限，当前内容已保留。",
            ));
        }
        self.grants.get_mut(id).unwrap().encoding = Some(encoding);
        if let Err(error) = self.persist_grants() {
            self.grants.insert(id.to_owned(), old);
            return Err(error);
        }
        self.active.insert(id.to_owned(), length);
        self.session_changed = true;
        self.confirmed = None;
        Ok(file)
    }
    pub fn probe(&self, id: &str, known_version: &str) -> Result<TextProbeResult> {
        // Always validate authorization, identity and bytes before comparing the
        // version. Status and changed body come from this same single read.
        let file = self.read(id)?;
        if file.version == known_version {
            Ok(TextProbeResult::Unchanged {
                id: file.id,
                version: file.version,
                size: file.size,
                readonly: file.readonly,
            })
        } else {
            Ok(TextProbeResult::Changed { file })
        }
    }
    pub fn read_reply(&self, id: &str, known_version: Option<&str>) -> Result<TextReadReply> {
        match known_version {
            Some(version) => self.probe(id, version).map(TextReadReply::Probed),
            None => self.read(id).map(TextReadReply::Full),
        }
    }
    pub fn save(&mut self, value: TextSave) -> Result<TextFile> {
        self.writable()?;
        if !self.active.contains_key(&value.id) {
            return Err(Fault::new("authorization", "文本会话未授权。"));
        }
        let grant = self
            .grants
            .get(&value.id)
            .cloned()
            .ok_or_else(|| Fault::new("authorization", "请先另存未命名文本。"))?;
        let old = text_files::read_file_with_encoding(
            &value.id,
            &grant.path,
            Some(&grant.identity),
            grant.encoding,
        )?
        .0;
        if old.version != value.version {
            return Err(Fault::new(
                "conflict",
                "磁盘文件已改变，请重载或另存；草稿已保留。",
            ));
        }
        if old.text == value.text && old.encoding == value.encoding && old.eol == value.eol {
            return Ok(old);
        }
        let bytes = text_files::encode(&value.text, value.encoding, value.eol)?;
        if version(&bytes) == old.version {
            // 字节不变时仍记住所选编码，避免 ASCII 内容重读后丢失输出偏好。
            return self.finish_save(value, &grant.path, grant.identity, &bytes);
        }
        let other: usize = self
            .active
            .iter()
            .filter(|(id, _)| **id != value.id)
            .map(|(_, n)| *n)
            .sum();
        if other + value.text.encode_utf16().count() > FILE_LIMIT {
            return Err(Fault::new(
                "text-quota",
                "全部文本正文超过 16 Mi UTF-16 代码单元。",
            ));
        }
        let identity =
            text_files::atomic_write(&grant.path, &bytes, Some((&grant.identity, &value.version)))?;
        self.finish_save(value, &grant.path, identity, &bytes)
    }
    /// The dialog has already confirmed an existing target and captured its identity/version.
    pub fn save_selected(
        &mut self,
        value: TextSave,
        path: &Path,
        baseline: Option<(Identity, String)>,
    ) -> Result<TextFile> {
        self.writable()?;
        if !text_files::valid_id(&value.id) {
            return Err(Fault::new("authorization", "文本会话标识无效。"));
        }
        if !self.active.contains_key(&value.id) && self.active.len() >= 12 {
            return Err(Fault::new("text-tabs", "文本标签已达上限。"));
        }
        let path = text_files::ordinary_path(path, baseline.is_some())?;
        if let Some((identity, _)) = &baseline {
            if self.owning_note(&path, identity).is_some() {
                return Err(Fault::new(
                    "note-owned",
                    "另存目标已在笔记模块打开，请先关闭该笔记。",
                ));
            }
        }
        if self.active.keys().any(|id| {
            *id != value.id
                && self.grants.get(id).is_some_and(|g| {
                    text_files::path_key(&g.path) == text_files::path_key(&path)
                        || baseline
                            .as_ref()
                            .is_some_and(|(identity, _)| g.identity == *identity)
                })
        }) {
            return Err(Fault::new("text-owned", "另存目标已被另一文本标签占用。"));
        }
        let length = value.text.encode_utf16().count();
        if self
            .active
            .iter()
            .filter(|(id, _)| **id != value.id)
            .map(|(_, n)| *n)
            .sum::<usize>()
            + length
            > FILE_LIMIT
        {
            return Err(Fault::new(
                "text-quota",
                "全部文本正文超过 16 Mi UTF-16 代码单元。",
            ));
        }
        let bytes = text_files::encode(&value.text, value.encoding, value.eol)?;
        let identity = text_files::atomic_write(
            &path,
            &bytes,
            baseline
                .as_ref()
                .map(|(id, version)| (id, version.as_str())),
        )?;
        self.finish_save(value, &path, identity, &bytes)
    }
    fn finish_save(
        &mut self,
        value: TextSave,
        path: &Path,
        identity: Identity,
        bytes: &[u8],
    ) -> Result<TextFile> {
        let id = value.id;
        self.grants.insert(
            id.clone(),
            Grant {
                encoding: Some(value.encoding),
                path: path.to_path_buf(),
                identity: identity.clone(),
                epoch: nonce(),
            },
        );
        // Once the original file was committed, never report that disk save as a failure.
        if let Err(e) = self.persist_grants() {
            self.grants_dirty = true;
            self.pending_warning = Some(format!("原文件已保存，恢复授权状态未更新：{}", e.message));
        }
        let result = TextFile {
            highlights: Vec::new(),
            id: id.clone(),
            path: text_files::display_path(path),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            text: value.text.replace("\r\n", "\n").replace('\r', "\n"),
            version: version(bytes),
            size: bytes.len() as u64,
            encoding: value.encoding,
            eol: value.eol,
            readonly: fs::metadata(path)
                .map(|m| m.permissions().readonly())
                .unwrap_or(false),
        };
        self.active.insert(id, result.text.encode_utf16().count());
        self.session_changed = true;
        self.confirmed = None;
        Ok(result)
    }
    pub fn restore(&self) -> Result<TextSnapshot> {
        self.metadata_readable()?;
        let mut snapshot = self.manifest.snapshot.clone();
        if let Some(warning) = &self.pending_warning {
            snapshot.warning = Some(warning.clone());
        }
        snapshot.generation = self.generation;
        for doc in &mut snapshot.documents {
            doc.text = None;
            if let Some(grant) = self.grants.get(&doc.id) {
                // A manifest's path never grants access. Replace it with the host-owned label.
                doc.path = Some(text_files::display_path(&grant.path));
                match text_files::identity(&grant.path).and_then(|identity| {
                    if identity == grant.identity {
                        Ok(())
                    } else {
                        Err(Fault::new(
                            "identity",
                            "文件身份已改变，请重新选择授权；本机草稿已保留。",
                        ))
                    }
                }) {
                    Ok(()) => {
                        doc.readonly = fs::metadata(&grant.path)
                            .map(|m| m.permissions().readonly())
                            .unwrap_or(true);
                    }
                    Err(e) => {
                        doc.error = Some(e);
                        doc.readonly = true;
                    }
                }
            } else if doc.path.is_some() {
                doc.error = Some(Fault::new(
                    "authorization",
                    "原文件授权不存在，本机草稿已保留；请另存或重新打开授权。",
                ));
                doc.readonly = true;
            }
            if let Some(error) = self.body_blocked.get(&doc.id) {
                doc.error = Some(error.clone());
            }
        }
        Ok(snapshot)
    }
    pub fn recover(&mut self, id: &str) -> Result<String> {
        // The manifest is trusted even if one referenced body failed earlier.
        // Permit a precise same-document revalidation without replacing any buffer.
        self.metadata_readable()?;
        self.manifest
            .snapshot
            .documents
            .iter()
            .find(|doc| doc.id == id)
            .ok_or_else(|| recovery_error("未找到此文本草稿。"))?;
        match self.recover_blob(id) {
            Ok(text) => {
                self.body_blocked.remove(id);
                Ok(text)
            }
            Err(error) => {
                let error =
                    recovery_error(format!("正文恢复失败，原数据已保留：{}", error.message));
                self.confirmed = None;
                self.body_blocked.insert(id.into(), error.clone());
                Err(error)
            }
        }
    }
    fn recover_blob(&self, id: &str) -> Result<String> {
        let blob = self
            .manifest
            .blobs
            .get(id)
            .ok_or_else(|| recovery_error("恢复正文引用不存在。"))?;
        let bytes = bounded_read(&self.root.join(&blob.name), BODY_LIMIT as usize)?;
        if bytes.len() as u64 != blob.bytes || version(&bytes) != blob.hash {
            return Err(recovery_error(
                "恢复正文完整性校验失败，已保留损坏文件，未替换为空白。",
            ));
        }
        let text = String::from_utf8(bytes)
            .map_err(|_| recovery_error("恢复正文不是有效 UTF-8，已保留。"))?;
        if text.encode_utf16().count() != blob.length || text.contains('\0') {
            return Err(recovery_error("恢复正文长度校验失败，已保留。"));
        }
        Ok(text)
    }
    pub fn checkpoint(&mut self, mut snapshot: TextSnapshot) -> Result<TextCommit> {
        self.writable()?;
        if self.grants_dirty || self.grants_quarantine {
            self.persist_grants().map_err(|e| {
                recovery_error(format!("原文件已保存，恢复授权状态仍未更新：{}", e.message))
            })?;
            self.grants_dirty = false;
        }
        validate(&snapshot)?;
        if snapshot.generation < self.generation {
            return Err(recovery_error("文本恢复提交已过期，请提交最新编辑代次。"));
        }
        self.generation = snapshot.generation;
        self.confirmed = None;
        let mut warnings = Vec::new();
        // Collect orphans before deciding which candidate blobs already exist.
        // An interrupted earlier commit may have left precisely the next draft blob.
        if let Err(error) = self.cleanup() {
            warnings.push(format!("旧恢复数据未清理：{}", error.message));
        }
        let mut blobs = BTreeMap::new();
        let mut writes: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        let mut body_bytes = 0u64;
        for doc in &mut snapshot.documents {
            if let Some(path) = &doc.path {
                if let Some(grant) = self.grants.get(&doc.id) {
                    if text_files::path_key(Path::new(path)) != text_files::path_key(&grant.path) {
                        return Err(Fault::new("authorization", "恢复路径与宿主授权不一致。"));
                    }
                    doc.path = Some(text_files::display_path(&grant.path));
                } else {
                    // An already committed draft may outlive its authorization file.
                    // Its old label is display-only: it never enters the grant table.
                    let old = self
                        .manifest
                        .snapshot
                        .documents
                        .iter()
                        .find(|old| old.id == doc.id)
                        .and_then(|old| old.path.as_ref())
                        .filter(|old| {
                            text_files::path_key(Path::new(old))
                                == text_files::path_key(Path::new(path))
                        })
                        .ok_or_else(|| {
                            Fault::new("authorization", "恢复清单不能新增原文件授权。")
                        })?;
                    doc.path = Some(old.clone());
                    doc.error = Some(Fault::new(
                        "authorization",
                        "原文件授权不存在，草稿继续暂存；请另存或重新打开授权。",
                    ));
                }
            }
            let blob = if let Some(text) = doc.text.take() {
                let bytes = text.into_bytes();
                let hash = version(&bytes);
                let name = format!("{hash}.txt");
                let blob = Blob {
                    name: name.clone(),
                    hash,
                    bytes: bytes.len() as u64,
                    length: doc.length,
                };
                if self.root.join(&name).exists() {
                    let current = bounded_read(&self.root.join(&name), BODY_LIMIT as usize)?;
                    if current != bytes {
                        return Err(recovery_error(
                            "恢复正文同名文件损坏，已保留，请先导出草稿。",
                        ));
                    }
                } else {
                    writes.insert(name, bytes);
                }
                blob
            } else {
                let old = self
                    .manifest
                    .snapshot
                    .documents
                    .iter()
                    .find(|old| old.id == doc.id)
                    .ok_or_else(|| recovery_error("新建草稿必须提交完整正文。"))?;
                if old.revision != doc.revision || old.length != doc.length {
                    return Err(recovery_error("草稿已修改，必须提交该版本完整正文。"));
                }
                // Reused lazy bodies must still be intact before we acknowledge this generation.
                self.recover(&doc.id)?;
                self.manifest
                    .blobs
                    .get(&doc.id)
                    .cloned()
                    .ok_or_else(|| recovery_error("未加载草稿缺少恢复正文。"))?
            };
            body_bytes = body_bytes
                .checked_add(blob.bytes)
                .ok_or_else(|| recovery_error("正文配额溢出。"))?;
            blobs.insert(doc.id.clone(), blob);
        }
        if body_bytes > BODY_LIMIT {
            return Err(recovery_error("恢复正文单代超过 64 MiB。"));
        }
        snapshot.warning = None;
        let mut candidate = Manifest {
            snapshot,
            blobs,
            hash: String::new(),
        };
        candidate.hash = manifest_hash(&candidate)?;
        let metadata = json(&candidate)?;
        if metadata.len() > META_LIMIT {
            return Err(recovery_error("文本恢复清单超过 128 KiB。"));
        }
        let additional =
            writes.values().map(|bytes| bytes.len() as u64).sum::<u64>() + metadata.len() as u64;
        // The old committed generation remains intact on every failure before this point or the metadata switch.
        self.reserve(additional)?;
        for (name, bytes) in writes {
            let mut temp = tempfile::Builder::new()
                .prefix(".text-body-")
                .tempfile_in(&self.root)?;
            temp.write_all(&bytes)?;
            temp.as_file().sync_all()?;
            temp.persist_noclobber(self.root.join(name))
                .map_err(|e| Fault::from(e.error))?;
        }
        atomic_metadata(&self.root.join("manifest.json"), &metadata)?;
        self.active = candidate
            .snapshot
            .documents
            .iter()
            .map(|doc| (doc.id.clone(), doc.length))
            .collect();
        self.manifest = candidate;
        self.persist_annotations()?;
        let token = nonce();
        self.confirmed = Some((self.generation, token.clone()));
        if let Some(warning) = self.pending_warning.take() {
            warnings.push(warning);
        }
        // The new generation is valid even when collection of old files fails.
        if let Err(error) = self.cleanup() {
            warnings.push(format!("草稿已暂存，旧恢复数据清理失败：{}", error.message));
        }
        Ok(TextCommit {
            generation: self.generation,
            token,
            warning: if warnings.is_empty() {
                None
            } else {
                Some(warnings.join(" "))
            },
        })
    }
    fn persist_annotations(&self) -> Result<()> {
        if !self.root.join("annotations.json").exists()
            && !self
                .manifest
                .snapshot
                .documents
                .iter()
                .any(|doc| doc.revision == doc.saved_revision && !doc.highlights.is_empty())
        {
            return Ok(());
        }
        let mut index = text_annotations::load(&self.root)?;
        let original = index.entries.clone();
        for doc in &self.manifest.snapshot.documents {
            // 未保存正文的范围只随草稿恢复，不能覆盖磁盘版本的标注。
            if doc.revision != doc.saved_revision {
                continue;
            }
            let Some(grant) = self.grants.get(&doc.id) else {
                continue;
            };
            let key = text_annotations::key(&grant.path);
            if doc.highlights.is_empty() {
                index.entries.remove(&key);
            } else if let Some(blob) = self.manifest.blobs.get(&doc.id) {
                index.entries.insert(
                    key,
                    text_annotations::Entry {
                        body: blob.hash.clone(),
                        length: doc.length,
                        highlights: doc.highlights.clone(),
                    },
                );
            }
        }
        if index.entries == original {
            return Ok(());
        }
        let bytes = text_annotations::encoded(index)?;
        self.reserve(bytes.len() as u64)?;
        atomic_metadata(&self.root.join("annotations.json"), &bytes)
    }
    fn cleanup(&self) -> Result<()> {
        let keep: HashSet<&str> = self
            .manifest
            .blobs
            .values()
            .map(|blob| blob.name.as_str())
            .collect();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == "manifest.json" || name == "grants.json" || keep.contains(name.as_str()) {
                continue;
            }
            // Unknown/corrupt data is never discarded. Only our well-formed old blobs and temp files qualify.
            let blob = name.strip_suffix(".txt").is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
            });
            if blob || name.starts_with(".text-body-") || name.starts_with(".text-meta-") {
                fs::remove_file(entry.path())?;
            }
        }
        Ok(())
    }
    pub fn close(&mut self, id: &str) -> Result<()> {
        self.writable()?;
        let mut candidate = self.manifest.clone();
        candidate.snapshot.documents.retain(|doc| doc.id != id);
        candidate.snapshot.views.retain(|view| view != id);
        if candidate.snapshot.views.is_empty() {
            if let Some(doc) = candidate.snapshot.documents.first() {
                candidate.snapshot.views.push(doc.id.clone());
            }
        }
        candidate.snapshot.active = candidate
            .snapshot
            .active
            .min(candidate.snapshot.views.len().saturating_sub(1));
        candidate.blobs.remove(id);
        candidate.hash = manifest_hash(&candidate)?;
        let bytes = json(&candidate)?;
        self.reserve(bytes.len() as u64)?;
        atomic_metadata(&self.root.join("manifest.json"), &bytes)?;
        self.manifest = candidate;
        self.active.remove(id);
        self.grants.remove(id);
        self.confirmed = None;
        if let Err(error) = self.persist_grants() {
            self.pending_warning = Some(format!("标签已关闭，旧授权清理失败：{}", error.message));
        }
        if let Err(error) = self.cleanup() {
            self.pending_warning = Some(format!("标签已关闭，旧正文清理失败：{}", error.message));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: &str, text: &str) -> TextRecord {
        TextRecord {
            highlights: Vec::new(),
            id: id.into(),
            path: None,
            name: "未命名".into(),
            text: Some(text.into()),
            length: text.encode_utf16().count(),
            version: String::new(),
            encoding: Encoding::Utf8,
            eol: Eol::Crlf,
            revision: 1,
            saved_revision: 0,
            cursor: 0,
            anchor: 0,
            scroll: 0.,
            language: "plain".into(),
            tab_size: 4,
            indent_with_tabs: false,
            wrap: false,
            readonly: false,
            error: None,
        }
    }
    fn snapshot(generation: u64, docs: Vec<TextRecord>) -> TextSnapshot {
        TextSnapshot {
            schema: 1,
            generation,
            views: docs.first().map(|d| vec![d.id.clone()]).unwrap_or_default(),
            documents: docs,
            active: 0,
            warning: None,
        }
    }
    #[test]
    fn annotations_persist_without_changing_file_bytes_and_ignore_external_edits() {
        let data = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("marked.txt");
        let bytes = text_files::encode("中文😀abcdef\n", Encoding::Utf8Bom, Eol::Crlf).unwrap();
        fs::write(&path, &bytes).unwrap();
        let identity = text_files::identity(&path).unwrap();
        let mut store = TextStore::load(data.path());
        let file = store.open_selected(&path).unwrap().unwrap();
        let mark = Highlight {
            from: 2,
            to: 4,
            color: text_annotations::Color::Yellow,
        };
        let mut doc = record(&file.id, &file.text);
        doc.path = Some(file.path);
        doc.version = file.version;
        doc.saved_revision = doc.revision;
        doc.highlights = vec![mark.clone()];
        store.checkpoint(snapshot(1, vec![doc.clone()])).unwrap();
        assert_eq!(fs::read(&path).unwrap(), bytes);
        assert_eq!(text_files::identity(&path).unwrap(), identity);
        store.close(&file.id).unwrap();
        let mut recovered = TextStore::load(data.path());
        let reopened = recovered.open_selected(&path).unwrap().unwrap();
        assert_eq!(reopened.highlights, vec![mark.clone()]);
        let mut dirty = record(&reopened.id, "modified body");
        dirty.path = Some(reopened.path.clone());
        dirty.highlights = vec![Highlight {
            from: 0,
            to: 8,
            color: text_annotations::Color::Pink,
        }];
        recovered.checkpoint(snapshot(2, vec![dirty])).unwrap();
        recovered.close(&reopened.id).unwrap();
        let reopened = recovered.open_selected(&path).unwrap().unwrap();
        assert_eq!(reopened.highlights, vec![mark]);
        fs::write(&path, "different text").unwrap();
        assert!(recovered.read(&reopened.id).unwrap().highlights.is_empty());
        let mut clean = record(&reopened.id, "different text");
        clean.path = Some(reopened.path);
        clean.saved_revision = clean.revision;
        recovered.checkpoint(snapshot(3, vec![clean])).unwrap();
        assert!(text_annotations::load(&recovered.root)
            .unwrap()
            .entries
            .is_empty());
    }

    #[test]
    fn annotation_index_failure_keeps_committed_draft_and_blocks_confirmation() {
        let data = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("a.txt");
        fs::write(&path, b"content").unwrap();
        let mut store = TextStore::load(data.path());
        let file = store.open_selected(&path).unwrap().unwrap();
        let mut doc = record(&file.id, &file.text);
        doc.path = Some(file.path);
        doc.saved_revision = doc.revision;
        doc.highlights = vec![Highlight {
            from: 0,
            to: 4,
            color: text_annotations::Color::Blue,
        }];
        fs::write(store.root.join("annotations.json"), b"broken").unwrap();
        assert!(store.checkpoint(snapshot(1, vec![doc])).is_err());
        assert!(store.confirmed.is_none());
        assert_eq!(store.recover(&file.id).unwrap(), "content");
        assert_eq!(store.restore().unwrap().documents[0].highlights.len(), 1);
        assert_eq!(fs::read(&path).unwrap(), b"content");
        assert_eq!(
            fs::read(store.root.join("annotations.json")).unwrap(),
            b"broken"
        );
    }

    #[test]
    fn conditional_read_preserves_legacy_wire_and_reports_live_unchanged_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("probe.txt");
        fs::write(&path, "中文😀\r\n").unwrap();
        let mut store = TextStore::load(dir.path());
        let file = store.open_selected(&path).unwrap().unwrap();
        let legacy = serde_json::to_value(store.read_reply(&file.id, None).unwrap()).unwrap();
        assert_eq!(legacy["id"], file.id);
        assert_eq!(legacy["text"], "中文😀\n");
        assert_eq!(legacy["version"], file.version);
        assert!(legacy.get("kind").is_none());
        assert!(legacy.get("file").is_none());
        let unchanged =
            serde_json::to_value(store.read_reply(&file.id, Some(&file.version)).unwrap()).unwrap();
        assert_eq!(
            unchanged,
            serde_json::json!({"kind":"unchanged","id":file.id,"version":file.version,"size":file.size,"readonly":false})
        );
        let original = fs::metadata(&path).unwrap().permissions();
        let mut readonly = original.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&path, readonly).unwrap();
        let reply = store.read_reply(&file.id, Some(&file.version));
        fs::set_permissions(&path, original).unwrap();
        let readonly_status = serde_json::to_value(reply.unwrap()).unwrap();
        assert_eq!(readonly_status["version"], file.version);
        assert_eq!(readonly_status["readonly"], true);
        assert_eq!(readonly_status["size"], file.size);
        assert!(readonly_status.get("text").is_none());
        assert!(readonly_status.get("file").is_none());
    }
    #[test]
    fn conditional_read_returns_changed_body_and_still_rejects_invalid_encoding() {
        let dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("probe.txt");
        fs::write(&path, b"original").unwrap();
        let mut store = TextStore::load(dir.path());
        let file = store.open_selected(&path).unwrap().unwrap();
        fs::write(&path, b"changed\r\n").unwrap();
        let changed =
            serde_json::to_value(store.read_reply(&file.id, Some(&file.version)).unwrap()).unwrap();
        assert_eq!(changed["kind"], "changed");
        assert_eq!(changed["file"]["id"], file.id);
        assert_eq!(changed["file"]["text"], "changed\n");
        assert_eq!(changed["file"]["version"], version(b"changed\r\n"));
        assert_eq!(changed["file"]["size"], 9);
        assert_eq!(changed["file"]["encoding"], "utf8");
        assert_eq!(changed["file"]["eol"], "crlf");
        fs::write(&path, [0xef, 0xbb, 0xbf, 0xff]).unwrap();
        assert_eq!(
            store.probe(&file.id, &file.version).unwrap_err().code,
            "encoding"
        );
    }
    #[test]
    fn known_version_never_bypasses_identity_missing_or_closed_authorization_checks() {
        let dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("probe.txt");
        fs::write(&path, b"same bytes").unwrap();
        let mut store = TextStore::load(dir.path());
        let file = store.open_selected(&path).unwrap().unwrap();
        assert_eq!(
            store.probe("forged", &file.version).unwrap_err().code,
            "authorization"
        );
        // Keep the old file alive so the replacement cannot reuse its identity.
        fs::rename(&path, files.path().join("retained-original.txt")).unwrap();
        fs::write(&path, b"same bytes").unwrap();
        assert_eq!(
            store.probe(&file.id, &file.version).unwrap_err().code,
            "identity"
        );
        let reauthorized = store.open_selected(&path).unwrap().unwrap();
        assert_eq!(reauthorized.id, file.id);
        assert!(matches!(
            store.probe(&file.id, &file.version).unwrap(),
            TextProbeResult::Unchanged { .. }
        ));
        fs::remove_file(&path).unwrap();
        assert_eq!(
            store.probe(&file.id, &file.version).unwrap_err().code,
            "missing"
        );
        store.close(&file.id).unwrap();
        assert_eq!(
            store.probe(&file.id, &file.version).unwrap_err().code,
            "authorization"
        );
    }
    #[test]
    fn lazy_recovery_and_lifecycle_generations() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TextStore::load(dir.path());
        assert!(store.lifecycle_ready().is_err());
        let commit = store
            .checkpoint(snapshot(1, vec![record("draft", "中文😀\n")]))
            .unwrap();
        assert_eq!(commit.generation, 1);
        store.lifecycle_ready().unwrap();
        let mut restored = TextStore::load(dir.path());
        assert!(restored.restore().unwrap().documents[0].text.is_none());
        assert_eq!(restored.recover("draft").unwrap(), "中文😀\n");
        store.invalidate(2);
        assert!(store.lifecycle_ready().is_err());
        assert!(store
            .checkpoint(snapshot(1, vec![record("draft", "old")]))
            .is_err());
        assert_eq!(store.recover("draft").unwrap(), "中文😀\n");
        let mut lazy = store.restore().unwrap();
        lazy.generation = 2;
        store.checkpoint(lazy).unwrap();
        store.lifecycle_ready().unwrap();
    }
    #[test]
    fn snapshot_path_never_authorizes_and_close_does_not_resurrect() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TextStore::load(dir.path());
        let mut forged = record("forged", "secret");
        forged.path = Some("C:/Windows/win.ini".into());
        assert_eq!(
            store
                .checkpoint(snapshot(1, vec![forged]))
                .err()
                .unwrap()
                .code,
            "authorization"
        );
        assert!(store.read("forged").is_err());
        store
            .checkpoint(snapshot(2, vec![record("draft", "keep")]))
            .unwrap();
        store.close("draft").unwrap();
        let mut restored = TextStore::load(dir.path());
        assert!(restored.restore().unwrap().documents.is_empty());
        assert!(restored.recover("draft").is_err());
    }
    #[test]
    fn corruption_retains_last_commit_and_original_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TextStore::load(dir.path());
        store
            .checkpoint(snapshot(1, vec![record("a", "valuable")]))
            .unwrap();
        let blob = store.manifest.blobs["a"].name.clone();
        fs::write(store.root.join(&blob), b"broken").unwrap();
        assert!(store.recover("a").is_err());
        assert_eq!(
            store.restore().unwrap().documents[0]
                .error
                .as_ref()
                .unwrap()
                .code,
            "text-recovery"
        );
        // Referenced corrupted data is retained and never treated as an empty draft.
        assert_eq!(fs::read(store.root.join(blob)).unwrap(), b"broken");
        fs::write(store.root.join("manifest.json"), b"broken manifest").unwrap();
        let mut broken = TextStore::load(dir.path());
        assert!(broken.restore().is_err());
        assert!(broken.checkpoint(TextSnapshot::default()).is_err());
        assert_eq!(
            fs::read(broken.root.join("manifest.json")).unwrap(),
            b"broken manifest"
        );
    }
    #[test]
    fn quota_precommit_preserves_previous_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TextStore::load(dir.path());
        store
            .checkpoint(snapshot(1, vec![record("a", "old")]))
            .unwrap();
        let previous = fs::read(store.root.join("manifest.json")).unwrap();
        let unknown = fs::File::create(store.root.join("retained-diagnostic.bin")).unwrap();
        unknown.set_len(DISK_LIMIT - 1024).unwrap();
        assert!(store
            .checkpoint(snapshot(2, vec![record("a", &"new".repeat(1000))]))
            .is_err());
        assert_eq!(
            fs::read(store.root.join("manifest.json")).unwrap(),
            previous
        );
        assert_eq!(store.recover("a").unwrap(), "old");
    }
    #[test]
    fn grants_persist_identity_and_note_alias_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("a.md");
        fs::write(&path, b"same").unwrap();
        let alias = files.path().join("alias.md");
        fs::hard_link(&path, &alias).unwrap();
        let mut store = TextStore::load(dir.path());
        store.remember_note(path.clone(), "a.md".into()).unwrap();
        assert_eq!(store.open_selected(&alias).unwrap().unwrap_err(), "a.md");
        store.clear_notes();
        let file = store.open_selected(&path).unwrap().unwrap();
        let duplicate = store.open_selected(&alias).unwrap().unwrap();
        assert_eq!(file.id, duplicate.id);
        assert_eq!(store.note_owner(&path).unwrap(), Some(file.id.clone()));
        assert!(store.protect(files.path()).is_err());
        let mut doc = record(&file.id, &file.text);
        doc.path = Some(file.path.clone());
        doc.version = file.version.clone();
        store.checkpoint(snapshot(1, vec![doc])).unwrap();
        let mut reloaded = TextStore::load(dir.path());
        assert_eq!(reloaded.read(&file.id).unwrap().text, "same");
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"other").unwrap();
        assert_eq!(reloaded.read(&file.id).unwrap_err().code, "identity");
        assert_eq!(reloaded.recover(&file.id).unwrap(), "same");
    }
    #[test]
    fn explicit_encoding_survives_reload_save_and_recovery() {
        let dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("legacy.txt");
        fs::write(&path, [0xc2, 0xa3]).unwrap();
        let mut store = TextStore::load(dir.path());
        let file = store.open_selected(&path).unwrap().unwrap();
        assert_eq!(file.text, "£");
        let reopened = store.reopen(&file.id, Encoding::Windows1252).unwrap();
        assert_eq!(reopened.text, "Â£");
        assert_eq!(fs::read(&path).unwrap(), [0xc2, 0xa3]);
        assert_eq!(
            store.read(&file.id).unwrap().encoding,
            Encoding::Windows1252
        );
        assert_eq!(
            store.reopen(&file.id, Encoding::Ascii).unwrap_err().code,
            "encoding"
        );
        assert_eq!(store.read(&file.id).unwrap().text, "Â£");
        let saved = store
            .save(TextSave {
                id: file.id.clone(),
                text: "plain ASCII".into(),
                version: file.version,
                encoding: Encoding::Windows1252,
                eol: Eol::Lf,
            })
            .unwrap();
        assert_eq!(
            store.read(&file.id).unwrap().encoding,
            Encoding::Windows1252
        );
        let mut doc = record(&file.id, &saved.text);
        doc.path = Some(saved.path);
        doc.version = saved.version;
        doc.encoding = saved.encoding;
        store.checkpoint(snapshot(1, vec![doc])).unwrap();
        let mut recovered = TextStore::load(dir.path());
        assert_eq!(
            recovered.restore().unwrap().documents[0].encoding,
            Encoding::Windows1252
        );
        assert_eq!(
            recovered.read(&file.id).unwrap().encoding,
            Encoding::Windows1252
        );
        assert_eq!(recovered.recover(&file.id).unwrap(), "plain ASCII");
        fs::write(&path, [0xe9]).unwrap();
        let changed = recovered.probe(&file.id, "old").unwrap();
        match changed {
            TextProbeResult::Changed { file } => assert_eq!(file.text, "é"),
            _ => panic!("应返回外部修改后的正文"),
        };
        recovered.close(&file.id).unwrap();
        assert_eq!(
            recovered.reopen(&file.id, Encoding::Gbk).unwrap_err().code,
            "authorization"
        );
    }

    #[test]
    fn legacy_save_loss_preserves_original_and_explicit_open_handles_short_text() {
        let dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("gbk.txt");
        let bytes = [0xd6, 0xd0, 0xce, 0xc4];
        fs::write(&path, bytes).unwrap();
        let mut store = TextStore::load(dir.path());
        let file = store
            .open_selected_with_encoding(&path, Some(Encoding::Gbk))
            .unwrap()
            .unwrap();
        assert_eq!(file.text, "中文");
        let value = TextSave {
            id: file.id.clone(),
            text: "中文😀".into(),
            version: file.version,
            encoding: Encoding::Gbk,
            eol: Eol::Lf,
        };
        assert_eq!(store.save(value.clone()).unwrap_err().code, "encoding-loss");
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let saved = store
            .save(TextSave {
                encoding: Encoding::Gb18030,
                ..value
            })
            .unwrap();
        assert_eq!(saved.text, "中文😀");
        assert_eq!(store.read(&file.id).unwrap().text, "中文😀");
        let mut doc = record(&file.id, &saved.text);
        doc.path = Some(saved.path);
        doc.version = saved.version;
        doc.encoding = saved.encoding;
        store.checkpoint(snapshot(1, vec![doc])).unwrap();
        assert_eq!(
            TextStore::load(dir.path()).read(&file.id).unwrap().encoding,
            Encoding::Gb18030
        );
    }

    #[test]
    fn encoding_only_change_with_identical_bytes_is_remembered_without_replacing_file() {
        let dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("ascii.txt");
        fs::write(&path, b"ASCII").unwrap();
        let mut store = TextStore::load(dir.path());
        let file = store.open_selected(&path).unwrap().unwrap();
        let identity = text_files::identity(&path).unwrap();
        store
            .save(TextSave {
                id: file.id.clone(),
                text: file.text,
                version: file.version,
                encoding: Encoding::Gbk,
                eol: Eol::Lf,
            })
            .unwrap();
        assert_eq!(text_files::identity(&path).unwrap(), identity);
        assert_eq!(store.read(&file.id).unwrap().encoding, Encoding::Gbk);
    }

    #[test]
    fn save_noop_mixed_lines_and_exact_output() {
        let dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("mixed");
        fs::write(&path, b"a\r\nb\n").unwrap();
        let mut store = TextStore::load(dir.path());
        let file = store.open_selected(&path).unwrap().unwrap();
        let id = text_files::identity(&path).unwrap();
        let value = TextSave {
            id: file.id.clone(),
            text: file.text.clone(),
            version: file.version.clone(),
            encoding: file.encoding,
            eol: file.eol,
        };
        store.save(value.clone()).unwrap();
        assert_eq!(text_files::identity(&path).unwrap(), id);
        let mut edit = value;
        edit.text.push('x');
        assert_eq!(store.save(edit.clone()).unwrap_err().code, "eol");
        edit.eol = Eol::Crlf;
        edit.encoding = Encoding::Utf16Be;
        let saved = store.save(edit).unwrap();
        assert_eq!(saved.encoding, Encoding::Utf16Be);
        assert_eq!(&fs::read(&path).unwrap()[..2], &[0xfe, 0xff]);
    }
    #[test]
    fn premanifest_failure_keeps_previous_generation_and_close_failure_keeps_reference() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mut store = TextStore::load(dir.path());
        store
            .checkpoint(snapshot(1, vec![record("a", "retained")]))
            .unwrap();
        let previous = fs::read(store.root.join("manifest.json")).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(store.root.join("manifest.json"))
            .unwrap();
        assert!(store
            .checkpoint(snapshot(2, vec![record("a", "next generation")]))
            .is_err());
        assert!(store.close("a").is_err());
        assert_eq!(store.recover("a").unwrap(), "retained");
        assert!(store.lifecycle_ready().is_err());
        drop(lock);
        assert_eq!(
            fs::read(store.root.join("manifest.json")).unwrap(),
            previous
        );
        store
            .checkpoint(snapshot(2, vec![record("a", "next generation")]))
            .unwrap();
        assert_eq!(store.recover("a").unwrap(), "next generation");
    }
    #[test]
    fn cleanup_failure_does_not_revoke_successful_commit() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let mut store = TextStore::load(dir.path());
        store
            .checkpoint(snapshot(1, vec![record("a", "old")]))
            .unwrap();
        let old = store.root.join(&store.manifest.blobs["a"].name);
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&old)
            .unwrap();
        let commit = store
            .checkpoint(snapshot(2, vec![record("a", "new")]))
            .unwrap();
        assert!(commit.warning.is_some());
        store.lifecycle_ready().unwrap();
        assert_eq!(store.recover("a").unwrap(), "new");
        assert!(old.exists());
        drop(lock);
        let mut lazy = store.restore().unwrap();
        lazy.generation = 3;
        store.checkpoint(lazy).unwrap();
        assert!(!old.exists());
    }
    #[test]
    fn save_as_checks_confirmation_baseline_and_session_ownership() {
        let dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let target = files.path().join("target.txt");
        fs::write(&target, b"external").unwrap();
        let mut store = TextStore::load(dir.path());
        let identity = text_files::identity(&target).unwrap();
        let baseline = version(b"external");
        let value = TextSave {
            id: "untitled".into(),
            text: "中文😀\n".into(),
            version: String::new(),
            encoding: Encoding::Utf8Bom,
            eol: Eol::Lf,
        };
        fs::write(&target, b"changed after confirmation").unwrap();
        assert_eq!(
            store
                .save_selected(value.clone(), &target, Some((identity, baseline)))
                .unwrap_err()
                .code,
            "conflict"
        );
        assert_eq!(fs::read(&target).unwrap(), b"changed after confirmation");
        let identity = text_files::identity(&target).unwrap();
        let baseline = version(&fs::read(&target).unwrap());
        let saved = store
            .save_selected(value.clone(), &target, Some((identity, baseline)))
            .unwrap();
        assert_eq!(saved.id, "untitled");
        assert_eq!(
            fs::read(&target).unwrap(),
            b"\xef\xbb\xbf\xe4\xb8\xad\xe6\x96\x87\xf0\x9f\x98\x80\n"
        );
        let other = TextSave {
            id: "other".into(),
            ..value
        };
        let identity = text_files::identity(&target).unwrap();
        assert_eq!(
            store
                .save_selected(other, &target, Some((identity, saved.version)))
                .unwrap_err()
                .code,
            "text-owned"
        );
    }
    #[test]
    fn corrupt_recovery_does_not_trap_other_modules_without_new_text() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("text-recovery")).unwrap();
        fs::write(dir.path().join("text-recovery/manifest.json"), b"damaged").unwrap();
        let mut store = TextStore::load(dir.path());
        assert!(store.restore().is_err());
        store.lifecycle_ready().unwrap();
        store.invalidate(1);
        assert!(store.lifecycle_ready().is_err());
        assert_eq!(
            fs::read(store.root.join("manifest.json")).unwrap(),
            b"damaged"
        );
    }
    #[test]
    fn missing_authorization_preserves_lazy_draft_but_cannot_read_original() {
        let dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("file.txt");
        fs::write(&path, b"original").unwrap();
        let mut store = TextStore::load(dir.path());
        let file = store.open_selected(&path).unwrap().unwrap();
        let mut doc = record(&file.id, "local draft");
        doc.path = Some(file.path);
        doc.version = file.version;
        store.checkpoint(snapshot(1, vec![doc])).unwrap();
        fs::remove_file(store.root.join("grants.json")).unwrap();
        let mut restored = TextStore::load(dir.path());
        assert_eq!(restored.recover(&file.id).unwrap(), "local draft");
        assert_eq!(restored.read(&file.id).unwrap_err().code, "authorization");
        assert_eq!(
            restored
                .probe(&file.id, "untrusted-known-version")
                .unwrap_err()
                .code,
            "authorization"
        );
        assert_eq!(
            restored.restore().unwrap().documents[0]
                .error
                .as_ref()
                .unwrap()
                .code,
            "authorization"
        );
        assert_eq!(fs::read(&path).unwrap(), b"original");
        let mut state = restored.restore().unwrap();
        state.generation = 2;
        state.documents[0].text = Some("continued local draft".into());
        state.documents[0].length = "continued local draft".encode_utf16().count();
        state.documents[0].revision += 1;
        restored.invalidate(2);
        restored.checkpoint(state).unwrap();
        restored.lifecycle_ready().unwrap();
        let mut restarted = TextStore::load(dir.path());
        assert_eq!(
            restarted.recover(&file.id).unwrap(),
            "continued local draft"
        );
        assert_eq!(restarted.read(&file.id).unwrap_err().code, "authorization");
    }
    #[test]
    fn interrupted_close_retains_a_surviving_visible_document() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TextStore::load(dir.path());
        store
            .checkpoint(snapshot(
                1,
                vec![record("a", "one"), record("b", "two"), record("c", "three")],
            ))
            .unwrap();
        store.close("a").unwrap();
        let mut restored = TextStore::load(dir.path());
        let state = restored.restore().unwrap();
        validate(&state).unwrap();
        assert_eq!(state.views, vec!["b"]);
        assert_eq!(state.documents.len(), 2);
        assert_eq!(restored.recover("b").unwrap(), "two");
        assert_eq!(restored.recover("c").unwrap(), "three");
    }
    #[test]
    fn damaged_body_preserves_pristine_notes_lifecycle_but_new_input_blocks_it() {
        for missing in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let mut store = TextStore::load(dir.path());
            store
                .checkpoint(snapshot(1, vec![record("a", "saved draft")]))
                .unwrap();
            let body = store.root.join(&store.manifest.blobs["a"].name);
            if missing {
                fs::remove_file(body).unwrap();
            } else {
                fs::write(body, b"damaged").unwrap();
            }
            let mut restored = TextStore::load(dir.path());
            assert_eq!(restored.restore().unwrap().documents.len(), 1);
            assert!(restored.recover("a").is_err());
            restored.lifecycle_ready().unwrap();
            restored.invalidate(2);
            assert!(restored.lifecycle_ready().is_err());
            assert!(restored
                .checkpoint(snapshot(2, vec![record("a", "replacement")]))
                .is_err());
        }
    }
    #[test]
    fn malformed_grants_quarantine_preserves_recovery_and_counts_toward_quota() {
        let dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("original.txt");
        fs::write(&path, b"original").unwrap();
        let mut store = TextStore::load(dir.path());
        let file = store.open_selected(&path).unwrap().unwrap();
        let mut doc = record(&file.id, "valuable draft");
        doc.path = Some(file.path);
        doc.version = file.version;
        store.checkpoint(snapshot(1, vec![doc])).unwrap();
        let bad = b"corrupted authorization bytes preserved verbatim";
        fs::write(store.root.join("grants.json"), bad).unwrap();
        let mut restored = TextStore::load(dir.path());
        let mut state = restored.restore().unwrap();
        assert!(state.warning.is_some());
        assert_eq!(restored.recover(&file.id).unwrap(), "valuable draft");
        assert_eq!(restored.read(&file.id).unwrap_err().code, "authorization");
        state.generation = 2;
        restored.checkpoint(state).unwrap();
        restored.lifecycle_ready().unwrap();
        let isolated: Vec<_> = fs::read_dir(&restored.root)
            .unwrap()
            .map(|e| e.unwrap())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("grants-corrupt-")
            })
            .collect();
        assert_eq!(isolated.len(), 1);
        assert_eq!(fs::read(isolated[0].path()).unwrap(), bad);
        let total: u64 = fs::read_dir(&restored.root)
            .unwrap()
            .map(|e| e.unwrap().metadata().unwrap().len())
            .sum();
        assert_eq!(restored.disk_usage().unwrap(), total);
        assert!(total >= bad.len() as u64);
        let mut restarted = TextStore::load(dir.path());
        assert_eq!(restarted.recover(&file.id).unwrap(), "valuable draft");
        assert_eq!(restarted.read(&file.id).unwrap_err().code, "authorization");
        assert_eq!(fs::read(path).unwrap(), b"original");
    }
    #[test]
    fn tampered_grant_hash_revokes_only_authority_and_allows_explicit_save_as() {
        let dir = tempfile::tempdir().unwrap();
        let files = tempfile::tempdir().unwrap();
        let path = files.path().join("original.txt");
        fs::write(&path, b"original").unwrap();
        let mut store = TextStore::load(dir.path());
        let file = store.open_selected(&path).unwrap().unwrap();
        let mut doc = record(&file.id, "recover me");
        doc.path = Some(file.path);
        doc.version = file.version;
        store.checkpoint(snapshot(1, vec![doc])).unwrap();
        let mut grants: serde_json::Value =
            serde_json::from_slice(&fs::read(store.root.join("grants.json")).unwrap()).unwrap();
        grants["hash"] = serde_json::json!("tampered");
        let corrupted = serde_json::to_vec(&grants).unwrap();
        fs::write(store.root.join("grants.json"), &corrupted).unwrap();
        let mut restored = TextStore::load(dir.path());
        assert_eq!(restored.recover(&file.id).unwrap(), "recover me");
        assert_eq!(restored.read(&file.id).unwrap_err().code, "authorization");
        let copy = files.path().join("copy.txt");
        let saved = restored
            .save_selected(
                TextSave {
                    id: file.id.clone(),
                    text: "recover me".into(),
                    version: String::new(),
                    encoding: Encoding::Utf8,
                    eol: Eol::Lf,
                },
                &copy,
                None,
            )
            .unwrap();
        assert_eq!(
            saved.path,
            text_files::display_path(&text_files::ordinary_path(&copy, true).unwrap())
        );
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(fs::read(&copy).unwrap(), b"recover me");
        let quarantined = fs::read_dir(&restored.root)
            .unwrap()
            .map(|e| e.unwrap())
            .find(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("grants-corrupt-")
            })
            .unwrap();
        assert_eq!(fs::read(quarantined.path()).unwrap(), corrupted);
        let mut state = restored.restore().unwrap();
        state.documents[0].path = Some(saved.path);
        state.documents[0].version = saved.version;
        state.generation = 2;
        restored.checkpoint(state).unwrap();
        restored.lifecycle_ready().unwrap();
        assert_eq!(restored.read(&file.id).unwrap().text, "recover me");
    }
    #[test]
    fn repaired_known_body_can_retry_without_discarding_newer_in_memory_draft() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TextStore::load(dir.path());
        store
            .checkpoint(snapshot(
                1,
                vec![record("a", "old A"), record("b", "old B")],
            ))
            .unwrap();
        let body = store.root.join(&store.manifest.blobs["b"].name);
        let original = fs::read(&body).unwrap();
        let mut live = TextStore::load(dir.path());
        let mut state = live.restore().unwrap();
        assert_eq!(live.recover("a").unwrap(), "old A");
        live.invalidate(2);
        state.generation = 2;
        let a = &mut state.documents[0];
        a.text = Some("latest A input".into());
        a.length = "latest A input".len();
        a.revision += 1;
        fs::write(&body, b"broken B").unwrap();
        assert!(live.recover("b").is_err());
        assert!(live.lifecycle_ready().is_err());
        assert!(live.checkpoint(state.clone()).is_err());
        fs::write(&body, original).unwrap();
        assert_eq!(live.recover("b").unwrap(), "old B");
        assert!(live.lifecycle_ready().is_err());
        live.checkpoint(state).unwrap();
        live.lifecycle_ready().unwrap();
        assert_eq!(live.recover("a").unwrap(), "latest A input");
        assert_eq!(live.recover("b").unwrap(), "old B");
    }
    #[test]
    fn repairing_one_body_does_not_clear_another_body_or_metadata_failure() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TextStore::load(dir.path());
        store
            .checkpoint(snapshot(1, vec![record("a", "A"), record("b", "B")]))
            .unwrap();
        let a = store.root.join(&store.manifest.blobs["a"].name);
        let b = store.root.join(&store.manifest.blobs["b"].name);
        fs::remove_file(&a).unwrap();
        fs::remove_file(&b).unwrap();
        let mut live = TextStore::load(dir.path());
        live.invalidate(2);
        assert!(live.recover("a").is_err());
        assert!(live.recover("b").is_err());
        fs::write(&a, b"A").unwrap();
        assert_eq!(live.recover("a").unwrap(), "A");
        assert!(live.lifecycle_ready().is_err());
        assert!(live
            .checkpoint(snapshot(2, vec![record("a", "A"), record("b", "new")]))
            .is_err());
        fs::write(&b, b"B").unwrap();
        assert_eq!(live.recover("b").unwrap(), "B");
        let mut state = live.restore().unwrap();
        state.generation = 2;
        live.checkpoint(state).unwrap();
        live.lifecycle_ready().unwrap();
        fs::write(live.root.join("manifest.json"), b"broken metadata").unwrap();
        let mut broken = TextStore::load(dir.path());
        assert!(broken.recover("a").is_err());
        assert!(broken.checkpoint(TextSnapshot::default()).is_err());
        assert_eq!(
            fs::read(broken.root.join("manifest.json")).unwrap(),
            b"broken metadata"
        );
    }
}
