//! Live Browser page inspection and capture.
//!
//! The page helper (`browser_live.js`) runs inside untrusted Browser pages without any KalCode
//! capability. KalCode reads its snapshot back with a native script evaluation, so every value
//! here is page-controlled: it is parsed defensively, bounded and stripped of control and
//! bidirectional formatting characters before the trusted UI sees it.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Installed at document creation in every Browser page (main frame only).
pub const LIVE_SCRIPT: &str = include_str!("browser_live.js");

/// Reads the helper's snapshot and consumes the picked element, so each pick is reported once.
pub const INSPECT_SCRIPT: &str = "(() => { try { const live = window.__kalcodeLive; if (!live) return null; \
const snapshot = live.snapshot(); live.clearPicked(); return snapshot; } catch (_) { return null; } })()";

pub const START_PICK_SCRIPT: &str = "(() => { try { return !!(window.__kalcodeLive && window.__kalcodeLive.pick(true)); } catch (_) { return false; } })()";
pub const STOP_PICK_SCRIPT: &str = "(() => { try { return !!(window.__kalcodeLive && window.__kalcodeLive.pick(false)); } catch (_) { return false; } })()";

const MAX_ERRORS: usize = 8;
const MAX_ERROR_CHARS: usize = 300;
const MAX_SELECTOR_CHARS: usize = 400;
const MAX_TEXT_CHARS: usize = 160;
const MAX_HTML_CHARS: usize = 1200;
const MAX_TAG_CHARS: usize = 40;
/// Larger answers are not a snapshot from the helper; they are refused unread.
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024;
/// A pane screenshot is a few MB at most; anything larger is refused.
pub const MAX_PNG_BYTES: usize = 48 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInspection {
    /// False when the page has no helper (a browser error page, or a load still committing).
    pub available: bool,
    /// Errors seen since the page loaded (only the most recent are listed).
    pub error_count: u32,
    pub errors: Vec<String>,
    pub picking: bool,
    pub picked: Option<PickedElement>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedElement {
    pub selector: String,
    pub tag: String,
    pub text: String,
    pub html: String,
}

#[derive(Deserialize)]
struct RawSnapshot {
    total: Option<f64>,
    errors: Option<Vec<serde_json::Value>>,
    picking: Option<bool>,
    picked: Option<RawPicked>,
}

#[derive(Deserialize)]
struct RawPicked {
    selector: Option<serde_json::Value>,
    tag: Option<serde_json::Value>,
    text: Option<serde_json::Value>,
    html: Option<serde_json::Value>,
}

fn is_unsafe_format(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{061c}'
                | '\u{200e}'
                | '\u{200f}'
                | '\u{202a}'..='\u{202e}'
                | '\u{2066}'..='\u{2069}'
                | '\u{2028}'
                | '\u{2029}'
        )
}

/// Page text made inert: controls and bidi formatting become spaces, runs collapse, length bounded.
pub fn clean_text(value: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut count = 0;
    let mut space = false;
    for character in value.chars() {
        let character = if is_unsafe_format(character) || character.is_whitespace() {
            ' '
        } else {
            character
        };
        if character == ' ' {
            if space || out.is_empty() {
                continue;
            }
            space = true;
        } else {
            space = false;
        }
        if count >= max_chars {
            break;
        }
        count += 1;
        out.push(character);
    }
    out.trim_end().to_owned()
}

fn text_of(value: Option<&serde_json::Value>, max_chars: usize) -> String {
    value
        .and_then(serde_json::Value::as_str)
        .map(|text| clean_text(text, max_chars))
        .unwrap_or_default()
}

/// Parses the native evaluation answer, which JSON-encodes the helper's JSON string.
pub fn parse_inspection(answer: &str) -> BrowserInspection {
    if answer.len() > MAX_SNAPSHOT_BYTES * 2 {
        return BrowserInspection::default();
    }
    let Ok(Some(inner)) = serde_json::from_str::<Option<String>>(answer) else {
        return BrowserInspection::default();
    };
    if inner.len() > MAX_SNAPSHOT_BYTES {
        return BrowserInspection::default();
    }
    let Ok(raw) = serde_json::from_str::<RawSnapshot>(&inner) else {
        return BrowserInspection::default();
    };
    let errors: Vec<String> = raw
        .errors
        .unwrap_or_default()
        .iter()
        .rev()
        .take(MAX_ERRORS)
        .rev()
        .map(|value| match value {
            serde_json::Value::String(text) => clean_text(text, MAX_ERROR_CHARS),
            other => clean_text(&other.to_string(), MAX_ERROR_CHARS),
        })
        .filter(|text| !text.is_empty())
        .collect();
    let total = raw
        .total
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map_or(0, |value| value.min(f64::from(u32::MAX)) as u32);
    let picked = raw.picked.and_then(|picked| {
        let selector = text_of(picked.selector.as_ref(), MAX_SELECTOR_CHARS);
        if selector.is_empty() {
            return None;
        }
        let tag: String = text_of(picked.tag.as_ref(), MAX_TAG_CHARS)
            .chars()
            .filter(|character| character.is_ascii_alphanumeric() || *character == '-')
            .collect();
        Some(PickedElement {
            selector,
            tag,
            text: text_of(picked.text.as_ref(), MAX_TEXT_CHARS),
            html: text_of(picked.html.as_ref(), MAX_HTML_CHARS),
        })
    });
    BrowserInspection {
        available: true,
        error_count: total.max(u32::try_from(errors.len()).unwrap_or(u32::MAX)),
        errors,
        picking: raw.picking.unwrap_or(false),
        picked,
    }
}

pub fn is_png(bytes: &[u8]) -> bool {
    bytes.len() > PNG_SIGNATURE.len()
        && bytes.len() <= MAX_PNG_BYTES
        && bytes.starts_with(PNG_SIGNATURE)
}

/// "Live Browser localhost 2026-10-03 at 14.05.09.png": readable, sortable and filesystem-safe.
pub fn screenshot_file_name(host: &str, stamp: &str) -> String {
    let host: String = host
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-') {
                character
            } else {
                '-'
            }
        })
        .take(64)
        .collect();
    let host = host.trim_matches(['.', '-']);
    let host = if host.is_empty() { "page" } else { host };
    format!("Live Browser {host} {stamp}.png")
}

pub fn screenshot_stamp() -> String {
    let now = time::OffsetDateTime::now_local().unwrap_or_else(|_| time::OffsetDateTime::now_utc());
    format!(
        "{:04}-{:02}-{:02} at {:02}.{:02}.{:02}",
        now.year(),
        u8::from(now.month()),
        now.day(),
        now.hour(),
        now.minute(),
        now.second()
    )
}

/// The first free path for `file_name` in `directory` (" 2", " 3"… before the extension).
pub fn unique_path(directory: &Path, file_name: &str) -> PathBuf {
    let first = directory.join(file_name);
    if !first.exists() {
        return first;
    }
    let stem = file_name.strip_suffix(".png").unwrap_or(file_name);
    (2..1000)
        .map(|n| directory.join(format!("{stem} {n}.png")))
        .find(|path| !path.exists())
        .unwrap_or(first)
}

/// Captures the visible Browser child as PNG bytes (WebView2 `CapturePreview`).
#[cfg(windows)]
#[allow(unsafe_code)]
pub async fn capture_png(webview: &tauri::Webview) -> Result<Vec<u8>, &'static str> {
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG;
    use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    // SAFETY: called only from the completion handler, on the WebView2 UI thread that owns the
    // stream; the buffer is sized from the stream's own length and `Read` reports what it wrote.
    unsafe fn read_stream(stream: &IStream) -> windows_core::Result<Vec<u8>> {
        let mut stat = STATSTG::default();
        unsafe { stream.Stat(&mut stat, STATFLAG_NONAME)? };
        let length = usize::try_from(stat.cbSize).unwrap_or(usize::MAX);
        if length == 0 || length > MAX_PNG_BYTES {
            return Err(windows_core::Error::from(windows_core::HRESULT(
                0x8000_4005_u32 as i32,
            )));
        }
        unsafe { stream.Seek(0, STREAM_SEEK_SET, None)? };
        let mut buffer = vec![0_u8; length];
        let mut read = 0_u32;
        unsafe {
            stream
                .Read(
                    buffer.as_mut_ptr().cast(),
                    u32::try_from(length).unwrap_or(u32::MAX),
                    Some(&mut read),
                )
                .ok()?;
        }
        buffer.truncate(read as usize);
        Ok(buffer)
    }

    let (sender, receiver) = std::sync::mpsc::sync_channel::<Result<Vec<u8>, &'static str>>(1);
    webview
        .with_webview(move |platform| {
            let failure = sender.clone();
            // SAFETY: the controller and its CoreWebView2 are the live COM objects Tauri hands
            // to this closure on the WebView2 UI thread. The in-memory stream and the handler are
            // owned values; WebView2 keeps the handler alive until it completes.
            let started = unsafe {
                (|| -> windows_core::Result<()> {
                    let core = platform.controller().CoreWebView2()?;
                    let stream = SHCreateMemStream(None).ok_or_else(|| {
                        windows_core::Error::from(windows_core::HRESULT(0x8007_000E_u32 as i32))
                    })?;
                    let reader = stream.clone();
                    core.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                        &stream,
                        &CapturePreviewCompletedHandler::create(Box::new(move |result| {
                            let bytes = result.and_then(|()| read_stream(&reader));
                            let _ = sender.send(bytes.map_err(|_| "browser_screenshot_failed"));
                            Ok(())
                        })),
                    )
                })()
            };
            if started.is_err() {
                let _ = failure.send(Err("browser_screenshot_failed"));
            }
        })
        .map_err(|_| "browser_screenshot_failed")?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|_| "browser_screenshot_failed")?
    .map_err(|_| "browser_screenshot_timeout")?
}

/// Captures the visible Browser child as PNG bytes (`WKWebView takeSnapshot`).
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
pub async fn capture_png(webview: &tauri::Webview) -> Result<Vec<u8>, &'static str> {
    use block2::RcBlock;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    fn png_from(image: &NSImage) -> Option<Vec<u8>> {
        let tiff = image.TIFFRepresentation()?;
        let representation = NSBitmapImageRep::imageRepWithData(&tiff)?;
        // SAFETY: an empty properties dictionary is valid for every bitmap file type.
        let png = unsafe {
            representation.representationUsingType_properties(
                NSBitmapImageFileType::PNG,
                &NSDictionary::new(),
            )
        }?;
        Some(png.to_vec())
    }

    let (sender, receiver) = std::sync::mpsc::sync_channel::<Result<Vec<u8>, &'static str>>(1);
    webview
        .with_webview(move |platform| {
            // SAFETY: on macOS Tauri's platform webview is the live WKWebView, borrowed for this
            // main-thread closure. WebKit copies the completion block and calls it on the main
            // thread, where the NSImage it passes is valid for the duration of the call.
            unsafe {
                let view: &WKWebView = &*platform.inner().cast::<WKWebView>();
                let handler = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                    let bytes = image.as_ref().and_then(png_from);
                    let _ = sender.send(bytes.ok_or("browser_screenshot_failed"));
                });
                view.takeSnapshotWithConfiguration_completionHandler(None, &handler);
            }
        })
        .map_err(|_| "browser_screenshot_failed")?;
    tauri::async_runtime::spawn_blocking(move || {
        receiver.recv_timeout(std::time::Duration::from_secs(10))
    })
    .await
    .map_err(|_| "browser_screenshot_failed")?
    .map_err(|_| "browser_screenshot_timeout")?
}

#[cfg(not(any(windows, target_os = "macos")))]
pub async fn capture_png(_webview: &tauri::Webview) -> Result<Vec<u8>, &'static str> {
    Err("browser_screenshot_unsupported")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answer(snapshot: &serde_json::Value) -> String {
        serde_json::to_string(&snapshot.to_string()).unwrap()
    }

    #[test]
    fn helper_snapshot_is_parsed_bounded_and_made_inert() {
        let long = "x".repeat(5_000);
        let snapshot = serde_json::json!({
            "total": 12,
            "errors": ["one", "two\u{1b}[31m red", "three\nline", "four", "five", "six", "seven", "eight", "nine", long],
            "picking": false,
            "picked": {
                "selector": "main > button.cta\u{202e}",
                "tag": "button<script>",
                "text": "  Buy\n\tnow  ",
                "html": "<button class=\"cta\">Buy now</button>",
            },
        });
        let parsed = parse_inspection(&answer(&snapshot));
        assert!(parsed.available);
        assert_eq!(parsed.error_count, 12);
        assert_eq!(parsed.errors.len(), MAX_ERRORS);
        assert_eq!(parsed.errors[0], "three line");
        assert!(
            parsed
                .errors
                .iter()
                .all(|error| error.chars().count() <= MAX_ERROR_CHARS)
        );
        assert!(
            parsed
                .errors
                .iter()
                .all(|error| !error.chars().any(char::is_control))
        );
        let picked = parsed.picked.expect("picked element");
        assert_eq!(picked.selector, "main > button.cta");
        assert_eq!(picked.tag, "buttonscript");
        assert_eq!(picked.text, "Buy now");
    }

    #[test]
    fn foreign_or_missing_answers_are_unavailable_not_errors() {
        for answer in [
            "null",
            "",
            "{}",
            "\"not json\"",
            "42",
            "\"{\\\"errors\\\":5}\"",
        ] {
            let parsed = parse_inspection(answer);
            assert_eq!(parsed.error_count, 0, "{answer}");
            assert!(parsed.picked.is_none(), "{answer}");
        }
        assert!(!parse_inspection("null").available);
        let oversized = serde_json::to_string(&"a".repeat(MAX_SNAPSHOT_BYTES + 1)).unwrap();
        assert_eq!(parse_inspection(&oversized), BrowserInspection::default());
    }

    #[test]
    fn a_picked_element_without_a_selector_is_ignored() {
        let snapshot = serde_json::json!({ "total": 0, "errors": [], "picked": { "selector": "  ", "tag": "div" } });
        assert!(parse_inspection(&answer(&snapshot)).picked.is_none());
    }

    #[test]
    fn screenshot_names_are_filesystem_safe_and_unique() {
        assert_eq!(
            screenshot_file_name("localhost", "2026-10-03 at 14.05.09"),
            "Live Browser localhost 2026-10-03 at 14.05.09.png"
        );
        assert_eq!(
            screenshot_file_name("../evil/..\\x:y", "s"),
            "Live Browser evil-..-x-y s.png"
        );
        assert_eq!(screenshot_file_name("", "s"), "Live Browser page s.png");
        let directory = tempfile::tempdir().unwrap();
        let first = unique_path(directory.path(), "Live Browser a.png");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_path(directory.path(), "Live Browser a.png");
        assert_eq!(second, directory.path().join("Live Browser a 2.png"));
    }

    #[test]
    fn only_bounded_png_bytes_are_accepted() {
        assert!(is_png(b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR"));
        assert!(!is_png(b"\x89PNG\r\n\x1a\n"));
        assert!(!is_png(b"GIF89a......"));
    }
}
