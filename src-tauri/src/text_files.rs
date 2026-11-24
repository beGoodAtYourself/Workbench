//! Strict text codecs and precise disk identities. No IPC accepts a filesystem path here.
use crate::files::{version, Fault, Result};
use serde::{Deserialize, Serialize};
use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

pub const FILE_LIMIT: usize = 16 * 1024 * 1024;
pub const LARGE_FILE: u64 = 2 * 1024 * 1024;

pub use crate::text_encoding::Encoding;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
    Cr,
    Mixed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Identity {
    pub volume: u32,
    pub index: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub highlights: Vec<crate::text_annotations::Highlight>,
    pub id: String,
    pub path: String,
    pub name: String,
    pub text: String,
    pub version: String,
    pub size: u64,
    pub encoding: Encoding,
    pub eol: Eol,
    pub readonly: bool,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextSave {
    pub id: String,
    pub text: String,
    pub version: String,
    pub encoding: Encoding,
    pub eol: Eol,
}

pub fn display_path(path: &Path) -> String {
    path.to_string_lossy()
        .trim_start_matches(r"\\?\")
        .to_string()
}
pub fn path_key(path: &Path) -> String {
    display_path(path).replace('\\', "/").to_lowercase()
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_".contains(&b))
}

/// Reject reparse points at every component, including a junction above the selected file.
pub fn ordinary_path(path: &Path, must_exist: bool) -> Result<PathBuf> {
    if !path.is_absolute() {
        return Err(Fault::new("authorization", "请选择完整的普通文件路径。"));
    }
    let label = path.to_string_lossy().to_lowercase();
    if label.starts_with(r"\\.\") || label.starts_with(r"\??\") {
        return Err(Fault::new("authorization", "不能授权设备路径。"));
    }
    let mut current = PathBuf::new();
    for component in path.components() {
        if let Component::Prefix(prefix) = component {
            use std::path::Prefix;
            if !matches!(
                prefix.kind(),
                Prefix::Disk(_)
                    | Prefix::VerbatimDisk(_)
                    | Prefix::UNC(_, _)
                    | Prefix::VerbatimUNC(_, _)
            ) {
                return Err(Fault::new(
                    "authorization",
                    "只能授权普通磁盘或 UNC 文件，不能访问设备命名空间。",
                ));
            }
        }
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err(Fault::new("authorization", "授权路径不能含相对跳转。"));
        }
        current.push(component);
        if !matches!(component, Component::Normal(_)) {
            continue;
        }
        if component.as_os_str().to_string_lossy().contains(':') {
            return Err(Fault::new("authorization", "不能授权 Windows 备用数据流。"));
        }
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_attributes() & 0x400 != 0 => {
                return Err(Fault::new(
                    "authorization",
                    "不访问符号链接或联接目录，请选择真实文件。",
                ))
            }
            Ok(_) => {}
            Err(e)
                if !must_exist && current == path && e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
    }
    if must_exist {
        let canonical = fs::canonicalize(path)?;
        if !fs::metadata(&canonical)?.is_file() {
            return Err(Fault::new("type", "目标不是普通文件。"));
        }
        Ok(canonical)
    } else {
        let parent = path
            .parent()
            .ok_or_else(|| Fault::new("authorization", "目标没有父目录。"))?;
        let parent = fs::canonicalize(parent)?;
        if !parent.is_dir() {
            return Err(Fault::new("type", "另存目标的父目录不是目录。"));
        }
        let name = path
            .file_name()
            .ok_or_else(|| Fault::new("name", "缺少文件名。"))?;
        crate::files::validate_name(&name.to_string_lossy())?;
        Ok(parent.join(name))
    }
}
pub fn file_identity(file: &fs::File) -> Result<Identity> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(Identity {
        volume: info.dwVolumeSerialNumber,
        index: ((info.nFileIndexHigh as u64) << 32) | info.nFileIndexLow as u64,
    })
}
pub fn identity(path: &Path) -> Result<Identity> {
    file_identity(&fs::File::open(ordinary_path(path, true)?)?)
}
pub fn read_bytes(path: &Path, expected: Option<&Identity>) -> Result<(Vec<u8>, Identity)> {
    let canonical = ordinary_path(path, true)?;
    let file = fs::File::open(&canonical)?;
    let meta = file.metadata()?;
    let identity = file_identity(&file)?;
    if expected.is_some_and(|expected| *expected != identity) {
        return Err(Fault::new(
            "identity",
            "文件身份已改变，请通过打开对话框重新选择授权；当前草稿已保留。",
        ));
    }
    if !meta.is_file() {
        return Err(Fault::new("type", "目标不是普通文件。"));
    }
    if meta.len() > FILE_LIMIT as u64 {
        return Err(Fault::new(
            "large-limit",
            "文本文件超过 16 MiB，请使用外部编辑器。",
        ));
    }
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.take(FILE_LIMIT as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > FILE_LIMIT {
        return Err(Fault::new(
            "large-limit",
            "读取期间文件增长到 16 MiB 以上。",
        ));
    }
    if crate::text_files::identity(&canonical)? != identity {
        return Err(Fault::new(
            "identity",
            "读取期间文件被替换，请重新选择授权。",
        ));
    }
    Ok((bytes, identity))
}
pub fn decode(bytes: &[u8]) -> Result<(String, Encoding, Eol)> {
    decode_with_encoding(bytes, None)
}
pub fn decode_with_encoding(
    bytes: &[u8],
    requested: Option<Encoding>,
) -> Result<(String, Encoding, Eol)> {
    // 这些二进制签名也可能含有合法 ASCII 或 UTF-8 头部。
    if bytes.starts_with(b"%PDF-")
        || bytes.starts_with(b"PK\x03\x04")
        || bytes.starts_with(b"\x89PNG")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
        || bytes.starts_with(b"MZ")
        || bytes.starts_with(b"\x7fELF")
    {
        return Err(Fault::new("binary", "检测到二进制文件，不能作为文本打开。"));
    }
    let (text, encoding) = crate::text_encoding::decode(bytes, requested)?;
    let mut crlf = 0;
    let mut lf = 0;
    let mut cr = 0;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' if chars.peek() == Some(&'\n') => {
                crlf += 1;
                chars.next();
            }
            '\r' => cr += 1,
            '\n' => lf += 1,
            _ => {}
        }
    }
    let eol = if usize::from(crlf > 0) + usize::from(lf > 0) + usize::from(cr > 0) > 1 {
        Eol::Mixed
    } else if cr > 0 {
        Eol::Cr
    } else if lf > 0 {
        Eol::Lf
    } else {
        Eol::Crlf
    };
    Ok((
        text.replace("\r\n", "\n").replace('\r', "\n"),
        encoding,
        eol,
    ))
}
pub fn encode(text: &str, encoding: Encoding, eol: Eol) -> Result<Vec<u8>> {
    if text.contains('\0') {
        return Err(Fault::new(
            "encoding",
            "正文含 NUL 字符，无法无损保存为支持的文本。",
        ));
    }
    if !matches!(eol, Eol::Lf | Eol::Crlf) {
        return Err(Fault::new(
            "eol",
            "编辑后的 CR／混合换行文件须先明确选择统一为 LF 或 CRLF。",
        ));
    }
    let normal = text.replace("\r\n", "\n").replace('\r', "\n");
    let output = if eol == Eol::Crlf {
        normal.replace('\n', "\r\n")
    } else {
        normal
    };
    let bytes = crate::text_encoding::encode(&output, encoding)?;
    if bytes.len() > FILE_LIMIT {
        return Err(Fault::new(
            "large-limit",
            "编码后的文本超过 16 MiB，未写入原文件。",
        ));
    }
    Ok(bytes)
}
#[cfg(test)]
pub fn read_file(
    id: &str,
    path: &Path,
    expected: Option<&Identity>,
) -> Result<(TextFile, Identity)> {
    read_file_with_encoding(id, path, expected, None)
}
pub fn read_file_with_encoding(
    id: &str,
    path: &Path,
    expected: Option<&Identity>,
    requested: Option<Encoding>,
) -> Result<(TextFile, Identity)> {
    let (bytes, identity) = read_bytes(path, expected)?;
    let (text, encoding, eol) = match requested {
        Some(encoding) => decode_with_encoding(&bytes, Some(encoding))?,
        None => decode(&bytes)?,
    };
    Ok((
        TextFile {
            highlights: Vec::new(),
            id: id.into(),
            path: display_path(path),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            text,
            version: version(&bytes),
            size: bytes.len() as u64,
            encoding,
            eol,
            readonly: fs::metadata(path)?.permissions().readonly(),
        },
        identity,
    ))
}
pub fn atomic_write(
    path: &Path,
    bytes: &[u8],
    baseline: Option<(&Identity, &str)>,
) -> Result<Identity> {
    let path = ordinary_path(path, baseline.is_some())?;
    if bytes.len() > FILE_LIMIT {
        return Err(Fault::new("large-limit", "保存产物超过 16 MiB。"));
    }
    let check = || -> Result<()> {
        if let Some((id, expected)) = baseline {
            let (current, _) = read_bytes(&path, Some(id))?;
            if version(&current) != expected {
                return Err(Fault::new(
                    "conflict",
                    "磁盘文件已被其他程序修改，当前草稿已保留。",
                ));
            }
            if fs::metadata(&path)?.permissions().readonly() {
                return Err(Fault::new("permission", "文件是只读的，可另存副本。"));
            }
        } else if path.exists() {
            return Err(Fault::new("exists", "另存目标已被其他程序创建，未覆盖。"));
        }
        Ok(())
    };
    check()?;
    let mut temp = tempfile::Builder::new()
        .prefix(".shiye-text-")
        .tempfile_in(path.parent().unwrap())?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    let committed_identity = file_identity(temp.as_file())?;
    check()?;
    if baseline.is_some() {
        temp.persist(&path)
    } else {
        temp.persist_noclobber(&path)
    }
    .map_err(|e| Fault::from(e.error))?;
    Ok(committed_identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mostly_ascii_gbk_log_preserves_fullwidth_colons_and_bytes() {
        let mut bytes = b"[INFO] device connected\r\n".repeat(3500);
        bytes.extend_from_slice(b"[INFO] size\xa3\xba 1024\r\n[INFO] result\xa3\xba success\r\n");
        let (text, encoding, eol) = decode(&bytes).unwrap();
        assert_eq!(encoding, Encoding::Gbk);
        assert_eq!(eol, Eol::Crlf);
        assert!(text.ends_with("[INFO] size： 1024\n[INFO] result： success\n"));
        assert_eq!(encode(&text, encoding, eol).unwrap(), bytes);
    }

    #[test]
    #[ignore = "通过 SHIYE_LOG_REGRESSION 指定本机回归文件，仅只读验证"]
    fn local_log_opens_and_round_trips_without_writing_original() {
        let path = std::env::var_os("SHIYE_LOG_REGRESSION").expect("需要本机日志路径");
        let path = Path::new(&path);
        let bytes = fs::read(path).unwrap();
        let (file, _) = read_file("regression", path, None).unwrap();
        assert_eq!(encode(&file.text, file.encoding, file.eol).unwrap(), bytes);
        assert_eq!(fs::read(path).unwrap(), bytes);
        println!(
            "bytes={} encoding={:?} lines={}",
            bytes.len(),
            file.encoding,
            file.text.lines().count()
        );
    }
    #[test]
    fn codecs_round_trip_bom_and_eol() {
        for encoding in [
            Encoding::Utf8,
            Encoding::Utf8Bom,
            Encoding::Utf16Le,
            Encoding::Utf16Be,
        ] {
            for eol in [Eol::Lf, Eol::Crlf] {
                let bytes = encode("中文😀\nnext\n", encoding, eol).unwrap();
                let (text, enc, line) = decode(&bytes).unwrap();
                assert_eq!(text, "中文😀\nnext\n");
                assert_eq!(enc, encoding);
                assert_eq!(line, eol);
                assert_eq!(
                    bytes.starts_with(&[0xef, 0xbb, 0xbf]),
                    encoding == Encoding::Utf8Bom
                );
            }
        }
    }
    #[test]
    fn strict_encoding_and_mixed_lines() {
        for data in [
            &[0xff, 0xfe, 0][..],
            &[0xff, 0xfe, 0, 0xd8][..],
            &[0xef, 0xbb, 0xbf, 0xff][..],
            &[0, 0][..],
            b"%PDF-x".as_slice(),
        ] {
            assert!(decode(data).is_err());
        }
        assert_eq!(decode(b"a\rb\r").unwrap().2, Eol::Cr);
        assert_eq!(decode(b"a\r\nb\nc\r").unwrap().2, Eol::Mixed);
        assert!(encode("a\n", Encoding::Utf8, Eol::Mixed).is_err());
        assert!(encode(&"a".repeat(FILE_LIMIT), Encoding::Utf16Le, Eol::Lf).is_err());
    }
    #[test]
    fn identity_replacement_hardlinks_and_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("中文.txt");
        fs::write(&path, b"original").unwrap();
        let (doc, id) = read_file("a", &path, None).unwrap();
        let alias = dir.path().join("alias");
        fs::hard_link(&path, &alias).unwrap();
        assert_eq!(identity(&alias).unwrap(), id);
        fs::write(&path, b"external").unwrap();
        assert_eq!(
            atomic_write(&path, b"mine", Some((&id, &doc.version)))
                .unwrap_err()
                .code,
            "conflict"
        );
        let other = dir.path().join("other");
        fs::write(&other, b"replacement").unwrap();
        fs::remove_file(&path).unwrap();
        fs::rename(&other, &path).unwrap();
        assert_eq!(
            read_file("a", &path, Some(&id)).unwrap_err().code,
            "identity"
        );
        assert_eq!(fs::read(&path).unwrap(), b"replacement");
        assert!(atomic_write(&path, b"mine", None).is_err());
    }
    #[test]
    fn readonly_and_deleted_do_not_recreate() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a");
        fs::write(&path, b"safe").unwrap();
        let (doc, id) = read_file("a", &path, None).unwrap();
        let original = fs::metadata(&path).unwrap().permissions();
        let mut ro = original.clone();
        ro.set_readonly(true);
        fs::set_permissions(&path, ro).unwrap();
        assert_eq!(
            atomic_write(&path, b"no", Some((&id, &doc.version)))
                .unwrap_err()
                .code,
            "permission"
        );
        fs::set_permissions(&path, original).unwrap();
        fs::remove_file(&path).unwrap();
        assert!(atomic_write(&path, b"no", Some((&id, &doc.version))).is_err());
        assert!(!path.exists());
    }
    #[test]
    fn raw_file_limits_device_streams_and_junctions_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("large.txt");
        fs::File::create(&path)
            .unwrap()
            .set_len(FILE_LIMIT as u64 + 1)
            .unwrap();
        assert_eq!(read_file("a", &path, None).unwrap_err().code, "large-limit");
        assert!(ordinary_path(Path::new(r"\\.\NUL"), true).is_err());
        assert_eq!(
            ordinary_path(Path::new(r"\\?\pipe\shiye-test"), true)
                .unwrap_err()
                .code,
            "authorization"
        );
        assert_eq!(
            ordinary_path(
                Path::new(r"\\?\GLOBALROOT\Device\HarddiskVolume1\secret"),
                true
            )
            .unwrap_err()
            .code,
            "authorization"
        );
        assert!(ordinary_path(&dir.path().join("file.txt:stream"), false).is_err());
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.txt"), b"outside").unwrap();
        let link = dir.path().join("link");
        let output = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(outside.path())
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(
            read_file("a", &link.join("secret.txt"), None)
                .unwrap_err()
                .code,
            "authorization"
        );
        assert!(ordinary_path(&link.join("new.txt"), false).is_err());
        fs::remove_dir(link).unwrap();
        assert_eq!(
            fs::read(outside.path().join("secret.txt")).unwrap(),
            b"outside"
        );
    }
    #[test]
    fn ordinary_globalroot_filename_is_not_a_device_namespace() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("globalroot-中文.txt");
        fs::write(&path, "普通文件😀").unwrap();
        let (file, _) = read_file("ordinary", &path, None).unwrap();
        assert_eq!(file.text, "普通文件😀");
        assert_eq!(
            ordinary_path(&dir.path().join("new-globalroot.txt"), false)
                .unwrap()
                .file_name()
                .unwrap(),
            "new-globalroot.txt"
        );
    }
}
