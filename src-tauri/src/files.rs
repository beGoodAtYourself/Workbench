use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::os::windows::fs::MetadataExt;
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub type Result<T> = std::result::Result<T, Fault>;
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fault {
    pub code: String,
    pub message: String,
}
impl Fault {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}
impl From<std::io::Error> for Fault {
    fn from(e: std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => "missing",
            std::io::ErrorKind::PermissionDenied => "permission",
            std::io::ErrorKind::AlreadyExists => "exists",
            _ => "io",
        };
        Self::new(code, format!("文件操作失败：{e}"))
    }
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub path: String,
    pub text: String,
    pub version: String,
    pub size: u64,
}
#[derive(Clone, Serialize, Debug)]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub kind: String,
}
#[derive(Debug)]
pub struct Workspace {
    pub root: PathBuf,
}
pub fn version(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn movable_kind(path: &Path) -> Result<&'static str> {
    let metadata = fs::metadata(path)?;
    if metadata.is_dir() {
        Ok("folder")
    } else if metadata.is_file()
        && path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().to_lowercase().ends_with(".md"))
    {
        Ok("note")
    } else {
        Err(Fault::new(
            "type",
            "只能排序或移动真实文件夹与 Markdown（.md）笔记。",
        ))
    }
}
pub fn validate_name(name: &str) -> Result<()> {
    let base = name.split('.').next().unwrap_or("").to_uppercase();
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9", "COM¹",
        "COM²", "COM³", "LPT¹", "LPT²", "LPT³",
    ];
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with([' ', '.'])
        || name.chars().any(|c| c < ' ' || "<>:\"/\\|?*".contains(c))
        || reserved.contains(&base.as_str())
        || name.encode_utf16().count() > 240
    {
        return Err(Fault::new(
            "name",
            "名称无效：请避开路径分隔符、保留名称、末尾空格或句点。",
        ));
    }
    Ok(())
}
fn relative(path: &str) -> Result<PathBuf> {
    let path = path.replace('\\', "/");
    if path.starts_with('/') {
        return Err(Fault::new("boundary", "只能访问笔记文件夹内的相对路径。"));
    }
    let mut result = PathBuf::new();
    for component in Path::new(&path).components() {
        match component {
            Component::Normal(s) => {
                validate_name(&s.to_string_lossy())?;
                result.push(s);
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() {
                    return Err(Fault::new("boundary", "链接超出了笔记文件夹。"));
                }
            }
            _ => return Err(Fault::new("boundary", "不支持绝对路径。")),
        }
    }
    Ok(result)
}
impl Workspace {
    pub fn new(root: &Path) -> Result<Self> {
        let root = fs::canonicalize(root)?;
        if !root.is_dir() {
            return Err(Fault::new("directory", "请选择本地文件夹。"));
        }
        Ok(Self { root })
    }
    pub fn resolve(&self, path: &str) -> Result<PathBuf> {
        let rel = relative(path)?;
        let mut full = self.root.clone();
        for part in rel.components() {
            full.push(part);
            let meta = fs::symlink_metadata(&full)?;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(Fault::new("boundary", "首版不访问符号链接或联接目录。"));
            }
        }
        let full = fs::canonicalize(full)?;
        if !full.starts_with(&self.root) {
            return Err(Fault::new("boundary", "路径超出了笔记文件夹。"));
        }
        Ok(full)
    }
    pub fn rel(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    }
    pub fn list(&self, parent: &str) -> Result<Vec<Entry>> {
        let full = self.resolve(parent)?;
        let mut entries = Vec::new();
        for item in fs::read_dir(full)? {
            let item = item?;
            let meta = fs::symlink_metadata(item.path())?;
            if meta.file_attributes() & 0x400 != 0 {
                continue;
            }
            let name = item.file_name().to_string_lossy().to_string();
            if name.starts_with(".shiye-") {
                continue;
            }
            if meta.is_dir() || (meta.is_file() && name.to_lowercase().ends_with(".md")) {
                entries.push(Entry {
                    path: self.rel(&item.path()),
                    name,
                    kind: if meta.is_dir() { "folder" } else { "note" }.into(),
                });
            }
        }
        entries.sort_by(|a, b| {
            a.kind
                .cmp(&b.kind)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }
    fn note_path(&self, path: &str) -> Result<PathBuf> {
        if !path.to_lowercase().ends_with(".md") {
            return Err(Fault::new("type", "这里只能打开 Markdown（.md）文件。"));
        }
        let full = self.resolve(path)?;
        if !full.is_file() {
            return Err(Fault::new("type", "目标不是笔记文件。"));
        }
        Ok(full)
    }
    pub fn read(&self, path: &str, allow_large: bool) -> Result<Note> {
        let full = self.note_path(path)?;
        let size = fs::metadata(&full)?.len();
        if size > 2 * 1024 * 1024 && !allow_large {
            return Err(Fault::new(
                "large",
                format!(
                    "这篇笔记约 {:.1} MiB，继续加载可能占用较多内存。",
                    size as f64 / 1048576.
                ),
            ));
        }
        // Refuse pathological allocations, including a file growing between stat and read.
        let mut data = Vec::new();
        fs::File::open(&full)?
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut data)?;
        if data.len() > 64 * 1024 * 1024 {
            return Err(Fault::new(
                "large-limit",
                "笔记超过 64 MiB，请使用外部编辑器处理。",
            ));
        }
        let raw = std::str::from_utf8(&data).map_err(|_| {
            Fault::new("encoding", "文件不是有效 UTF-8；请先在外部编辑器转换编码。")
        })?;
        Ok(Note {
            path: self.rel(&full),
            text: raw.trim_start_matches('\u{feff}').replace("\r\n", "\n"),
            version: version(&data),
            size: data.len() as u64,
        })
    }
    pub fn save(&self, path: &str, text: &str, expected: &str) -> Result<String> {
        let full = self.note_path(path)?;
        let current = fs::read(&full)?;
        if version(&current) != expected {
            return Err(Fault::new(
                "conflict",
                "磁盘文件已被其他程序修改。请选择重新载入或另存副本。",
            ));
        }
        let raw = std::str::from_utf8(&current)
            .map_err(|_| Fault::new("encoding", "磁盘文件编码已改变，不能覆盖。"))?;
        if fs::metadata(&full)?.permissions().readonly() {
            return Err(Fault::new("permission", "这篇笔记是只读文件。"));
        }
        let mut output = String::new();
        if raw.starts_with('\u{feff}') {
            output.push('\u{feff}');
        }
        if raw.contains("\r\n") {
            output.push_str(&text.replace("\r\n", "\n").replace('\n', "\r\n"));
        } else {
            output.push_str(text);
        }
        let mut temp = tempfile::Builder::new()
            .prefix(".shiye-")
            .tempfile_in(full.parent().unwrap())?;
        temp.write_all(output.as_bytes())?;
        temp.as_file().sync_all()?;
        if version(&fs::read(&full)?) != expected {
            return Err(Fault::new(
                "conflict",
                "保存前磁盘文件再次变化，已保留你的修改。",
            ));
        }
        temp.persist(&full).map_err(|e| Fault::from(e.error))?;
        Ok(version(output.as_bytes()))
    }
    pub fn create(&self, parent: &str, input: &str, folder: bool) -> Result<String> {
        validate_name(input)?;
        let name = if folder || input.to_lowercase().ends_with(".md") {
            input.into()
        } else {
            format!("{input}.md")
        };
        validate_name(&name)?;
        let dir = self.resolve(parent)?;
        if !dir.is_dir() {
            return Err(Fault::new("directory", "请选择文件夹。"));
        }
        let target = dir.join(name);
        if folder {
            fs::create_dir(&target)?;
        } else {
            fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)?
                .sync_all()?;
        }
        Ok(self.rel(&target))
    }
    pub fn rename(&self, path: &str, input: &str) -> Result<String> {
        if path.is_empty() {
            return Err(Fault::new("boundary", "不能重命名笔记根目录。"));
        }
        validate_name(input)?;
        let source = self.resolve(path)?;
        let name = if source.is_file() && !input.to_lowercase().ends_with(".md") {
            format!("{input}.md")
        } else {
            input.into()
        };
        validate_name(&name)?;
        let target = source.parent().unwrap().join(name);
        if target.exists() && fs::canonicalize(&target)? != source {
            return Err(Fault::new("exists", "同名文件或文件夹已存在。"));
        }
        fs::rename(&source, &target)?;
        Ok(self.rel(&target))
    }
    pub fn move_folder(&self, path: &str, parent: &str, anchor: Option<&str>) -> Result<String> {
        let source = self.resolve(path)?;
        let destination = self.resolve(parent)?;
        if source == self.root {
            return Err(Fault::new("boundary", "不能移动笔记根目录。"));
        }
        let kind = movable_kind(&source)?;
        if !destination.is_dir() || destination.starts_with(&source) {
            return Err(Fault::new("boundary", "不能移入自身、后代或无效目录。"));
        }
        if let Some(anchor) = anchor {
            let full = self.resolve(anchor)?;
            if movable_kind(&full).ok() != Some(kind)
                || full.parent() != Some(destination.as_path())
            {
                return Err(Fault::new(
                    "order",
                    "插入目标必须是同级的同类项目，请重新选择位置。",
                ));
            }
        }
        if source.parent() == Some(destination.as_path()) {
            return Ok(self.rel(&source));
        }
        let target = destination.join(source.file_name().unwrap());
        // MoveFileExW with flags=0 rejects an existing target at the actual rename, including
        // a file or directory created after validation. Never enable replacement or copy/delete fallback.
        move_directory_no_replace(&source, &target)?;
        Ok(self.rel(&target))
    }
    pub fn recycle(&self, path: &str) -> Result<()> {
        if path.is_empty() {
            return Err(Fault::new("boundary", "不能删除笔记根目录。"));
        }
        let full = self.resolve(path)?;
        // No permanent-delete fallback.
        trash::delete(full).map_err(|e| Fault::new("trash", format!("无法移至回收站：{e}")))
    }
    pub fn image(&self, path: &str) -> Result<String> {
        use base64::Engine;
        let full = self.resolve(path)?;
        let kind = match full
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str()
        {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => return Err(Fault::new("type", "不支持这种图片格式。")),
        };
        let size = fs::metadata(&full)?.len();
        if size > 4 * 1024 * 1024 {
            return Err(Fault::new("image-size", "图片超过 4 MiB，已保留占位。"));
        }
        let (width, height) =
            image::image_dimensions(&full).map_err(|_| Fault::new("image", "图片无法读取。"))?;
        if width as u64 * height as u64 > 8_000_000 {
            return Err(Fault::new(
                "image-size",
                "图片超过 800 万像素，已保留占位。",
            ));
        }
        let data = fs::read(full)?;
        Ok(format!(
            "data:{kind};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(data)
        ))
    }
}

fn move_directory_no_replace(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe {
        windows_sys::Win32::Storage::FileSystem::MoveFileExW(source.as_ptr(), target.as_ptr(), 0)
    } == 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (tempfile::TempDir, Workspace) {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path()).unwrap();
        (dir, ws)
    }
    #[test]
    fn create_reopen_and_collision() {
        let (_dir, ws) = setup();
        ws.create("", "资料", true).unwrap();
        let p = ws.create("资料", "中文笔记", false).unwrap();
        let n = ws.read(&p, false).unwrap();
        ws.save(&p, "# 中文\n正文", &n.version).unwrap();
        assert_eq!(ws.read(&p, false).unwrap().text, "# 中文\n正文");
        assert_eq!(
            ws.create("资料", "中文笔记", false).unwrap_err().code,
            "exists"
        );
        assert_eq!(ws.list("资料").unwrap().len(), 1);
    }
    #[test]
    fn preserves_bom_crlf_and_conflicts() {
        let (_dir, ws) = setup();
        let p = ws.create("", "test", false).unwrap();
        fs::write(ws.resolve(&p).unwrap(), b"\xef\xbb\xbf# Hi\r\n").unwrap();
        let n = ws.read(&p, false).unwrap();
        ws.save(&p, "# New\n", &n.version).unwrap();
        assert_eq!(
            fs::read(ws.resolve(&p).unwrap()).unwrap(),
            b"\xef\xbb\xbf# New\r\n"
        );
        assert_eq!(
            ws.save(&p, "stale", &n.version).unwrap_err().code,
            "conflict"
        );
    }
    #[test]
    fn rejects_paths_and_reserved_names() {
        let (_dir, ws) = setup();
        for name in ["CON", "LPT1.md", "COM¹", "a/b", "x.", "x ", "a:b", ""] {
            assert!(ws.create("", name, false).is_err(), "{name}");
        }
        for p in ["../a.md", "C:/a.md", "/a.md", "a/../../b.md"] {
            assert!(ws.read(p, false).is_err(), "{p}");
        }
    }
    #[test]
    fn invalid_encoding_readonly_and_missing_preserve_data() {
        let (_dir, ws) = setup();
        let p = ws.create("", "a", false).unwrap();
        let full = ws.resolve(&p).unwrap();
        fs::write(&full, [0xff, 0xfe, 0x80]).unwrap();
        assert_eq!(ws.read(&p, false).unwrap_err().code, "encoding");
        fs::write(&full, b"safe").unwrap();
        let n = ws.read(&p, false).unwrap();
        let original_permissions = fs::metadata(&full).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&full, permissions).unwrap();
        assert_eq!(
            ws.save(&p, "changed", &n.version).unwrap_err().code,
            "permission"
        );
        fs::set_permissions(&full, original_permissions).unwrap();
        assert_eq!(fs::read(&full).unwrap(), b"safe");
        fs::remove_file(&full).unwrap();
        assert_eq!(
            ws.save(&p, "recreate", &n.version).unwrap_err().code,
            "missing"
        );
        assert!(!full.exists());
    }
    #[test]
    fn rename_directory_and_large_file() {
        let (_dir, ws) = setup();
        ws.create("", "old", true).unwrap();
        let p = ws.create("old", "a", false).unwrap();
        let data = "a".repeat(2 * 1024 * 1024 + 1);
        fs::write(ws.resolve(&p).unwrap(), &data).unwrap();
        assert_eq!(ws.read(&p, false).unwrap_err().code, "large");
        assert_eq!(ws.read(&p, true).unwrap().text.len(), data.len());
        ws.rename("old", "new").unwrap();
        assert!(ws.read("new/a.md", true).is_ok());
        assert!(ws.read("old/a.md", true).is_err());
    }
    #[test]
    fn recycle_root_is_rejected() {
        let (_dir, ws) = setup();
        assert_eq!(ws.recycle("").unwrap_err().code, "boundary");
    }
    #[test]
    fn exclusive_lock_does_not_damage_the_original() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_dir, ws) = setup();
        let p = ws.create("", "locked", false).unwrap();
        let note = ws.read(&p, false).unwrap();
        ws.save(&p, "original", &note.version).unwrap();
        let note = ws.read(&p, false).unwrap();
        let full = ws.resolve(&p).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&full)
            .unwrap();
        assert!(ws.save(&p, "changed", &note.version).is_err());
        assert!(ws.recycle(&p).is_err());
        drop(lock);
        assert_eq!(fs::read_to_string(full).unwrap(), "original");
    }
    #[test]
    fn junctions_never_escape_or_recurse() {
        let (_dir, ws) = setup();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "outside").unwrap();
        let link = ws.root.join("linked");
        let status = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(
            status.status.success(),
            "junction fixture could not be created"
        );
        assert_eq!(
            ws.read("linked/secret.md", false).unwrap_err().code,
            "boundary"
        );
        assert!(ws.list("").unwrap().is_empty());
        fs::remove_dir(&link).unwrap();
        assert_eq!(
            fs::read_to_string(outside.path().join("secret.md")).unwrap(),
            "outside"
        );
    }
    #[test]
    fn same_case_identity_and_image_limits() {
        let (_dir, ws) = setup();
        let p = ws.create("", "MixedCase", false).unwrap();
        assert!(ws.read("mixedcase.md", false).is_ok());
        let renamed = ws.rename(&p, "mixedcase.md").unwrap();
        assert!(ws.read(&renamed, false).is_ok());
        let png = ws.root.join("image.png");
        image::RgbaImage::new(8, 8).save(&png).unwrap();
        assert!(ws
            .image("image.png")
            .unwrap()
            .starts_with("data:image/png;base64,"));
        fs::write(&png, vec![0u8; 4 * 1024 * 1024 + 1]).unwrap();
        assert_eq!(ws.image("image.png").unwrap_err().code, "image-size");
    }

    #[test]
    fn folder_move_rejects_collision_at_commit_without_replacing_empty_directory() {
        let (_dir, ws) = setup();
        ws.create("", "source", true).unwrap();
        ws.create("", "target", true).unwrap();
        let source = ws.resolve("source").unwrap();
        let target = ws.resolve("target").unwrap().join("source");
        fs::write(source.join("payload.bin"), [0, 255, 12]).unwrap();
        assert!(!target.exists());
        // Another process creates an empty target after prevalidation, before the actual syscall.
        fs::create_dir(&target).unwrap();
        assert!(move_directory_no_replace(&source, &target).is_err());
        assert!(target.is_dir());
        assert!(fs::read_dir(&target).unwrap().next().is_none());
        assert_eq!(fs::read(source.join("payload.bin")).unwrap(), [0, 255, 12]);
    }

    #[test]
    fn folder_move_revalidates_anchor_and_rejects_junction_source_or_target() {
        let (_dir, ws) = setup();
        ws.create("", "source", true).unwrap();
        ws.create("", "target", true).unwrap();
        ws.create("target", "anchor", true).unwrap();
        let anchor = ws.resolve("target/anchor").unwrap();
        fs::rename(&anchor, ws.root.join("anchor")).unwrap();
        assert!(ws
            .move_folder("source", "target", Some("target/anchor"))
            .is_err());
        assert!(ws.move_folder("source", "target", Some("anchor")).is_err());
        let outside = tempfile::tempdir().unwrap();
        let link = ws.root.join("junction");
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            ws.move_folder("junction", "target", None).unwrap_err().code,
            "boundary"
        );
        assert_eq!(
            ws.move_folder("source", "junction", None).unwrap_err().code,
            "boundary"
        );
        fs::remove_dir(&link).unwrap();
        assert!(ws.resolve("source").is_ok());
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    #[test]
    fn folder_move_with_locked_content_does_not_copy_or_delete() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_dir, ws) = setup();
        ws.create("", "source", true).unwrap();
        ws.create("", "target", true).unwrap();
        let payload = ws.resolve("source").unwrap().join("locked.bin");
        fs::write(&payload, b"retain exact bytes").unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&payload)
            .unwrap();
        assert!(ws.move_folder("source", "target", None).is_err());
        assert!(ws.resolve("source").is_ok());
        assert!(ws.resolve("target/source").is_err());
        drop(lock);
        assert_eq!(fs::read(payload).unwrap(), b"retain exact bytes");
    }

    #[test]
    fn note_move_rejects_file_collision_at_commit_and_locked_source_without_overwrite() {
        use std::os::windows::fs::OpenOptionsExt;
        let (_dir, ws) = setup();
        ws.create("", "target", true).unwrap();
        let note = ws.create("", "note.md", false).unwrap();
        let source = ws.resolve(&note).unwrap();
        let target = ws.resolve("target").unwrap().join("note.md");
        fs::write(&source, b"source\r\n").unwrap();
        assert!(!target.exists());
        fs::write(&target, b"created by another process").unwrap();
        assert!(move_directory_no_replace(&source, &target).is_err());
        assert_eq!(fs::read(&source).unwrap(), b"source\r\n");
        assert_eq!(fs::read(&target).unwrap(), b"created by another process");
        fs::remove_file(&target).unwrap();
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&source)
            .unwrap();
        assert!(ws.move_folder(&note, "target", None).is_err());
        assert!(!target.exists());
        drop(lock);
        assert_eq!(fs::read(&source).unwrap(), b"source\r\n");
        assert_eq!(
            ws.move_folder(&note, "target", None).unwrap(),
            "target/note.md"
        );
        assert!(!source.exists());
        assert_eq!(fs::read(target).unwrap(), b"source\r\n");
    }

    #[test]
    fn note_move_revalidates_same_kind_anchor_and_rejects_non_markdown_sources() {
        let (_dir, ws) = setup();
        ws.create("", "target", true).unwrap();
        ws.create("", "source.md", false).unwrap();
        ws.create("target", "folder", true).unwrap();
        ws.create("target", "anchor.md", false).unwrap();
        assert_eq!(
            ws.move_folder("source.md", "target", Some("target/folder"))
                .unwrap_err()
                .code,
            "order"
        );
        let anchor = ws.resolve("target/anchor.md").unwrap();
        fs::rename(&anchor, ws.root.join("anchor.md")).unwrap();
        assert_eq!(
            ws.move_folder("source.md", "target", Some("target/anchor.md"))
                .unwrap_err()
                .code,
            "missing"
        );
        assert_eq!(
            ws.move_folder("source.md", "target", Some("anchor.md"))
                .unwrap_err()
                .code,
            "order"
        );
        fs::write(ws.root.join("other.txt"), b"not markdown").unwrap();
        assert_eq!(
            ws.move_folder("other.txt", "target", None)
                .unwrap_err()
                .code,
            "type"
        );
        assert!(ws.resolve("source.md").is_ok());
        assert!(ws.resolve("target/source.md").is_err());
        let dot_note = ws.create("", ".md", false).unwrap();
        assert_eq!(
            ws.move_folder(&dot_note, "target", None).unwrap(),
            "target/.md"
        );
    }
}
