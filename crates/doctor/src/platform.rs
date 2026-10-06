//! Small, read-only platform facts the Doctor needs that no other KalCode system provides.

/// Whether Windows allows paths longer than 260 characters (`LongPathsEnabled`).
/// `Ok(None)` outside Windows (no such limit).
pub fn long_paths_enabled() -> Result<Option<bool>, String> {
    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
        let key = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Control\FileSystem", KEY_READ)
            .map_err(|e| {
                format!("Windows didn't let KalCode read the file-system settings ({e}).")
            })?;
        match key.get_value::<u32, _>("LongPathsEnabled") {
            Ok(value) => Ok(Some(value == 1)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Some(false)),
            Err(e) => Err(format!(
                "Windows didn't let KalCode read LongPathsEnabled ({e})."
            )),
        }
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

/// The operating system, for display: (name and edition, version, build number if any).
pub fn os_summary() -> (String, String, Option<u64>) {
    let info = os_info::get();
    let name = match info.edition() {
        Some(edition) => edition.to_owned(),
        None => info.os_type().to_string(),
    };
    let version = info.version().to_string();
    let build = build_number(&version, cfg!(windows));
    (name, version, build)
}

/// Windows versions read "10.0.26200": the third part is the build. Elsewhere the third part is
/// a patch level (macOS "15.1.0"), not a build number.
fn build_number(version: &str, windows: bool) -> Option<u64> {
    if !windows {
        return None;
    }
    version
        .split('.')
        .nth(2)
        .and_then(|b| b.parse::<u64>().ok())
}

#[cfg(test)]
mod tests {
    use super::build_number;

    #[test]
    fn only_windows_versions_carry_a_build_number() {
        assert_eq!(build_number("10.0.26200", true), Some(26200));
        assert_eq!(build_number("15.1.0", false), None, "macOS 15.1.0 is not build 0");
        assert_eq!(build_number("6.8.12", false), None);
    }
}
