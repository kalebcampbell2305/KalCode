//! Content classification (text / image / document / binary), text decoding and budget
//! trimming.

use serde::{Deserialize, Serialize};

/// Bytes inspected to classify content.
pub const SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImageFormat {
    Png,
    Jpeg,
    Gif,
    Webp,
    Bmp,
}

impl ImageFormat {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Png => "image/png",
            Self::Jpeg => "image/jpeg",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Bmp => "image/bmp",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentFormat {
    Pdf,
    /// Office Open XML / OpenDocument and other ZIP containers.
    Zip,
}

impl DocumentFormat {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Pdf => "application/pdf",
            Self::Zip => "application/zip",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ContentClass {
    Text,
    Image { format: ImageFormat },
    Document { format: DocumentFormat },
    Binary,
}

/// Classifies by magic bytes, then by a text heuristic on the first [`SNIFF_BYTES`].
pub fn sniff(bytes: &[u8]) -> ContentClass {
    let head = &bytes[..bytes.len().min(SNIFF_BYTES)];
    if let Some(format) = image_format(head) {
        return ContentClass::Image { format };
    }
    if head.starts_with(b"%PDF-") {
        return ContentClass::Document {
            format: DocumentFormat::Pdf,
        };
    }
    if head.starts_with(b"PK\x03\x04") {
        return ContentClass::Document {
            format: DocumentFormat::Zip,
        };
    }
    if is_utf16_text(head) {
        return ContentClass::Text;
    }
    if head.contains(&0) {
        return ContentClass::Binary;
    }
    // Invalid UTF-8 (allowing a code point cut by the sniff window) means binary.
    match std::str::from_utf8(head) {
        Ok(text) => {
            if control_ratio(text) > 0.10 {
                ContentClass::Binary
            } else {
                ContentClass::Text
            }
        }
        Err(e) if e.error_len().is_none() && head.len() == SNIFF_BYTES => ContentClass::Text,
        Err(_) => ContentClass::Binary,
    }
}

fn image_format(head: &[u8]) -> Option<ImageFormat> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(ImageFormat::Png)
    } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(ImageFormat::Jpeg)
    } else if head.starts_with(b"GIF87a") || head.starts_with(b"GIF89a") {
        Some(ImageFormat::Gif)
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some(ImageFormat::Webp)
    } else if head.starts_with(b"BM") && head.len() >= 26 {
        Some(ImageFormat::Bmp)
    } else {
        None
    }
}

fn is_utf16_text(head: &[u8]) -> bool {
    head.starts_with(&[0xFF, 0xFE]) || head.starts_with(&[0xFE, 0xFF])
}

fn control_ratio(text: &str) -> f64 {
    let total = text.chars().count();
    if total == 0 {
        return 0.0;
    }
    let control = text
        .chars()
        .filter(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t' | '\u{0C}'))
        .count();
    control as f64 / total as f64
}

/// Decodes text content: UTF-8 (BOM stripped) or UTF-16 with a BOM. `None` for anything else.
pub fn decode_text(bytes: &[u8]) -> Option<String> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8(rest.to_vec()).ok();
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return decode_utf16(rest, u16::from_le_bytes);
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return decode_utf16(rest, u16::from_be_bytes);
    }
    String::from_utf8(bytes.to_vec()).ok()
}

fn decode_utf16(bytes: &[u8], read: fn([u8; 2]) -> u16) -> Option<String> {
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    let units: Vec<u16> = bytes.as_chunks::<2>().0.iter().map(|c| read(*c)).collect();
    String::from_utf16(&units).ok()
}

/// PNG width and height from the IHDR chunk, for image summaries.
pub fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24
        || image_format(bytes) != Some(ImageFormat::Png)
        || &bytes[12..16] != b"IHDR"
    {
        return None;
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Some((width, height))
}

/// Keeps the head and tail of `text` within `max_bytes` (line-aligned where possible) and
/// inserts a marker stating how much was omitted. Returns the text and the omitted byte count.
pub fn trim_head_tail(text: &str, max_bytes: usize) -> (String, usize) {
    if text.len() <= max_bytes {
        return (text.to_owned(), 0);
    }
    let marker_room = 64;
    let budget = max_bytes.saturating_sub(marker_room);
    let head_len = floor_boundary(text, budget / 2);
    let head_len = text[..head_len].rfind('\n').map_or(head_len, |i| i + 1);
    let tail_start = ceil_boundary(text, text.len().saturating_sub(budget - budget / 2));
    let tail_start = text[tail_start..]
        .find('\n')
        .map_or(tail_start, |i| (tail_start + i + 1).min(text.len()));
    let tail_start = tail_start.max(head_len);
    let omitted = tail_start - head_len;
    let mut out = String::with_capacity(max_bytes);
    out.push_str(&text[..head_len]);
    if !out.ends_with('\n') && !out.is_empty() {
        out.push('\n');
    }
    out.push_str(&format!(
        "[… {omitted} bytes omitted by KalCode to fit the context budget …]\n"
    ));
    out.push_str(&text[tail_start..]);
    (out, omitted)
}

/// Truncates to at most `max_bytes` on a char boundary.
pub fn truncate_on_boundary(text: &str, max_bytes: usize) -> &str {
    &text[..floor_boundary(text, max_bytes)]
}

fn floor_boundary(text: &str, index: usize) -> usize {
    let mut i = index.min(text.len());
    while !text.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(text: &str, index: usize) -> usize {
    let mut i = index.min(text.len());
    while !text.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Extensions that are binary without reading them (fast path for folder analysis).
pub fn is_known_binary_extension(name: &str) -> bool {
    const EXT: &[&str] = &[
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "icns", "tif", "tiff", "psd", "exe",
        "dll", "so", "dylib", "a", "lib", "o", "obj", "pdb", "class", "jar", "war", "zip", "gz",
        "tgz", "bz2", "xz", "7z", "rar", "zst", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4",
        "mov", "avi", "mkv", "wav", "flac", "ogg", "webm", "pdf", "doc", "docx", "xls", "xlsx",
        "ppt", "pptx", "sqlite", "sqlite3", "db", "wasm", "bin", "dat", "pyc", "node", "lockb",
        "iso", "dmg", "msi", "deb", "rpm",
    ];
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| EXT.contains(&ext.to_ascii_lowercase().as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniffs_formats() {
        assert_eq!(sniff(b"hello\nworld"), ContentClass::Text);
        assert_eq!(
            sniff(b"\x89PNG\r\n\x1a\n0000IHDR"),
            ContentClass::Image {
                format: ImageFormat::Png
            }
        );
        assert_eq!(
            sniff(b"%PDF-1.7"),
            ContentClass::Document {
                format: DocumentFormat::Pdf
            }
        );
        assert_eq!(sniff(b"MZ\x90\x00\x03\x00"), ContentClass::Binary);
        assert_eq!(sniff(&[0xFF, 0xFE, b'h', 0, b'i', 0]), ContentClass::Text);
        assert_eq!(
            decode_text(&[0xFF, 0xFE, b'h', 0, b'i', 0]).as_deref(),
            Some("hi")
        );
    }

    #[test]
    fn trims_keeping_head_and_tail() {
        let text: String = (0..1000).map(|i| format!("line {i}\n")).collect();
        let (trimmed, omitted) = trim_head_tail(&text, 1024);
        assert!(trimmed.len() <= 1024 + 80, "{}", trimmed.len());
        assert!(omitted > 0);
        assert!(trimmed.starts_with("line 0\n"));
        assert!(trimmed.ends_with("line 999\n"));
        assert!(trimmed.contains("bytes omitted"));
    }
}
