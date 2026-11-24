//! 文本编码目录、严格转换与无 BOM 文件识别。
use crate::files::{Fault, Result};
use serde::{Deserialize, Serialize};

fn invalid() -> Fault {
    Fault::new(
        "encoding",
        "文件不符合所选编码。请使用“指定编码打开”或“以其他编码重新打开”。",
    )
}

fn bom(bytes: &[u8]) -> Option<(Encoding, usize)> {
    // UTF-32 LE 的前缀包含 UTF-16 LE 标记，必须先检查四字节标记。
    [
        (Encoding::Utf32Le, &[0xff, 0xfe, 0, 0][..]),
        (Encoding::Utf32Be, &[0, 0, 0xfe, 0xff][..]),
        (Encoding::Utf8Bom, &[0xef, 0xbb, 0xbf][..]),
        (Encoding::Utf16Le, &[0xff, 0xfe][..]),
        (Encoding::Utf16Be, &[0xfe, 0xff][..]),
    ]
    .into_iter()
    .find_map(|(encoding, mark)| bytes.starts_with(mark).then_some((encoding, mark.len())))
}

fn utf16(encoding: Encoding) -> Option<bool> {
    match encoding {
        Encoding::Utf16Le | Encoding::Utf16LeNoBom => Some(true),
        Encoding::Utf16Be | Encoding::Utf16BeNoBom => Some(false),
        _ => None,
    }
}

fn utf32(encoding: Encoding) -> Option<bool> {
    match encoding {
        Encoding::Utf32Le | Encoding::Utf32LeNoBom => Some(true),
        Encoding::Utf32Be | Encoding::Utf32BeNoBom => Some(false),
        _ => None,
    }
}

fn decode_raw(bytes: &[u8], encoding: Encoding) -> Result<String> {
    if let Some(little) = utf16(encoding) {
        if !bytes.len().is_multiple_of(2) {
            return Err(invalid());
        }
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| {
                if little {
                    u16::from_le_bytes(*b)
                } else {
                    u16::from_be_bytes(*b)
                }
            })
            .collect();
        return String::from_utf16(&units).map_err(|_| invalid());
    }
    if let Some(little) = utf32(encoding) {
        if !bytes.len().is_multiple_of(4) {
            return Err(invalid());
        }
        return bytes
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| {
                char::from_u32(if little {
                    u32::from_le_bytes(*b)
                } else {
                    u32::from_be_bytes(*b)
                })
                .ok_or_else(invalid)
            })
            .collect();
    }
    match encoding {
        Encoding::Utf8 | Encoding::Utf8Bom => std::str::from_utf8(bytes)
            .map(str::to_owned)
            .map_err(|_| invalid()),
        Encoding::Ascii if bytes.is_ascii() => Ok(bytes.iter().map(|b| *b as char).collect()),
        Encoding::Latin1 => Ok(bytes.iter().map(|b| *b as char).collect()),
        _ => {
            let codec = encoding.legacy().ok_or_else(invalid)?;
            let text = codec
                .decode_without_bom_handling_and_without_replacement(bytes)
                .ok_or_else(invalid)?;
            // GBK 解码器兼容 GB18030，但手动选择 GBK 时只接受其可表示的字符。
            if encoding == Encoding::Gbk && codec.encode(&text).2 {
                return Err(invalid());
            }
            Ok(text.into_owned())
        }
    }
}

fn plausible_text(text: &str) -> bool {
    !text.chars().any(|c| {
        c == '\0'
            || (c.is_control()
                && !matches!(
                    c,
                    '\n' | '\r'
                        | '\t'
                        | '\u{b}'
                        | '\u{c}'
                        | '\u{8}'
                        | '\u{1b}'
                        | '\u{1a}'
                        | '\u{85}'
                ))
    })
}

pub fn decode(bytes: &[u8], requested: Option<Encoding>) -> Result<(String, Encoding)> {
    let (text, encoding) = if let Some(mut encoding) = requested {
        let payload = if let Some((marked, length)) = bom(bytes) {
            let compatible = marked == encoding
                || (matches!(marked, Encoding::Utf8Bom) && matches!(encoding, Encoding::Utf8))
                || (utf16(marked).is_some() && utf16(marked) == utf16(encoding))
                || (utf32(marked).is_some() && utf32(marked) == utf32(encoding));
            if !compatible {
                return Err(invalid());
            }
            encoding = marked;
            &bytes[length..]
        } else {
            encoding = match encoding {
                Encoding::Utf8Bom => Encoding::Utf8,
                Encoding::Utf16Le => Encoding::Utf16LeNoBom,
                Encoding::Utf16Be => Encoding::Utf16BeNoBom,
                Encoding::Utf32Le => Encoding::Utf32LeNoBom,
                Encoding::Utf32Be => Encoding::Utf32BeNoBom,
                value => value,
            };
            bytes
        };
        (decode_raw(payload, encoding)?, encoding)
    } else if let Some((encoding, length)) = bom(bytes) {
        (decode_raw(&bytes[length..], encoding)?, encoding)
    } else if let Some(value) = detect_wide(bytes) {
        value
    } else if let Ok(text) = std::str::from_utf8(bytes) {
        // ISO-2022-JP 的转义序列本身也是合法 ASCII，不能在此误报 UTF-8。
        if bytes
            .windows(3)
            .any(|b| matches!(b, b"\x1b$B" | b"\x1b$@" | b"\x1b(B" | b"\x1b(J"))
        {
            (decode_raw(bytes, Encoding::Iso2022Jp)?, Encoding::Iso2022Jp)
        } else {
            (text.to_owned(), Encoding::Utf8)
        }
    } else {
        let mut detector = chardetng::EncodingDetector::new();
        detector.feed(bytes, true);
        let guessed = detector.guess(None, false);
        let mut encoding = Encoding::from_legacy(guessed).ok_or_else(invalid)?;
        if encoding == Encoding::Gbk && decode_raw(bytes, encoding).is_err() {
            encoding = Encoding::Gb18030;
        }
        (decode_raw(bytes, encoding)?, encoding)
    };
    if !plausible_text(&text) {
        return Err(Fault::new(
            "binary",
            "文件含空字符或二进制控制字符，不能作为文本打开；若是无 BOM 文本，请指定正确编码。",
        ));
    }
    Ok((text, encoding))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_catalog_covers_every_supported_wire_encoding() {
        let mut count = 0;
        for line in include_str!("../../src/text-encodings.ts")
            .lines()
            .filter(|line| line.starts_with(" ['"))
        {
            let id = line.split('\'').nth(1).unwrap();
            let encoding: Encoding = serde_json::from_value(serde_json::json!(id)).unwrap();
            let bytes = encode("Text example\n", encoding).unwrap();
            assert_eq!(
                decode(&bytes, Some(encoding)).unwrap(),
                ("Text example\n".into(), encoding),
                "{id}"
            );
            count += 1;
        }
        assert_eq!(count, 47);
    }

    #[test]
    fn unicode_bom_endianness_and_bomless_detection() {
        for encoding in [
            Encoding::Utf8,
            Encoding::Utf8Bom,
            Encoding::Utf16Le,
            Encoding::Utf16Be,
            Encoding::Utf16LeNoBom,
            Encoding::Utf16BeNoBom,
            Encoding::Utf32Le,
            Encoding::Utf32Be,
            Encoding::Utf32LeNoBom,
            Encoding::Utf32BeNoBom,
        ] {
            let text = "Hello world! 中文😀\n第二行\n";
            let bytes = encode(text, encoding).unwrap();
            assert_eq!(
                decode(&bytes, None).unwrap(),
                (text.into(), encoding),
                "{encoding:?}"
            );
            assert_eq!(
                encode(&decode(&bytes, None).unwrap().0, encoding).unwrap(),
                bytes
            );
        }
        assert_eq!(
            decode(&[0xff, 0xfe, 0, 0], None).unwrap(),
            (String::new(), Encoding::Utf32Le)
        );
        assert_eq!(
            decode(&[0, 0, 0xfe, 0xff], None).unwrap(),
            (String::new(), Encoding::Utf32Be)
        );
        assert_eq!(
            decode(&[0xef, 0xbb, 0xbf, b'A'], Some(Encoding::Utf8))
                .unwrap()
                .1,
            Encoding::Utf8Bom
        );
        assert_eq!(
            decode(b"A\0", Some(Encoding::Utf16Le)).unwrap().1,
            Encoding::Utf16LeNoBom
        );
    }

    #[test]
    fn fixed_legacy_fixtures_and_automatic_chinese_detection() {
        for (bytes, encoding, text) in [
            (&[0xd6, 0xd0, 0xce, 0xc4][..], Encoding::Gbk, "中文"),
            (&[0xa4, 0xa4, 0xa4, 0xe5][..], Encoding::Big5, "中文"),
            (&[0x93, 0xfa, 0x96, 0x7b][..], Encoding::ShiftJis, "日本"),
            (&[0xc6, 0xfc, 0xcb, 0xdc][..], Encoding::EucJp, "日本"),
            (&[0xc7, 0xd1, 0xb1, 0xdb][..], Encoding::EucKr, "한글"),
            (&[0x80, 0x20, 0xe9][..], Encoding::Windows1252, "€ é"),
            (&[0xe9][..], Encoding::Latin1, "é"),
        ] {
            assert_eq!(decode(bytes, Some(encoding)).unwrap().0, text);
            assert_eq!(encode(text, encoding).unwrap(), bytes);
        }
        for encoding in [Encoding::Gbk, Encoding::Gb18030, Encoding::Big5] {
            let text = if encoding == Encoding::Gb18030 {
                "中文编码测试，打开文件并保存内容。😀"
            } else {
                "中文文件內容，文字編輯測試。"
            };
            let bytes = encode(text, encoding).unwrap();
            let (decoded, _) = decode(&bytes, None).unwrap();
            assert_eq!(decoded, text, "{encoding:?}");
        }
        let text = "日本語の文字コードを読み込みます。";
        for encoding in [Encoding::ShiftJis, Encoding::EucJp, Encoding::Iso2022Jp] {
            assert_eq!(
                decode(&encode(text, encoding).unwrap(), None).unwrap().0,
                text,
                "{encoding:?}"
            );
        }
    }

    #[test]
    fn malformed_sequences_and_lossy_conversions_are_rejected() {
        for (bytes, encoding) in [
            (&[0x81][..], Encoding::Gbk),
            (&[0xff][..], Encoding::Utf8),
            (&[0x41][..], Encoding::Utf16LeNoBom),
            (&[0, 0xd8][..], Encoding::Utf16LeNoBom),
            (&[0, 0, 0x11, 0][..], Encoding::Utf32LeNoBom),
            (&[0, 0xd8, 0, 0][..], Encoding::Utf32LeNoBom),
        ] {
            assert_eq!(decode(bytes, Some(encoding)).unwrap_err().code, "encoding");
        }
        for encoding in [
            Encoding::Gbk,
            Encoding::Big5,
            Encoding::ShiftJis,
            Encoding::Windows1252,
            Encoding::Ascii,
            Encoding::Latin1,
        ] {
            assert_eq!(encode("😀", encoding).unwrap_err().code, "encoding-loss");
        }
        assert_eq!(
            encode("¥", Encoding::ShiftJis).unwrap_err().code,
            "encoding-loss"
        );
        assert!(decode(&[0xef, 0xbb, 0xbf, 0xff], None).is_err());
        assert!(decode(&[0xff, 0xfe, 0, 0xd8], None).is_err());
        assert!(decode(&[0, 0, 0, 0], None).is_err());
        assert!(decode(&[1, 2, 3, 4], Some(Encoding::Latin1)).is_err());
        assert_eq!(
            decode(b"\x1b[31mERROR\x1b[0m\n", None).unwrap().0,
            "\x1b[31mERROR\x1b[0m\n"
        );
        assert!(decode(&[0xef, 0xbb, 0xbf, b'A'], Some(Encoding::Gbk)).is_err());
    }
}

fn detect_wide(bytes: &[u8]) -> Option<(String, Encoding)> {
    if !bytes.contains(&0) {
        return None;
    }
    for encoding in [
        Encoding::Utf32LeNoBom,
        Encoding::Utf32BeNoBom,
        Encoding::Utf16LeNoBom,
        Encoding::Utf16BeNoBom,
    ] {
        let width = if utf32(encoding).is_some() { 4 } else { 2 };
        if bytes.len() < width * 2 || !bytes.len().is_multiple_of(width) {
            continue;
        }
        let sample = &bytes[..bytes.len().min(4096)];
        let chunks = sample.chunks_exact(width);
        let count = chunks.len();
        let little = utf32(encoding).or_else(|| utf16(encoding)).unwrap();
        let zero_index = if little { width - 1 } else { 0 };
        if chunks.filter(|chunk| chunk[zero_index] == 0).count() * 5 < count * 3 {
            continue;
        }
        if let Ok(text) = decode_raw(bytes, encoding) {
            if plausible_text(&text) {
                return Some((text, encoding));
            }
        }
    }
    None
}

pub fn encode(text: &str, encoding: Encoding) -> Result<Vec<u8>> {
    let mut bytes = match encoding {
        Encoding::Utf8Bom => vec![0xef, 0xbb, 0xbf],
        Encoding::Utf16Le => vec![0xff, 0xfe],
        Encoding::Utf16Be => vec![0xfe, 0xff],
        Encoding::Utf32Le => vec![0xff, 0xfe, 0, 0],
        Encoding::Utf32Be => vec![0, 0, 0xfe, 0xff],
        _ => Vec::new(),
    };
    let loss = || {
        Fault::new("encoding-loss", "当前编码无法无损表示部分字符，原文件未写入。请选择 UTF-8、UTF-16、UTF-32 或 GB18030 后再保存。")
    };
    if let Some(little) = utf16(encoding) {
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&if little {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
    } else if let Some(little) = utf32(encoding) {
        for c in text.chars() {
            bytes.extend_from_slice(&if little {
                (c as u32).to_le_bytes()
            } else {
                (c as u32).to_be_bytes()
            });
        }
    } else {
        match encoding {
            Encoding::Utf8 | Encoding::Utf8Bom => bytes.extend_from_slice(text.as_bytes()),
            Encoding::Ascii | Encoding::Latin1 => {
                let limit = if encoding == Encoding::Ascii {
                    0x7f
                } else {
                    0xff
                };
                for c in text.chars() {
                    if c as u32 > limit {
                        return Err(loss());
                    }
                    bytes.push(c as u8);
                }
            }
            _ => {
                let codec = encoding.legacy().ok_or_else(invalid)?;
                let (output, _, errors) = codec.encode(text);
                // 同时检查反向转换，避免日元符号等兼容映射在保存后改变正文。
                if errors
                    || codec
                        .decode_without_bom_handling_and_without_replacement(&output)
                        .as_deref()
                        != Some(text)
                {
                    return Err(loss());
                }
                bytes.extend_from_slice(&output);
            }
        }
    }
    Ok(bytes)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Encoding {
    #[serde(rename = "utf8")]
    Utf8,
    #[serde(rename = "utf8-bom")]
    Utf8Bom,
    #[serde(rename = "utf16le")]
    Utf16Le,
    #[serde(rename = "utf16be")]
    Utf16Be,
    #[serde(rename = "utf16le-nobom")]
    Utf16LeNoBom,
    #[serde(rename = "utf16be-nobom")]
    Utf16BeNoBom,
    #[serde(rename = "utf32le")]
    Utf32Le,
    #[serde(rename = "utf32be")]
    Utf32Be,
    #[serde(rename = "utf32le-nobom")]
    Utf32LeNoBom,
    #[serde(rename = "utf32be-nobom")]
    Utf32BeNoBom,
    #[serde(rename = "ascii")]
    Ascii,
    #[serde(rename = "iso-8859-1")]
    Latin1,
    #[serde(rename = "gbk")]
    Gbk,
    #[serde(rename = "gb18030")]
    Gb18030,
    #[serde(rename = "big5")]
    Big5,
    #[serde(rename = "shift-jis")]
    ShiftJis,
    #[serde(rename = "euc-jp")]
    EucJp,
    #[serde(rename = "iso-2022-jp")]
    Iso2022Jp,
    #[serde(rename = "euc-kr")]
    EucKr,
    #[serde(rename = "windows-1250")]
    Windows1250,
    #[serde(rename = "windows-1251")]
    Windows1251,
    #[serde(rename = "windows-1252")]
    Windows1252,
    #[serde(rename = "windows-1253")]
    Windows1253,
    #[serde(rename = "windows-1254")]
    Windows1254,
    #[serde(rename = "windows-1255")]
    Windows1255,
    #[serde(rename = "windows-1256")]
    Windows1256,
    #[serde(rename = "windows-1257")]
    Windows1257,
    #[serde(rename = "windows-1258")]
    Windows1258,
    #[serde(rename = "iso-8859-2")]
    Iso88592,
    #[serde(rename = "iso-8859-3")]
    Iso88593,
    #[serde(rename = "iso-8859-4")]
    Iso88594,
    #[serde(rename = "iso-8859-5")]
    Iso88595,
    #[serde(rename = "iso-8859-6")]
    Iso88596,
    #[serde(rename = "iso-8859-7")]
    Iso88597,
    #[serde(rename = "iso-8859-8")]
    Iso88598,
    #[serde(rename = "iso-8859-10")]
    Iso885910,
    #[serde(rename = "iso-8859-13")]
    Iso885913,
    #[serde(rename = "iso-8859-14")]
    Iso885914,
    #[serde(rename = "iso-8859-15")]
    Iso885915,
    #[serde(rename = "iso-8859-16")]
    Iso885916,
    #[serde(rename = "iso-8859-8-i")]
    Iso88598I,
    #[serde(rename = "koi8-r")]
    Koi8R,
    #[serde(rename = "koi8-u")]
    Koi8U,
    #[serde(rename = "ibm866")]
    Ibm866,
    #[serde(rename = "macintosh")]
    Macintosh,
    #[serde(rename = "x-mac-cyrillic")]
    MacCyrillic,
    #[serde(rename = "windows-874")]
    Windows874,
}

impl Encoding {
    fn legacy(self) -> Option<&'static encoding_rs::Encoding> {
        match self {
            Self::Gbk => Some(encoding_rs::GBK),
            Self::Gb18030 => Some(encoding_rs::GB18030),
            Self::Big5 => Some(encoding_rs::BIG5),
            Self::ShiftJis => Some(encoding_rs::SHIFT_JIS),
            Self::EucJp => Some(encoding_rs::EUC_JP),
            Self::Iso2022Jp => Some(encoding_rs::ISO_2022_JP),
            Self::EucKr => Some(encoding_rs::EUC_KR),
            Self::Windows1250 => Some(encoding_rs::WINDOWS_1250),
            Self::Windows1251 => Some(encoding_rs::WINDOWS_1251),
            Self::Windows1252 => Some(encoding_rs::WINDOWS_1252),
            Self::Windows1253 => Some(encoding_rs::WINDOWS_1253),
            Self::Windows1254 => Some(encoding_rs::WINDOWS_1254),
            Self::Windows1255 => Some(encoding_rs::WINDOWS_1255),
            Self::Windows1256 => Some(encoding_rs::WINDOWS_1256),
            Self::Windows1257 => Some(encoding_rs::WINDOWS_1257),
            Self::Windows1258 => Some(encoding_rs::WINDOWS_1258),
            Self::Iso88592 => Some(encoding_rs::ISO_8859_2),
            Self::Iso88593 => Some(encoding_rs::ISO_8859_3),
            Self::Iso88594 => Some(encoding_rs::ISO_8859_4),
            Self::Iso88595 => Some(encoding_rs::ISO_8859_5),
            Self::Iso88596 => Some(encoding_rs::ISO_8859_6),
            Self::Iso88597 => Some(encoding_rs::ISO_8859_7),
            Self::Iso88598 => Some(encoding_rs::ISO_8859_8),
            Self::Iso885910 => Some(encoding_rs::ISO_8859_10),
            Self::Iso885913 => Some(encoding_rs::ISO_8859_13),
            Self::Iso885914 => Some(encoding_rs::ISO_8859_14),
            Self::Iso885915 => Some(encoding_rs::ISO_8859_15),
            Self::Iso885916 => Some(encoding_rs::ISO_8859_16),
            Self::Iso88598I => Some(encoding_rs::ISO_8859_8_I),
            Self::Koi8R => Some(encoding_rs::KOI8_R),
            Self::Koi8U => Some(encoding_rs::KOI8_U),
            Self::Ibm866 => Some(encoding_rs::IBM866),
            Self::Macintosh => Some(encoding_rs::MACINTOSH),
            Self::MacCyrillic => Some(encoding_rs::X_MAC_CYRILLIC),
            Self::Windows874 => Some(encoding_rs::WINDOWS_874),
            _ => None,
        }
    }

    fn from_legacy(value: &'static encoding_rs::Encoding) -> Option<Self> {
        if value == encoding_rs::GBK {
            return Some(Self::Gbk);
        }
        if value == encoding_rs::GB18030 {
            return Some(Self::Gb18030);
        }
        if value == encoding_rs::BIG5 {
            return Some(Self::Big5);
        }
        if value == encoding_rs::SHIFT_JIS {
            return Some(Self::ShiftJis);
        }
        if value == encoding_rs::EUC_JP {
            return Some(Self::EucJp);
        }
        if value == encoding_rs::ISO_2022_JP {
            return Some(Self::Iso2022Jp);
        }
        if value == encoding_rs::EUC_KR {
            return Some(Self::EucKr);
        }
        if value == encoding_rs::WINDOWS_1250 {
            return Some(Self::Windows1250);
        }
        if value == encoding_rs::WINDOWS_1251 {
            return Some(Self::Windows1251);
        }
        if value == encoding_rs::WINDOWS_1252 {
            return Some(Self::Windows1252);
        }
        if value == encoding_rs::WINDOWS_1253 {
            return Some(Self::Windows1253);
        }
        if value == encoding_rs::WINDOWS_1254 {
            return Some(Self::Windows1254);
        }
        if value == encoding_rs::WINDOWS_1255 {
            return Some(Self::Windows1255);
        }
        if value == encoding_rs::WINDOWS_1256 {
            return Some(Self::Windows1256);
        }
        if value == encoding_rs::WINDOWS_1257 {
            return Some(Self::Windows1257);
        }
        if value == encoding_rs::WINDOWS_1258 {
            return Some(Self::Windows1258);
        }
        if value == encoding_rs::ISO_8859_2 {
            return Some(Self::Iso88592);
        }
        if value == encoding_rs::ISO_8859_3 {
            return Some(Self::Iso88593);
        }
        if value == encoding_rs::ISO_8859_4 {
            return Some(Self::Iso88594);
        }
        if value == encoding_rs::ISO_8859_5 {
            return Some(Self::Iso88595);
        }
        if value == encoding_rs::ISO_8859_6 {
            return Some(Self::Iso88596);
        }
        if value == encoding_rs::ISO_8859_7 {
            return Some(Self::Iso88597);
        }
        if value == encoding_rs::ISO_8859_8 {
            return Some(Self::Iso88598);
        }
        if value == encoding_rs::ISO_8859_10 {
            return Some(Self::Iso885910);
        }
        if value == encoding_rs::ISO_8859_13 {
            return Some(Self::Iso885913);
        }
        if value == encoding_rs::ISO_8859_14 {
            return Some(Self::Iso885914);
        }
        if value == encoding_rs::ISO_8859_15 {
            return Some(Self::Iso885915);
        }
        if value == encoding_rs::ISO_8859_16 {
            return Some(Self::Iso885916);
        }
        if value == encoding_rs::ISO_8859_8_I {
            return Some(Self::Iso88598I);
        }
        if value == encoding_rs::KOI8_R {
            return Some(Self::Koi8R);
        }
        if value == encoding_rs::KOI8_U {
            return Some(Self::Koi8U);
        }
        if value == encoding_rs::IBM866 {
            return Some(Self::Ibm866);
        }
        if value == encoding_rs::MACINTOSH {
            return Some(Self::Macintosh);
        }
        if value == encoding_rs::X_MAC_CYRILLIC {
            return Some(Self::MacCyrillic);
        }
        if value == encoding_rs::WINDOWS_874 {
            return Some(Self::Windows874);
        }
        None
    }
}
