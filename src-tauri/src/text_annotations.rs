//! 本机文本标注索引；仅存范围与正文摘要，不改动原文件。
use crate::{
    files::{version, Fault, Result},
    text_files::{path_key, TextFile},
};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Read, path::Path};

pub const INDEX_LIMIT: usize = 4 * 1024 * 1024;
pub const MARK_LIMIT: usize = 256;
pub const SESSION_MARK_LIMIT: usize = 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Color {
    Yellow,
    Green,
    Blue,
    Pink,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Highlight {
    pub from: usize,
    pub to: usize,
    pub color: Color,
}

pub fn validate(marks: &[Highlight], length: usize) -> Result<()> {
    let mut end = 0;
    if marks.len() > MARK_LIMIT
        || marks.iter().any(|mark| {
            let invalid = mark.from < end || mark.from >= mark.to || mark.to > length;
            end = mark.to;
            invalid
        })
    {
        return Err(Fault::new(
            "text-annotations",
            "文本标注范围无效或超过 256 处，原标注已保留。",
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Entry {
    pub body: String,
    pub length: usize,
    pub highlights: Vec<Highlight>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Index {
    schema: u8,
    pub entries: BTreeMap<String, Entry>,
    hash: String,
}
impl Default for Index {
    fn default() -> Self {
        Self {
            schema: 1,
            entries: BTreeMap::new(),
            hash: String::new(),
        }
    }
}
fn invalid() -> Fault {
    Fault::new(
        "text-annotations",
        "本机标注索引损坏或超限，原记录已保留，不能覆盖。",
    )
}
pub fn key(path: &Path) -> String {
    version(path_key(path).as_bytes())
}
fn digest(index: &Index) -> Result<String> {
    Ok(version(
        &serde_json::to_vec(&index.entries).map_err(|_| invalid())?,
    ))
}
pub fn load(root: &Path) -> Result<Index> {
    let file = match fs::File::open(root.join("annotations.json")) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Index::default()),
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.len() > INDEX_LIMIT as u64 {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(INDEX_LIMIT as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > INDEX_LIMIT {
        return Err(invalid());
    }
    let index: Index = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    if index.schema != 1 || index.entries.len() > 2048 || index.hash != digest(&index)? {
        return Err(invalid());
    }
    for (key, entry) in &index.entries {
        if [key, &entry.body]
            .iter()
            .any(|hash| hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()))
            || entry.length > crate::text_files::FILE_LIMIT
        {
            return Err(invalid());
        }
        validate(&entry.highlights, entry.length)?;
    }
    Ok(index)
}
pub fn encoded(mut index: Index) -> Result<Vec<u8>> {
    if index.entries.len() > 2048 {
        return Err(Fault::new(
            "text-annotations",
            "本机标注文件已达 2048 份，请先清除不再需要的标注。",
        ));
    }
    index.hash = digest(&index)?;
    let bytes = serde_json::to_vec(&index).map_err(|_| invalid())?;
    if bytes.len() > INDEX_LIMIT {
        return Err(Fault::new(
            "text-annotations",
            "本机标注索引超过 4 MiB，已有标注保持不变。",
        ));
    }
    Ok(bytes)
}
pub fn attach(root: &Path, mut file: TextFile) -> Result<TextFile> {
    if let Some(entry) = load(root)?.entries.get(&key(Path::new(&file.path))) {
        // 只在标准化正文完全相同时恢复位置；外部改动后不猜测重点落点。
        if entry.body == version(file.text.as_bytes())
            && entry.length == file.text.encode_utf16().count()
        {
            file.highlights = entry.highlights.clone();
        }
    }
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_overlaps_invalid_ranges_colors_and_corrupt_index() {
        assert!(validate(
            &[Highlight {
                from: 2,
                to: 1,
                color: Color::Yellow
            }],
            4
        )
        .is_err());
        assert!(validate(
            &[
                Highlight {
                    from: 0,
                    to: 3,
                    color: Color::Yellow
                },
                Highlight {
                    from: 2,
                    to: 4,
                    color: Color::Blue
                }
            ],
            4
        )
        .is_err());
        assert!(serde_json::from_str::<Highlight>(r#"{"from":0,"to":1,"color":"red"}"#).is_err());
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("annotations.json"), b"broken").unwrap();
        assert!(load(dir.path()).is_err());
        assert_eq!(
            fs::read(dir.path().join("annotations.json")).unwrap(),
            b"broken"
        );
    }
}
