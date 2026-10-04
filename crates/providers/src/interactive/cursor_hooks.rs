//! Additive Cursor plugin: authenticated observing hooks, preserving native user plugins.
//! Schema: https://cursor.com/docs/hooks.md and /docs/reference/plugins.md (2026-10-04).
use std::ffi::OsString;
use std::path::Path;

use kalcode_contracts::agent::ProviderError;
use kalcode_hook_bridge::record::CURSOR_EVENTS;
use serde_json::json;

pub fn write_plugin(
    plugin_dir: &Path,
    helper: &Path,
    endpoint: &str,
    session: &str,
    helper_prefix_args: &[OsString],
) -> Result<(), ProviderError> {
    let mut hooks = serde_json::Map::new();
    for event in CURSOR_EVENTS {
        let args = std::iter::once(helper.as_os_str())
            .chain(helper_prefix_args.iter().map(OsString::as_os_str))
            .map(|value| {
                value.to_str().ok_or_else(|| {
                    ProviderError::Start("Cursor hook path must be valid Unicode.".into())
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let args = args
            .into_iter()
            .chain(["cursor", event, endpoint, session])
            .collect::<Vec<_>>();
        hooks.insert(
            (*event).into(),
            json!([{"command": command(&args)?, "timeout": 10}]),
        );
    }
    let metadata = plugin_dir.join(".cursor-plugin");
    let hook_dir = plugin_dir.join("hooks");
    let write = || -> std::io::Result<()> {
        std::fs::create_dir_all(&metadata)?;
        std::fs::create_dir_all(&hook_dir)?;
        std::fs::write(metadata.join("plugin.json"), json!({"name":"kalcode-session", "version":"1.0.0", "description":"KalCode coding terminal lifecycle"}).to_string())?;
        std::fs::write(
            hook_dir.join("hooks.json"),
            json!({"version":1,"hooks":hooks}).to_string(),
        )
    };
    write().map_err(|_| {
        ProviderError::Start("KalCode could not write the Cursor session plugin.".into())
    })
}

fn command(args: &[&str]) -> Result<String, ProviderError> {
    if args.iter().any(|arg| arg.chars().any(char::is_control)) {
        return Err(ProviderError::Start(
            "Cursor hook arguments contain unsupported control characters.".into(),
        ));
    }
    #[cfg(windows)]
    {
        // Cursor invokes cmd.exe /d /s /c on Windows. Encoding the PowerShell body avoids
        // cmd percent expansion and every shell metacharacter in user-owned installation paths.
        let quoted = args
            .iter()
            .map(|arg| format!("'{}'", arg.replace('\'', "''")))
            .collect::<Vec<_>>()
            .join(" ");
        let script = format!("& {quoted}; exit $LASTEXITCODE");
        let bytes = script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        Ok(format!(
            "powershell.exe -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand {}",
            base64(&bytes)
        ))
    }
    #[cfg(not(windows))]
    {
        Ok(args
            .iter()
            .map(|arg| format!("'{}'", arg.replace('\'', "'\\''")))
            .collect::<Vec<_>>()
            .join(" "))
    }
}

#[cfg(windows)]
fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut result = String::new();
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for index in 0..4 {
            result.push(if index > chunk.len() {
                '='
            } else {
                TABLE[((value >> (18 - index * 6)) & 63) as usize] as char
            });
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn additive_plugin_contains_only_observing_lifecycle_hooks() {
        let dir = tempfile::tempdir().unwrap();
        write_plugin(
            dir.path(),
            Path::new("/tools/helper ' & %.exe"),
            "endpoint",
            "session",
            &[],
        )
        .unwrap();
        let hooks: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("hooks/hooks.json")).unwrap())
                .unwrap();
        assert_eq!(
            hooks["hooks"].as_object().unwrap().len(),
            CURSOR_EVENTS.len()
        );
        assert!(hooks["hooks"].get("preToolUse").is_none());
        assert!(hooks["hooks"].get("beforeShellExecution").is_none());
        assert!(dir.path().join(".cursor-plugin/plugin.json").is_file());
    }
    #[cfg(windows)]
    #[test]
    fn windows_encoding_has_standard_padding() {
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        let value = command(&["C:\\a% b'&.exe", "arg"]).unwrap();
        assert!(!value.contains('%'));
        assert!(!value.contains('&'));
    }
}
