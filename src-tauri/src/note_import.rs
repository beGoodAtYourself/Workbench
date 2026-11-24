use crate::files::{validate_name, Fault, Result, Workspace};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

const MAX_NOTE_BYTES: u64 = 64 * 1024 * 1024;

impl Workspace {
    /// 将用户选择的 Markdown 原样复制到笔记目录，同名时递增编号且不覆盖已有项目。
    pub fn import_markdown(&self, parent: &str, source: &Path) -> Result<String> {
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| Fault::new("name", "无法读取文件名，请重命名后重试。"))?;
        validate_name(name)?;
        if !name.to_lowercase().ends_with(".md") {
            return Err(Fault::new("type", "请选择 Markdown（.md）文件。"));
        }
        if name.to_lowercase().starts_with(".shiye-") {
            return Err(Fault::new(
                "name",
                "文件名使用了内部保留前缀，请重命名后导入。",
            ));
        }

        let directory = self.resolve(parent)?;
        if !directory.is_dir() {
            return Err(Fault::new("directory", "请选择笔记文件夹。"));
        }
        let file = fs::File::open(source)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(Fault::new("type", "请选择 Markdown 文件，不能导入文件夹。"));
        }
        if metadata.len() > MAX_NOTE_BYTES {
            return Err(Fault::new("large-limit", "笔记超过 64 MiB，无法导入。"));
        }

        let mut bytes = Vec::new();
        file.take(MAX_NOTE_BYTES + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_NOTE_BYTES {
            return Err(Fault::new("large-limit", "笔记超过 64 MiB，无法导入。"));
        }
        std::str::from_utf8(&bytes)
            .map_err(|_| Fault::new("encoding", "文件不是有效 UTF-8；请先转换编码后再导入。"))?;

        // 先完整写入临时文件，再以禁止覆盖的方式提交，失败时自动清理临时文件。
        let mut temporary = tempfile::Builder::new()
            .prefix(".shiye-import-")
            .tempfile_in(&directory)?;
        temporary.write_all(&bytes)?;
        temporary.as_file().sync_all()?;
        drop(bytes);

        for index in 0..10_000 {
            let candidate = if index == 0 {
                name.to_owned()
            } else {
                format!(
                    "{} ({index}){}",
                    &name[..name.len() - 3],
                    &name[name.len() - 3..]
                )
            };
            validate_name(&candidate)?;
            let target = directory.join(candidate);
            if fs::symlink_metadata(&target).is_ok() {
                continue;
            }

            // 即使其他程序在检查后创建同名项目，提交也不会替换它。
            match temporary.persist_noclobber(&target) {
                Ok(_) => return Ok(self.rel(&target)),
                Err(error)
                    if error.error.kind() == std::io::ErrorKind::AlreadyExists
                        || fs::symlink_metadata(&target).is_ok() =>
                {
                    temporary = error.file;
                }
                Err(error) => return Err(error.error.into()),
            }
        }
        Err(Fault::new("exists", "同名文件过多，请重命名后再导入。"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_into_selected_directory_preserving_source_bytes() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let ws = Workspace::new(root.path()).unwrap();
        ws.create("", "资料", true).unwrap();
        let input = source.path().join("测试.MD");
        let bytes = "\u{feff}# 中文标题\r\n\r\n正文\r\n".as_bytes();
        fs::write(&input, bytes).unwrap();

        let imported = ws.import_markdown("资料", &input).unwrap();

        assert_eq!(imported, "资料/测试.MD");
        assert_eq!(fs::read(ws.resolve(&imported).unwrap()).unwrap(), bytes);
        assert_eq!(fs::read(&input).unwrap(), bytes);
        assert_eq!(
            ws.read(&imported, false).unwrap().text,
            "# 中文标题\n\n正文\n"
        );
        assert_eq!(ws.list("资料").unwrap().len(), 1);
    }

    #[test]
    fn collisions_with_files_folders_and_source_create_numbered_copies() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let ws = Workspace::new(root.path()).unwrap();
        let input = source.path().join("note.md");
        fs::write(&input, "导入正文").unwrap();
        fs::write(root.path().join("NOTE.MD"), "保留正文").unwrap();
        fs::create_dir(root.path().join("note (1).md")).unwrap();

        assert_eq!(ws.import_markdown("", &input).unwrap(), "note (2).md");
        let copied = root.path().join("note (2).md");
        assert_eq!(ws.import_markdown("", &copied).unwrap(), "note (2) (1).md");
        assert_eq!(
            fs::read_to_string(root.path().join("NOTE.MD")).unwrap(),
            "保留正文"
        );
        assert_eq!(fs::read_to_string(input).unwrap(), "导入正文");
        assert!(root.path().join("note (1).md").is_dir());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 4);
    }

    #[test]
    fn concurrent_imports_do_not_overwrite_each_other() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let input = source.path().join("并发.md");
        fs::write(&input, "完整正文").unwrap();
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let directory = root.path().to_owned();
                let input = input.clone();
                std::thread::spawn(move || {
                    Workspace::new(&directory)
                        .unwrap()
                        .import_markdown("", &input)
                        .unwrap()
                })
            })
            .collect();
        let paths: std::collections::HashSet<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();

        assert_eq!(paths.len(), 8);
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 8);
        for path in paths {
            assert_eq!(
                fs::read_to_string(root.path().join(path)).unwrap(),
                "完整正文"
            );
        }
    }

    #[test]
    fn invalid_sources_leave_destination_unchanged() {
        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let ws = Workspace::new(root.path()).unwrap();
        for (name, bytes, code) in [
            ("wrong.txt", b"text".as_slice(), "type"),
            ("bad.md", b"\xff\xfe\x00".as_slice(), "encoding"),
            (".shiye-hidden.md", b"text".as_slice(), "name"),
        ] {
            let input = source.path().join(name);
            fs::write(&input, bytes).unwrap();
            assert_eq!(ws.import_markdown("", &input).unwrap_err().code, code);
            assert_eq!(fs::read(&input).unwrap(), bytes);
        }
        let large = source.path().join("large.md");
        fs::File::create(&large)
            .unwrap()
            .set_len(MAX_NOTE_BYTES + 1)
            .unwrap();
        assert_eq!(
            ws.import_markdown("", &large).unwrap_err().code,
            "large-limit"
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn invalid_destination_and_locked_source_leave_no_partial_files() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        let ws = Workspace::new(root.path()).unwrap();
        let input = source.path().join("note.md");
        fs::write(&input, "正文").unwrap();
        assert!(ws.import_markdown("../outside", &input).is_err());
        assert!(ws.import_markdown("missing", &input).is_err());
        let lock = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&input)
            .unwrap();
        assert!(ws.import_markdown("", &input).is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
        drop(lock);
        assert_eq!(fs::read_to_string(input).unwrap(), "正文");
    }
}
