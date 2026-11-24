use crate::files::{movable_kind, version, Entry, Fault, Result, Workspace};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const LIMIT: usize = 1024 * 1024;
static REVISION: AtomicU64 = AtomicU64::new(1);
type Parents = BTreeMap<String, Vec<String>>;

#[derive(Clone, Debug, Serialize)]
pub struct FolderOrder {
    pub root: String,
    pub revision: String,
    pub parents: Parents,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Placement {
    Before,
    After,
    Inside,
    Reset,
}

#[derive(Debug, Deserialize)]
pub struct FolderAction {
    pub root: String,
    pub revision: String,
    pub source: String,
    pub parent: String,
    pub anchor: Option<String>,
    pub placement: Placement,
}

#[derive(Debug, Serialize)]
pub struct FolderResult {
    pub path: String,
    pub moved: bool,
    pub order: FolderOrder,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    root: String,
    parents: Parents,
}

struct Cached {
    key: String,
    path: PathBuf,
    order: FolderOrder,
    baseline: Option<String>,
    blocked: bool,
    pending: bool,
}

#[derive(Default)]
pub struct FolderStore {
    current: Option<Cached>,
}

fn next_revision() -> String {
    REVISION.fetch_add(1, Ordering::Relaxed).to_string()
}
fn root_label(ws: &Workspace) -> String {
    ws.root.to_string_lossy().trim_start_matches(r"\\?\").into()
}
fn root_key(ws: &Workspace) -> String {
    root_label(ws).replace('\\', "/").to_lowercase()
}
fn same(a: &str, b: &str) -> bool {
    a.to_lowercase() == b.to_lowercase()
}
fn under(path: &str, prefix: &str) -> bool {
    let path = path.to_lowercase();
    let prefix = prefix.to_lowercase();
    path == prefix || path.starts_with(&(prefix + "/"))
}
fn parent(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(p, _)| p)
}
fn canonical_relative(path: &str, allow_root: bool) -> bool {
    (allow_root && path.is_empty())
        || (!path.is_empty()
            && !path.contains('\\')
            && path
                .split('/')
                .all(|name| crate::files::validate_name(name).is_ok()))
}
fn validate_record(record: &Record, key: &str) -> Result<()> {
    let mut keys = HashSet::new();
    if record.version != 1 || record.root != key {
        return Err(Fault::new("order", "列表顺序记录版本或笔记库标识不匹配。"));
    }
    for (path, children) in &record.parents {
        let mut seen = HashSet::new();
        if !canonical_relative(path, true) || !keys.insert(path.to_lowercase()) {
            return Err(Fault::new("order", "列表顺序记录含无效或重复的父目录。"));
        }
        for child in children {
            if !canonical_relative(child, false)
                || !same(parent(child), path)
                || !seen.insert(child.to_lowercase())
            {
                return Err(Fault::new("order", "列表顺序记录含无效或重复的项目。"));
            }
        }
    }
    Ok(())
}
fn read_bytes(path: &Path) -> Result<Option<Vec<u8>>> {
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    if file.metadata()?.len() > LIMIT as u64 {
        return Err(Fault::new(
            "order",
            "列表顺序记录超过 1 MiB，已保留原记录。",
        ));
    }
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > LIMIT {
        return Err(Fault::new(
            "order",
            "列表顺序记录超过 1 MiB，已保留原记录。",
        ));
    }
    Ok(Some(bytes))
}
fn load(path: &Path, key: &str) -> Result<(Parents, Option<String>)> {
    let Some(bytes) = read_bytes(path)? else {
        return Ok((Parents::new(), None));
    };
    let record: Record = serde_json::from_slice(&bytes)
        .map_err(|_| Fault::new("order", "列表顺序记录损坏，已保留原记录。"))?;
    validate_record(&record, key)?;
    Ok((record.parents, Some(version(&bytes))))
}

fn merge(saved: Option<&Vec<String>>, entries: &[Entry]) -> Vec<String> {
    let mut result = Vec::new();
    // Old records contain folders only. Each actual kind gets its own stable order,
    // so newly added notes never interleave with the folders in those records.
    for kind in ["folder", "note"] {
        let actual: Vec<_> = entries.iter().filter(|entry| entry.kind == kind).collect();
        let mut available: HashMap<_, _> = actual
            .iter()
            .map(|entry| (entry.path.to_lowercase(), *entry))
            .collect();
        for old in saved.into_iter().flatten() {
            if let Some(entry) = available.remove(&old.to_lowercase()) {
                result.push(entry.path.clone());
            }
        }
        result.extend(actual.into_iter().filter_map(|entry| {
            available
                .remove(&entry.path.to_lowercase())
                .map(|_| entry.path.clone())
        }));
    }
    result
}
fn saved_for<'a>(parents: &'a Parents, path: &str) -> Option<&'a Vec<String>> {
    parents
        .iter()
        .find(|(p, _)| same(p, path))
        .map(|(_, value)| value)
}
fn set_parent(parents: &mut Parents, path: &str, order: Option<Vec<String>>) {
    parents.retain(|p, _| !same(p, path));
    if let Some(order) = order {
        parents.insert(path.into(), order);
    }
}
fn remove_tree(parents: &mut Parents, path: &str) {
    parents.retain(|p, _| !under(p, path));
    for children in parents.values_mut() {
        children.retain(|child| !under(child, path));
    }
}
fn remap(parents: &Parents, old: &str, new: &str) -> Parents {
    let map = |path: &str| {
        if under(path, old) {
            let suffix = path
                .split('/')
                .skip(old.split('/').count())
                .collect::<Vec<_>>()
                .join("/");
            if suffix.is_empty() {
                new.into()
            } else {
                format!("{new}/{suffix}")
            }
        } else {
            path.into()
        }
    };
    parents
        .iter()
        .map(|(p, children)| (map(p), children.iter().map(|c| map(c)).collect()))
        .collect()
}

impl Cached {
    fn persist(&mut self, parents: &Parents) -> Result<()> {
        if self.blocked {
            return Err(Fault::new(
                "order",
                "原顺序记录不可读取或已损坏；请先修复或移走该记录，再重试。",
            ));
        }
        let record = Record {
            version: 1,
            root: self.key.clone(),
            parents: parents.clone(),
        };
        validate_record(&record, &self.key)?;
        let bytes = serde_json::to_vec(&record).map_err(|e| Fault::new("order", e.to_string()))?;
        if bytes.len() > LIMIT {
            return Err(Fault::new(
                "order",
                "本次顺序记录超过 1 MiB，未保存且未截断原记录。",
            ));
        }
        let directory = self.path.parent().unwrap();
        fs::create_dir_all(directory)?;
        let mut temp = tempfile::Builder::new()
            .prefix(".shiye-order-")
            .tempfile_in(directory)?;
        temp.write_all(&bytes)?;
        temp.as_file().sync_all()?;
        // Do not replace an externally changed, newly damaged, or unreadable record.
        if read_bytes(&self.path)?.as_ref().map(|b| version(b)) != self.baseline {
            return Err(Fault::new(
                "stale",
                "磁盘中的列表顺序记录已改变，请重新打开笔记库后再操作。",
            ));
        }
        temp.persist(&self.path).map_err(|e| Fault::from(e.error))?;
        self.baseline = Some(version(&bytes));
        Ok(())
    }
    fn commit(&mut self, parents: Parents, disk_changed: bool) -> Result<()> {
        if parents == self.order.parents && !disk_changed {
            return Ok(());
        }
        let result = self.persist(&parents);
        if let Err(error) = &result {
            if !disk_changed {
                return Err(error.clone());
            }
            self.order.warning = Some(format!(
                "磁盘操作已完成，但列表顺序未保存：{} 可重试保存顺序。",
                error.message
            ));
            self.pending = true;
        } else {
            self.order.warning = None;
            self.pending = false;
        }
        self.order.parents = parents;
        self.order.revision = next_revision();
        Ok(())
    }
}

impl FolderStore {
    pub fn clear(&mut self) {
        self.current = None;
    }
    fn current(&mut self, ws: &Workspace, data: &Path) -> &mut Cached {
        let key = root_key(ws);
        if self.current.as_ref().is_none_or(|cached| cached.key != key) {
            let path = data
                .join("tree-order")
                .join(format!("{}.json", version(key.as_bytes())));
            let loaded = load(&path, &key);
            let blocked = loaded.is_err();
            let warning = loaded
                .as_ref()
                .err()
                .map(|e| format!("{} 暂用默认顺序，不会覆盖原记录。", e.message));
            let (parents, baseline) = loaded.unwrap_or_default();
            self.current = Some(Cached {
                key,
                path,
                baseline,
                blocked,
                pending: false,
                order: FolderOrder {
                    root: root_label(ws),
                    revision: next_revision(),
                    parents,
                    warning,
                },
            });
        }
        self.current.as_mut().unwrap()
    }
    pub fn snapshot(&mut self, ws: &Workspace, data: &Path) -> FolderOrder {
        self.current(ws, data).order.clone()
    }
    pub fn check_root(ws: &Workspace, expected: &str) -> Result<()> {
        let expected = Workspace::new(Path::new(expected))
            .map_err(|_| Fault::new("workspace", "笔记库已改变，请刷新后重试。"))?;
        if root_key(ws) != root_key(&expected) {
            return Err(Fault::new(
                "workspace",
                "笔记库已改变，已取消旧工作区的操作。",
            ));
        }
        Ok(())
    }
    pub fn retry(&mut self, ws: &Workspace, data: &Path, root: &str) -> Result<FolderOrder> {
        Self::check_root(ws, root)?;
        let cached = self.current(ws, data);
        if cached.blocked {
            let (disk_parents, baseline) = load(&cached.path, &cached.key)?;
            cached.blocked = false;
            cached.baseline = baseline;
            if !cached.pending {
                cached.order.parents = disk_parents;
                cached.order.warning = None;
                cached.order.revision = next_revision();
                return Ok(cached.order.clone());
            }
            // A repaired nonempty record may contain other changes. Do not silently replace it.
            if !disk_parents.is_empty() && disk_parents != cached.order.parents {
                cached.blocked = true;
                return Err(Fault::new(
                    "stale",
                    "修复后的顺序记录与待保存顺序不同，请重新打开笔记库。",
                ));
            }
        }
        let parents = cached.order.parents.clone();
        cached.persist(&parents)?;
        cached.pending = false;
        cached.order.warning = None;
        Ok(cached.order.clone())
    }
    /// Reconcile only the parent whose complete listing has succeeded.
    pub fn listed(&mut self, ws: &Workspace, data: &Path, path: &str, entries: &[Entry]) {
        let cached = self.current(ws, data);
        let Some(saved) = saved_for(&cached.order.parents, path) else {
            return;
        };
        let actual: HashSet<_> = entries.iter().map(|e| e.path.to_lowercase()).collect();
        let missing: Vec<_> = saved
            .iter()
            .filter(|p| !actual.contains(&p.to_lowercase()))
            .cloned()
            .collect();
        let merged = merge(Some(saved), entries);
        let mut next = cached.order.parents.clone();
        for child in missing {
            remove_tree(&mut next, &child);
        }
        set_parent(&mut next, path, Some(merged));
        if next != cached.order.parents {
            let _ = cached.commit(next, true);
        }
    }
    pub fn renamed(&mut self, ws: &Workspace, data: &Path, old: &str, new: &str) {
        let cached = self.current(ws, data);
        let mut original = cached.order.parents.clone();
        if !same(old, new) {
            remove_tree(&mut original, new);
        }
        let next = remap(&original, old, new);
        if next != cached.order.parents {
            let _ = cached.commit(next, true);
        }
    }
    pub fn recycled(&mut self, ws: &Workspace, data: &Path, path: &str) {
        let cached = self.current(ws, data);
        let mut next = cached.order.parents.clone();
        remove_tree(&mut next, path);
        if next != cached.order.parents {
            let _ = cached.commit(next, true);
        }
    }
    pub fn arrange(
        &mut self,
        ws: &Workspace,
        data: &Path,
        action: FolderAction,
    ) -> Result<FolderResult> {
        Self::check_root(ws, &action.root)?;
        let cached = self.current(ws, data);
        if cached.order.revision != action.revision {
            return Err(Fault::new("stale", "列表顺序已改变，请刷新后重试。"));
        }
        let parent_full = ws.resolve(&action.parent)?;
        if !parent_full.is_dir() {
            return Err(Fault::new("directory", "目标不是文件夹。"));
        }
        let target_parent = ws.rel(&parent_full);
        if matches!(action.placement, Placement::Reset) {
            if !action.source.is_empty() || action.anchor.is_some() {
                return Err(Fault::new("order", "恢复排序参数无效。"));
            }
            let mut next = cached.order.parents.clone();
            set_parent(&mut next, &target_parent, None);
            cached.commit(next, false)?;
            return Ok(FolderResult {
                path: target_parent,
                moved: false,
                warning: cached.order.warning.clone(),
                order: cached.order.clone(),
            });
        }
        let source_full = ws.resolve(&action.source)?;
        if source_full == ws.root {
            return Err(Fault::new("boundary", "不能移动笔记根目录。"));
        }
        let source_kind = movable_kind(&source_full)?;
        let source = ws.rel(&source_full);
        if parent_full.starts_with(&source_full) {
            return Err(Fault::new("boundary", "不能将文件夹移入自身或后代。"));
        }
        let moving = source_full.parent() != Some(parent_full.as_path());
        let anchor = match action.placement {
            Placement::Before | Placement::After => {
                let path = action
                    .anchor
                    .as_deref()
                    .ok_or_else(|| Fault::new("order", "插入位置缺少目标项目。"))?;
                let full = ws.resolve(path)?;
                if movable_kind(&full).ok() != Some(source_kind)
                    || full.parent() != Some(parent_full.as_path())
                {
                    return Err(Fault::new(
                        "order",
                        "插入目标必须是同级的同类项目，请重新选择位置。",
                    ));
                }
                Some(ws.rel(&full))
            }
            _ => {
                if action.anchor.is_some() {
                    return Err(Fault::new("order", "移入目录不能指定插入锚点。"));
                }
                None
            }
        };
        let mut path = source.clone();
        if !moving
            && (matches!(action.placement, Placement::Inside)
                || anchor.as_ref().is_some_and(|a| same(a, &source)))
        {
            return Ok(FolderResult {
                path,
                moved: false,
                warning: cached.order.warning.clone(),
                order: cached.order.clone(),
            });
        }
        let entries = ws.list(&target_parent)?;
        let previous = merge(saved_for(&cached.order.parents, &target_parent), &entries);
        let mut siblings = previous.clone();
        siblings.retain(|p| !same(p, &source));
        if moving {
            path = ws.rel(&parent_full.join(source_full.file_name().unwrap()));
        }
        let position = if let Some(anchor) = &anchor {
            let index = siblings
                .iter()
                .position(|p| same(p, anchor))
                .ok_or_else(|| Fault::new("order", "插入目标已消失，请重新选择位置。"))?;
            index + usize::from(matches!(action.placement, Placement::After))
        } else if source_kind == "folder" {
            let notes: HashSet<_> = entries
                .iter()
                .filter(|entry| entry.kind == "note")
                .map(|entry| entry.path.to_lowercase())
                .collect();
            siblings
                .iter()
                .position(|path| notes.contains(&path.to_lowercase()))
                .unwrap_or(siblings.len())
        } else {
            siblings.len()
        };
        siblings.insert(position, path.clone());
        if !moving && previous == siblings {
            return Ok(FolderResult {
                path,
                moved: false,
                warning: cached.order.warning.clone(),
                order: cached.order.clone(),
            });
        }
        let mut next = cached.order.parents.clone();
        if moving {
            remove_tree(&mut next, &path);
            next = remap(&next, &source, &path);
            // Remapping a child into a new parent must not leave it in its old sibling list.
            if let Some((_, old_siblings)) = next.iter_mut().find(|(p, _)| same(p, parent(&source)))
            {
                old_siblings.retain(|p| !same(p, &path));
            }
        }
        set_parent(&mut next, &target_parent, Some(siblings));
        if moving {
            ws.move_folder(&source, &target_parent, anchor.as_deref())?;
        }
        cached.commit(next, moving)?;
        Ok(FolderResult {
            path,
            moved: moving,
            warning: cached.order.warning.clone(),
            order: cached.order.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _root: tempfile::TempDir,
        data: tempfile::TempDir,
        ws: Workspace,
        store: FolderStore,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let ws = Workspace::new(root.path()).unwrap();
            for name in ["A", "B", "C"] {
                ws.create("", name, true).unwrap();
            }
            Self {
                _root: root,
                data: tempfile::tempdir().unwrap(),
                ws,
                store: FolderStore::default(),
            }
        }
        fn order(&mut self) -> FolderOrder {
            self.store.snapshot(&self.ws, self.data.path())
        }
        fn action(
            &mut self,
            source: &str,
            parent: &str,
            anchor: Option<&str>,
            placement: Placement,
        ) -> FolderAction {
            let order = self.order();
            FolderAction {
                root: order.root,
                revision: order.revision,
                source: source.into(),
                parent: parent.into(),
                anchor: anchor.map(str::to_owned),
                placement,
            }
        }
        fn apply(
            &mut self,
            source: &str,
            parent: &str,
            anchor: Option<&str>,
            placement: Placement,
        ) -> Result<FolderResult> {
            let action = self.action(source, parent, anchor, placement);
            self.store.arrange(&self.ws, self.data.path(), action)
        }
        fn record(&mut self) -> PathBuf {
            self.store.current(&self.ws, self.data.path()).path.clone()
        }
    }

    #[test]
    fn sorting_is_durable_isolated_and_reset_preserves_descendants() {
        let mut f = Fixture::new();
        f.ws.create("C", "x", true).unwrap();
        f.ws.create("C", "y", true).unwrap();
        f.apply("C/y", "C", Some("C/x"), Placement::Before).unwrap();
        let result = f.apply("C", "", Some("A"), Placement::Before).unwrap();
        assert!(!result.moved);
        assert_eq!(result.order.parents[""], ["C", "A", "B"]);
        let record = f.record();
        assert!(!f.ws.root.join("tree-order").exists());
        f.store.clear();
        assert_eq!(f.order().parents[""], ["C", "A", "B"]);
        let other = tempfile::tempdir().unwrap();
        let other_ws = Workspace::new(other.path()).unwrap();
        assert!(f
            .store
            .snapshot(&other_ws, f.data.path())
            .parents
            .is_empty());
        assert_eq!(f.order().parents[""], ["C", "A", "B"]);
        let reset = f.apply("", "", None, Placement::Reset).unwrap();
        assert!(!reset.order.parents.contains_key(""));
        assert_eq!(reset.order.parents["C"], ["C/y", "C/x"]);
        assert!(record.exists());
        assert_eq!(
            f.ws.list("")
                .unwrap()
                .iter()
                .map(|e| e.name.as_str())
                .collect::<Vec<_>>(),
            ["A", "B", "C"]
        );
    }

    #[test]
    fn no_op_revalidation_and_stale_revision_do_not_write() {
        let mut f = Fixture::new();
        let original = f.order();
        let stale = f.action("C", "", Some("A"), Placement::Before);
        let noop = f.apply("A", "", Some("B"), Placement::Before).unwrap();
        assert_eq!(noop.order.revision, original.revision);
        assert!(!f.record().exists());
        f.apply("C", "", Some("A"), Placement::Before).unwrap();
        assert_eq!(
            f.store
                .arrange(&f.ws, f.data.path(), stale)
                .unwrap_err()
                .code,
            "stale"
        );
        let wrong_root = tempfile::tempdir().unwrap();
        let mut action = f.action("A", "B", None, Placement::Inside);
        action.root = wrong_root.path().to_string_lossy().into();
        assert_eq!(
            f.store
                .arrange(&f.ws, f.data.path(), action)
                .unwrap_err()
                .code,
            "workspace"
        );
        assert_eq!(
            f.apply("A", "B", Some("C"), Placement::Before)
                .unwrap_err()
                .code,
            "order"
        );
        assert_eq!(
            f.apply("A", "", Some("missing"), Placement::After)
                .unwrap_err()
                .code,
            "missing"
        );
        assert!(f.ws.resolve("A").is_ok());
    }

    #[test]
    fn move_preserves_all_bytes_and_maps_parent_and_descendant_order() {
        let mut f = Fixture::new();
        f.ws.create("A", "x", true).unwrap();
        f.ws.create("A", "y", true).unwrap();
        fs::write(
            f.ws.resolve("A").unwrap().join("payload.bin"),
            [0, 255, 13, 10],
        )
        .unwrap();
        fs::write(
            f.ws.resolve("A/x").unwrap().join("中文.md"),
            b"\xef\xbb\xbfline\r\n",
        )
        .unwrap();
        f.apply("A/y", "A", Some("A/x"), Placement::Before).unwrap();
        f.apply("C", "", Some("A"), Placement::Before).unwrap();
        let moved = f.apply("A", "B", None, Placement::Inside).unwrap();
        assert!(moved.moved);
        assert_eq!(moved.path, "B/A");
        assert_eq!(moved.order.parents[""], ["C", "B"]);
        assert_eq!(moved.order.parents["B"], ["B/A"]);
        assert_eq!(moved.order.parents["B/A"], ["B/A/y", "B/A/x"]);
        assert_eq!(
            fs::read(f.ws.resolve("B/A").unwrap().join("payload.bin")).unwrap(),
            [0, 255, 13, 10]
        );
        assert_eq!(
            fs::read(f.ws.resolve("B/A/x/中文.md").unwrap()).unwrap(),
            b"\xef\xbb\xbfline\r\n"
        );
        assert!(f.ws.resolve("A").is_err());
        let back = f.apply("B/A", "", Some("C"), Placement::After).unwrap();
        assert_eq!(back.order.parents[""], ["C", "A", "B"]);
        assert_eq!(back.order.parents["A"], ["A/y", "A/x"]);
        assert!(back.warning.is_none());
        f.store.clear();
        assert_eq!(f.order().parents, back.order.parents);
    }

    #[test]
    fn invalid_move_and_case_insensitive_self_checks_preserve_original() {
        let mut f = Fixture::new();
        f.ws.create("A", "inner", true).unwrap();
        f.ws.create("B", "A", true).unwrap();
        for (source, target) in [
            ("", "B"),
            (".", "B"),
            ("A", "a"),
            ("A", "a/inner"),
            ("../outside", "B"),
        ] {
            assert!(
                f.apply(source, target, None, Placement::Inside).is_err(),
                "{source} -> {target}"
            );
        }
        assert!(f.apply("A", "B", None, Placement::Inside).is_err());
        assert!(f.ws.resolve("A/inner").is_ok());
        assert!(f.order().parents.is_empty());
        fs::write(f.ws.root.join("attachment.txt"), b"attachment").unwrap();
        assert_eq!(
            f.apply("attachment.txt", "B", None, Placement::Inside)
                .unwrap_err()
                .code,
            "type"
        );
    }

    #[test]
    fn rename_keeps_position_only_for_custom_order_and_recycle_cleans_subtree() {
        let mut f = Fixture::new();
        f.ws.create("A", "x", true).unwrap();
        f.ws.create("A", "y", true).unwrap();
        f.apply("A/y", "A", Some("A/x"), Placement::Before).unwrap();
        f.apply("C", "", Some("A"), Placement::Before).unwrap();
        let renamed = f.ws.rename("A", "Z").unwrap();
        f.store.renamed(&f.ws, f.data.path(), "A", &renamed);
        let order = f.order();
        assert_eq!(order.parents[""], ["C", "Z", "B"]);
        assert_eq!(order.parents["Z"], ["Z/y", "Z/x"]);
        f.apply("", "", None, Placement::Reset).unwrap();
        let renamed = f.ws.rename("Z", "D").unwrap();
        f.store.renamed(&f.ws, f.data.path(), "Z", &renamed);
        assert!(!f.order().parents.contains_key(""));
        f.store.recycled(&f.ws, f.data.path(), "D");
        assert!(f.order().parents.is_empty());
    }

    #[test]
    fn successful_listing_prunes_only_that_parent_and_new_items_append() {
        let mut f = Fixture::new();
        f.apply("C", "", Some("A"), Placement::Before).unwrap();
        f.ws.create("", "AA", true).unwrap();
        f.ws.create("", "AB", true).unwrap();
        let entries = f.ws.list("").unwrap();
        assert_eq!(
            merge(saved_for(&f.order().parents, ""), &entries),
            ["C", "A", "B", "AA", "AB"]
        );
        fs::rename(f.ws.resolve("A").unwrap(), f.ws.root.join("Z")).unwrap();
        // A failed read never supplies a listing to the store and cannot erase preference state.
        let original = f.order().parents;
        assert!(f.ws.list("A").is_err());
        assert_eq!(f.order().parents, original);
        f.store.listed(&f.ws, f.data.path(), "B", &[]);
        assert_eq!(f.order().parents, original);
        let entries = f.ws.list("").unwrap();
        f.store.listed(&f.ws, f.data.path(), "", &entries);
        assert_eq!(f.order().parents[""], ["C", "B", "AA", "AB", "Z"]);
        assert_eq!(
            merge(saved_for(&f.order().parents, ""), &entries),
            ["C", "B", "AA", "AB", "Z"]
        );
        // Previously observed additions are stable; later additions append after those.
        f.ws.create("", "EarlierName", true).unwrap();
        let entries = f.ws.list("").unwrap();
        f.store.listed(&f.ws, f.data.path(), "", &entries);
        assert_eq!(
            f.order().parents[""],
            ["C", "B", "AA", "AB", "Z", "EarlierName"]
        );
    }

    #[test]
    fn pure_sort_write_failure_rolls_back_but_move_is_pending_and_retryable() {
        let mut f = Fixture::new();
        f.apply("C", "", Some("A"), Placement::Before).unwrap();
        let record = f.record();
        let bytes = fs::read(&record).unwrap();
        let original = f.order();
        let permissions = fs::metadata(&record).unwrap().permissions();
        let mut readonly = permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&record, readonly).unwrap();
        assert!(f.apply("A", "", Some("C"), Placement::Before).is_err());
        assert_eq!(f.order().parents, original.parents);
        assert_eq!(f.order().revision, original.revision);
        assert_eq!(fs::read(&record).unwrap(), bytes);
        let moved = f.apply("A", "B", None, Placement::Inside).unwrap();
        assert!(moved.moved);
        assert!(moved.warning.is_some());
        assert!(f.ws.resolve("B/A").is_ok());
        assert!(f.ws.resolve("A").is_err());
        assert_eq!(f.order().parents, moved.order.parents);
        assert_eq!(fs::read(&record).unwrap(), bytes);
        fs::set_permissions(&record, permissions).unwrap();
        let retried = f
            .store
            .retry(&f.ws, f.data.path(), &moved.order.root)
            .unwrap();
        assert!(retried.warning.is_none());
        f.store.clear();
        assert_eq!(f.order().parents, retried.parents);
    }

    #[test]
    fn damaged_or_oversized_records_cannot_be_overwritten_by_defaults() {
        let mut f = Fixture::new();
        let record = f.record();
        fs::create_dir_all(record.parent().unwrap()).unwrap();
        for bytes in [b"{broken".to_vec(), vec![b' '; LIMIT + 1]] {
            fs::write(&record, &bytes).unwrap();
            f.store.clear();
            let order = f.order();
            assert!(order.warning.is_some());
            assert!(order.parents.is_empty());
            assert_eq!(
                f.apply("C", "", Some("A"), Placement::Before)
                    .unwrap_err()
                    .code,
                "order"
            );
            assert_eq!(fs::read(&record).unwrap(), bytes);
        }
        let moved = f.apply("A", "B", None, Placement::Inside).unwrap();
        assert!(moved.warning.is_some());
        assert!(moved.moved);
        fs::remove_file(&record).unwrap();
        let retried = f
            .store
            .retry(&f.ws, f.data.path(), &moved.order.root)
            .unwrap();
        assert!(retried.warning.is_none());
        assert_eq!(retried.parents["B"], ["B/A"]);
    }

    #[test]
    fn large_valid_record_and_save_limit_keep_original_bytes() {
        let mut f = Fixture::new();
        let children: Vec<String> = (0..7000)
            .map(|i| format!("目录{i:05}-{}", "x".repeat(110)))
            .collect();
        let parents = BTreeMap::from([(String::new(), children)]);
        let cached = f.store.current(&f.ws, f.data.path());
        cached.commit(parents.clone(), false).unwrap();
        let record = f.record();
        let original = fs::read(&record).unwrap();
        assert!(original.len() > 800_000 && original.len() < LIMIT);
        f.store.clear();
        assert_eq!(f.order().parents, parents);
        let mut over = parents;
        over.get_mut("")
            .unwrap()
            .extend((7000..9000).map(|i| format!("目录{i:05}-{}", "x".repeat(110))));
        assert_eq!(
            f.store
                .current(&f.ws, f.data.path())
                .commit(over, false)
                .unwrap_err()
                .code,
            "order"
        );
        assert_eq!(fs::read(&record).unwrap(), original);
        assert_eq!(f.order().parents[""].len(), 7000);
    }

    #[test]
    fn external_record_change_and_invalid_paths_are_rejected() {
        let mut f = Fixture::new();
        f.apply("C", "", Some("A"), Placement::Before).unwrap();
        let record = f.record();
        fs::write(&record, b"external change").unwrap();
        assert_eq!(
            f.apply("A", "", Some("C"), Placement::Before)
                .unwrap_err()
                .code,
            "stale"
        );
        assert_eq!(fs::read(&record).unwrap(), b"external change");
        for (p, children) in [
            ("", vec!["A", "a"]),
            ("", vec!["../A"]),
            ("", vec!["A/x"]),
            ("A", vec!["B/x"]),
            ("../A", vec![]),
            ("", vec!["CON"]),
        ] {
            let record = Record {
                version: 1,
                root: root_key(&f.ws),
                parents: BTreeMap::from([(
                    p.into(),
                    children.into_iter().map(str::to_owned).collect(),
                )]),
            };
            assert!(validate_record(&record, &root_key(&f.ws)).is_err());
        }
        let case_map = BTreeMap::from([("K/x".into(), vec!["K/x/child".into()])]);
        assert_eq!(
            remap(&case_map, "K", "新目录")["新目录/x"],
            ["新目录/x/child"]
        );
    }

    #[test]
    fn rename_and_recycle_keep_disk_result_when_preference_write_fails() {
        let mut f = Fixture::new();
        f.ws.create("A", "x", true).unwrap();
        f.ws.create("A", "y", true).unwrap();
        f.apply("A/y", "A", Some("A/x"), Placement::Before).unwrap();
        f.apply("C", "", Some("A"), Placement::Before).unwrap();
        let path = f.record();
        let original = fs::read(&path).unwrap();
        let writable = fs::metadata(&path).unwrap().permissions();
        let mut readonly = writable.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&path, readonly).unwrap();
        let new = f.ws.rename("A", "new").unwrap();
        f.store.renamed(&f.ws, f.data.path(), "A", &new);
        let order = f.order();
        assert!(order.warning.is_some());
        assert_eq!(order.parents[""], ["C", "new", "B"]);
        assert_eq!(order.parents["new"], ["new/y", "new/x"]);
        assert!(f.ws.resolve("A").is_err());
        assert!(f.ws.resolve("new/x").is_ok());
        // The real recycle command invokes this hook only after trash::delete succeeds.
        f.store.recycled(&f.ws, f.data.path(), "new");
        assert_eq!(f.order().parents[""], ["C", "B"]);
        assert!(!f.order().parents.contains_key("new"));
        assert!(f.order().warning.is_some());
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::set_permissions(&path, writable).unwrap();
        assert!(f
            .store
            .retry(&f.ws, f.data.path(), &order.root)
            .unwrap()
            .warning
            .is_none());
    }

    #[test]
    fn leaving_and_reopening_workspace_rejects_old_action_even_with_same_record() {
        let mut f = Fixture::new();
        let action = f.action("C", "", Some("A"), Placement::Before);
        f.store.clear();
        assert_eq!(
            f.store
                .arrange(&f.ws, f.data.path(), action)
                .unwrap_err()
                .code,
            "stale"
        );
        assert!(f.order().parents.is_empty());
    }

    #[test]
    fn legacy_folder_order_merges_notes_and_keeps_each_kind_in_its_own_group() {
        let mut f = Fixture::new();
        f.apply("C", "", Some("A"), Placement::Before).unwrap();
        let legacy = fs::read(f.record()).unwrap();
        for name in ["z.md", "a.md", "m.md"] {
            f.ws.create("", name, false).unwrap();
        }
        f.store.clear();
        assert_eq!(f.order().parents[""], ["C", "A", "B"]);
        assert_eq!(fs::read(f.record()).unwrap(), legacy);
        let entries = f.ws.list("").unwrap();
        f.store.listed(&f.ws, f.data.path(), "", &entries);
        assert_eq!(
            f.order().parents[""],
            ["C", "A", "B", "a.md", "m.md", "z.md"]
        );
        let sorted = f
            .apply("z.md", "", Some("a.md"), Placement::Before)
            .unwrap();
        assert!(!sorted.moved);
        assert_eq!(
            sorted.order.parents[""],
            ["C", "A", "B", "z.md", "a.md", "m.md"]
        );
        f.ws.create("", "AA", true).unwrap();
        f.ws.create("", "aa.md", false).unwrap();
        let entries = f.ws.list("").unwrap();
        f.store.listed(&f.ws, f.data.path(), "", &entries);
        assert_eq!(
            f.order().parents[""],
            ["C", "A", "B", "AA", "z.md", "a.md", "m.md", "aa.md"]
        );
        f.store.clear();
        assert_eq!(f.order().parents[""][0], "C");
        assert_eq!(
            &f.order().parents[""][4..],
            ["z.md", "a.md", "m.md", "aa.md"]
        );
        f.apply("", "", None, Placement::Reset).unwrap();
        assert!(f.order().parents.is_empty());
        assert_eq!(
            merge(None, &f.ws.list("").unwrap()),
            ["A", "AA", "B", "C", "a.md", "aa.md", "m.md", "z.md"]
        );
    }

    #[test]
    fn individual_note_moves_at_an_anchor_and_back_to_root_without_changing_bytes() {
        let mut f = Fixture::new();
        for (p, name, folder) in [
            ("A", "doc.MD", false),
            ("A", "keep.md", false),
            ("B", "X", true),
            ("B", "b.md", false),
            ("B", "y.md", false),
            ("", "root.md", false),
        ] {
            f.ws.create(p, name, folder).unwrap();
        }
        let bytes = b"\xef\xbb\xbf# Note\r\n\r\n[image](image.png)\r\n";
        fs::write(f.ws.resolve("A/doc.MD").unwrap(), bytes).unwrap();
        fs::write(f.ws.resolve("A").unwrap().join("image.png"), [0, 255, 12]).unwrap();
        f.apply("A/keep.md", "A", Some("A/doc.MD"), Placement::Before)
            .unwrap();
        let moved = f
            .apply("a/DOC.md", "b", Some("B/y.md"), Placement::Before)
            .unwrap();
        assert!(moved.moved);
        assert_eq!(moved.path, "B/doc.MD");
        assert_eq!(moved.order.parents["A"], ["A/keep.md"]);
        assert_eq!(
            moved.order.parents["B"],
            ["B/X", "B/b.md", "B/doc.MD", "B/y.md"]
        );
        assert_eq!(fs::read(f.ws.resolve(&moved.path).unwrap()).unwrap(), bytes);
        assert_eq!(
            fs::read(f.ws.resolve("A/image.png").unwrap()).unwrap(),
            [0, 255, 12]
        );
        assert!(f.ws.read("A/doc.MD", false).is_err());
        let note = f.ws.read(&moved.path, false).unwrap();
        assert_eq!(
            f.ws.save("A/doc.MD", "stale", &note.version)
                .unwrap_err()
                .code,
            "missing"
        );
        let back = f.apply(&moved.path, "", None, Placement::Inside).unwrap();
        assert_eq!(back.path, "doc.MD");
        assert_eq!(back.order.parents[""], ["A", "B", "C", "root.md", "doc.MD"]);
        assert_eq!(fs::read(f.ws.resolve(&back.path).unwrap()).unwrap(), bytes);
        f.store.clear();
        assert_eq!(f.order().parents, back.order.parents);
        let before = f.order().revision;
        assert_eq!(
            f.apply("doc.MD", "", None, Placement::Inside)
                .unwrap()
                .order
                .revision,
            before
        );
    }

    #[test]
    fn folders_move_to_end_of_folder_group_before_existing_notes() {
        let mut f = Fixture::new();
        f.ws.create("B", "folder.md", true).unwrap();
        f.ws.create("B", "first.md", false).unwrap();
        let moved = f.apply("A", "B", None, Placement::Inside).unwrap();
        assert_eq!(
            moved.order.parents["B"],
            ["B/folder.md", "B/A", "B/first.md"]
        );
        assert_eq!(
            f.apply("B/first.md", "B", Some("B/folder.md"), Placement::Before)
                .unwrap_err()
                .code,
            "order"
        );
        assert_eq!(
            f.apply("B/A", "B", Some("B/first.md"), Placement::Before)
                .unwrap_err()
                .code,
            "order"
        );
    }

    #[test]
    fn note_order_survives_rename_and_prunes_only_deleted_notes_on_successful_listing() {
        let mut f = Fixture::new();
        for name in ["a.md", "b.md", "c.md"] {
            f.ws.create("A", name, false).unwrap();
        }
        f.apply("A/c.md", "A", Some("A/a.md"), Placement::Before)
            .unwrap();
        let next = f.ws.rename("A/c.md", "z.md").unwrap();
        f.store.renamed(&f.ws, f.data.path(), "A/c.md", &next);
        assert_eq!(f.order().parents["A"], ["A/z.md", "A/a.md", "A/b.md"]);
        fs::remove_file(f.ws.resolve("A/a.md").unwrap()).unwrap();
        f.store.recycled(&f.ws, f.data.path(), "A/a.md");
        assert_eq!(f.order().parents["A"], ["A/z.md", "A/b.md"]);
        fs::rename(
            f.ws.resolve("A/b.md").unwrap(),
            f.ws.resolve("A").unwrap().join("new.md"),
        )
        .unwrap();
        assert_eq!(f.order().parents["A"], ["A/z.md", "A/b.md"]);
        let entries = f.ws.list("A").unwrap();
        f.store.listed(&f.ws, f.data.path(), "A", &entries);
        assert_eq!(f.order().parents["A"], ["A/z.md", "A/new.md"]);
        f.apply("", "A", None, Placement::Reset).unwrap();
        let new = f.ws.rename("A/z.md", "first.md").unwrap();
        f.store.renamed(&f.ws, f.data.path(), "A/z.md", &new);
        assert!(!f.order().parents.contains_key("A"));
    }

    #[test]
    fn individual_note_sort_rolls_back_on_preference_failure_but_move_and_rename_keep_new_path() {
        let mut f = Fixture::new();
        f.ws.create("A", "a.md", false).unwrap();
        f.ws.create("A", "b.md", false).unwrap();
        fs::write(f.ws.resolve("A/a.md").unwrap(), b"exact note bytes\r\n").unwrap();
        f.apply("A/b.md", "A", Some("A/a.md"), Placement::Before)
            .unwrap();
        let record = f.record();
        let bytes = fs::read(&record).unwrap();
        let order = f.order();
        let permissions = fs::metadata(&record).unwrap().permissions();
        let mut readonly = permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&record, readonly).unwrap();
        assert!(f
            .apply("A/a.md", "A", Some("A/b.md"), Placement::Before)
            .is_err());
        assert_eq!(f.order().revision, order.revision);
        assert_eq!(f.order().parents, order.parents);
        let moved = f.apply("A/a.md", "B", None, Placement::Inside).unwrap();
        assert!(moved.moved && moved.warning.is_some());
        assert_eq!(
            fs::read(f.ws.resolve("B/a.md").unwrap()).unwrap(),
            b"exact note bytes\r\n"
        );
        let renamed = f.ws.rename("B/a.md", "renamed.md").unwrap();
        f.store.renamed(&f.ws, f.data.path(), "B/a.md", &renamed);
        assert_eq!(f.order().parents["B"], ["B/renamed.md"]);
        assert!(f.order().warning.is_some());
        assert!(f.ws.resolve("A/a.md").is_err());
        assert_eq!(fs::read(&record).unwrap(), bytes);
        fs::set_permissions(&record, permissions).unwrap();
        let retried = f
            .store
            .retry(&f.ws, f.data.path(), &moved.order.root)
            .unwrap();
        assert!(retried.warning.is_none());
        f.store.clear();
        assert_eq!(f.order().parents, retried.parents);
    }
}
