//! The system: OS build, long-path support, PATH sanity, shells, memory and disk.

use std::ffi::OsStr;
use std::path::Path;

use super::{CheckDef, CheckOutput, FindingExt, bytes, count, def, finding, show_command};
use crate::context::{MicrophonePermissionState, RunContext, VolumeRole, volume};
use crate::platform;
use crate::types::{DoctorArea, FindingSeverity};

/// Available memory below which the system is short on memory.
pub const MEMORY_LOW: u64 = 1024 * 1024 * 1024;
/// Free space below which the system or project drive is low.
pub const DISK_LOW: u64 = 5 * 1024 * 1024 * 1024;
pub const DISK_CRITICAL: u64 = 1024 * 1024 * 1024;
/// The oldest Windows 10 build KalCode supports (20H1).
pub const WINDOWS_MINIMUM_BUILD: u64 = 19041;

const LONG_PATHS_COMMAND: &str = "New-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name 'LongPathsEnabled' -Value 1 -PropertyType DWord -Force";
const NO_CWD_SEARCH_COMMAND: &str =
    "[Environment]::SetEnvironmentVariable('NoDefaultCurrentDirectoryInExePath', '1', 'User')";

pub fn checks() -> Vec<CheckDef> {
    vec![
        def("system.os", DoctorArea::System, "Operating system", os),
        def(
            "system.long_paths",
            DoctorArea::System,
            "Long file paths",
            long_paths,
        ),
        def("system.path", DoctorArea::System, "PATH", path),
        def("system.shells", DoctorArea::System, "Shells", shells),
        def(
            "system.microphone_permission",
            DoctorArea::System,
            "Microphone permission",
            microphone_permission,
        ),
        def("system.memory", DoctorArea::System, "Memory", memory),
        def("system.disk", DoctorArea::System, "Disk space", disk),
    ]
}

fn microphone_permission(ctx: &RunContext) -> CheckOutput {
    let Some(source) = &ctx.microphone_permission else {
        return CheckOutput::skipped(
            "Microphone permission status isn't available on this platform.",
        );
    };
    microphone_permission_output(source.current())
}

fn microphone_permission_output(state: MicrophonePermissionState) -> CheckOutput {
    match state {
        MicrophonePermissionState::Granted => CheckOutput::passed("Granted"),
        MicrophonePermissionState::Denied => CheckOutput::with(
            "Denied",
            vec![finding(
                "system.microphone_permission.denied",
                FindingSeverity::Warning,
                "Microphone access is denied",
                "KalVoice can't listen while microphone access is denied. Open System Settings > Privacy & Security > Microphone, allow KalCode, then run this check again.",
            )],
        ),
        MicrophonePermissionState::NotDetermined => CheckOutput::with(
            "Not requested",
            vec![finding(
                "system.microphone_permission.not_determined",
                FindingSeverity::Info,
                "Microphone permission hasn't been requested",
                "Start KalVoice push to talk when you're ready to use it. macOS will ask for microphone access then; Environment Doctor only reads the current status and does not open the microphone or show the permission prompt.",
            )],
        ),
        MicrophonePermissionState::Unknown => CheckOutput::with(
            "Couldn't determine",
            vec![finding(
                "system.microphone_permission.unknown",
                FindingSeverity::Info,
                "Microphone permission couldn't be determined",
                "Open System Settings > Privacy & Security > Microphone to verify KalCode's access, then run this check again. Environment Doctor did not request access or open the microphone.",
            )],
        ),
        MicrophonePermissionState::Unsupported => {
            CheckOutput::skipped("Microphone permission status isn't available on this platform.")
        }
    }
}

fn os(ctx: &RunContext) -> CheckOutput {
    let (name, version, build) = platform::os_summary();
    let summary = match build {
        Some(build) => format!("{name} (build {build})"),
        None => format!("{name} {version}"),
    };
    match build {
        Some(build) if ctx.host.windows && build < WINDOWS_MINIMUM_BUILD => CheckOutput::with(
            summary,
            vec![
                finding(
                    "system.os.old",
                    FindingSeverity::Warning,
                    "This Windows version is older than KalCode supports",
                    "KalCode is tested on Windows 10 version 2004 (build 19041) and later. Windows Update can bring this computer up to date.",
                )
                .detail("Version", &version),
            ],
        ),
        _ => CheckOutput::passed(summary),
    }
}

fn long_paths(ctx: &RunContext) -> CheckOutput {
    if !ctx.host.windows {
        return CheckOutput::skipped("Only Windows limits path length.");
    }
    match platform::long_paths_enabled() {
        Ok(Some(true)) => CheckOutput::passed("Enabled"),
        Ok(Some(false)) => CheckOutput::with(
            "Off",
            vec![
                finding(
                    "system.long_paths.off",
                    FindingSeverity::Info,
                    "Long file paths are turned off",
                    "Windows limits most programs to paths of 260 characters. Deep dependency folders (node_modules, build output) can go past that and fail to install or delete. Turning long paths on needs an administrator and takes effect for programs started afterwards.",
                )
                .fix(show_command(
                    "show.long_paths",
                    "Show the command",
                    "Shows the administrator command that turns long paths on. KalCode doesn't change system settings.",
                    LONG_PATHS_COMMAND.to_owned(),
                    "An administrator PowerShell",
                )),
            ],
        ),
        Ok(None) => CheckOutput::skipped("Only Windows limits path length."),
        Err(why) => CheckOutput::could_not_check(why),
    }
}

/// What PATH sanity found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PathReport {
    pub entries: usize,
    /// Entries that aren't absolute: they resolve against whatever folder a program runs in.
    pub relative: Vec<String>,
    pub missing: Vec<String>,
    pub duplicates: Vec<String>,
}

/// Classifies the entries of a PATH value.
pub fn analyze_path(value: &OsStr, windows: bool) -> PathReport {
    let mut report = PathReport::default();
    let mut seen: Vec<String> = Vec::new();
    for entry in std::env::split_paths(value) {
        let text = entry.to_string_lossy().into_owned();
        if text.trim().is_empty() {
            report.relative.push("(an empty entry)".into());
            continue;
        }
        report.entries += 1;
        if !is_absolute(&entry) || text.contains('%') {
            report.relative.push(text);
            continue;
        }
        let key = normalize(&text, windows);
        if seen.contains(&key) {
            if !report.duplicates.contains(&text) {
                report.duplicates.push(text);
            }
            continue;
        }
        seen.push(key);
        if !entry.is_dir() {
            report.missing.push(text);
        }
    }
    report
}

fn is_absolute(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.is_absolute()
}

fn normalize(text: &str, windows: bool) -> String {
    let trimmed = text.trim_end_matches(['\\', '/']);
    if windows {
        trimmed.to_ascii_lowercase().replace('/', "\\")
    } else {
        trimmed.to_owned()
    }
}

fn path(ctx: &RunContext) -> CheckOutput {
    let host = &ctx.host;
    let Some(value) = host.var("PATH") else {
        return CheckOutput::with(
            "Not set",
            vec![finding(
                "system.path.empty",
                FindingSeverity::Warning,
                "PATH isn't set",
                "Without PATH, terminals and provider CLIs can't find programs by name.",
            )],
        );
    };
    let report = analyze_path(value, host.windows);
    let mut findings = Vec::new();
    if !report.relative.is_empty() {
        findings.push(
            finding(
                "system.path.relative",
                FindingSeverity::Warning,
                "PATH has entries that depend on the current folder",
                "Entries that aren't full paths (like \".\" or \"bin\") are looked up in whatever folder a command runs in. Opening a downloaded repository could then run a program it contains instead of the real one. KalCode skips these entries for everything it starts; remove them from PATH to protect your terminals too.",
            )
            .detail("Entries", report.relative.len().to_string())
            .subjects(report.relative.clone()),
        );
    }
    if !report.missing.is_empty() {
        findings.push(
            finding(
                "system.path.missing",
                FindingSeverity::Info,
                "PATH lists folders that don't exist",
                "These folders are on PATH but aren't there anymore, usually left behind by an uninstalled program. They're harmless but slow down every command lookup a little.",
            )
            .subjects(report.missing.clone()),
        );
    }
    if !report.duplicates.is_empty() {
        findings.push(
            finding(
                "system.path.duplicates",
                FindingSeverity::Info,
                "PATH lists some folders more than once",
                "Only the first copy of each folder matters. Duplicates are harmless but make PATH longer and harder to read.",
            )
            .subjects(report.duplicates.clone()),
        );
    }
    if host.windows
        && host
            .var(kalcode_providers::env::NO_CWD_EXE_SEARCH)
            .is_none()
    {
        findings.push(
            finding(
                "system.path.cwd_search",
                FindingSeverity::Info,
                "Command Prompt looks in the current folder first",
                "By default, cmd.exe runs a program from the current folder before searching PATH, so a repository could ship its own \"git.exe\" or \"node.cmd\". KalCode turns this off for everything it starts; setting NoDefaultCurrentDirectoryInExePath turns it off for your own terminals too.",
            )
            .fix(show_command(
                "show.no_cwd_search",
                "Show the command",
                "Shows a command that sets NoDefaultCurrentDirectoryInExePath=1 for your account. KalCode doesn't change your environment.",
                NO_CWD_SEARCH_COMMAND.to_owned(),
                "PowerShell",
            )),
        );
    }
    let summary = if findings.is_empty() {
        format!("{} folders, all fine", report.entries)
    } else {
        format!(
            "{} folders, {} to look at",
            report.entries,
            count(findings.len(), "thing", "things")
        )
    };
    CheckOutput::with(summary, findings)
}

fn shells(ctx: &RunContext) -> CheckOutput {
    let shells = ctx.core.shells();
    if shells.is_empty() {
        return CheckOutput::with(
            "None found",
            vec![finding(
                "system.shells.none",
                FindingSeverity::Warning,
                "KalCode found no shell for terminals",
                "Terminals need PowerShell, Command Prompt, Git Bash or another shell. None of the usual ones were found.",
            )],
        );
    }
    let names: Vec<String> = shells.iter().map(|s| s.name.clone()).collect();
    CheckOutput::passed(names.join(", "))
}

fn memory(ctx: &RunContext) -> CheckOutput {
    let facts = ctx.resources();
    let (Some(total), Some(available)) = (facts.memory_total, facts.memory_available) else {
        return CheckOutput::could_not_check(
            facts
                .memory_reason
                .clone()
                .unwrap_or_else(|| "Memory wasn't measured.".into()),
        );
    };
    let summary = format!("{} free of {}", bytes(available), bytes(total));
    let low = available < MEMORY_LOW || available.saturating_mul(10) < total;
    if !low {
        return CheckOutput::passed(summary);
    }
    CheckOutput::with(
        summary,
        vec![
            finding(
                "system.memory.low",
                FindingSeverity::Warning,
                "The computer is low on memory",
                "Builds, provider CLIs and terminals slow down or fail when memory runs out. Closing programs you don't need frees memory.",
            )
            .detail("Free", bytes(available))
            .detail("Total", bytes(total)),
        ],
    )
}

fn disk(ctx: &RunContext) -> CheckOutput {
    let facts = ctx.resources();
    let mut findings = Vec::new();
    let mut parts = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for (role, label) in [
        (VolumeRole::System, "System drive"),
        (VolumeRole::Project, "Project drive"),
    ] {
        let Some(v) = volume(facts, role) else {
            continue;
        };
        if seen.contains(&v.mount) {
            continue;
        }
        seen.push(v.mount.clone());
        parts.push(format!(
            "{} free on {}",
            bytes(v.free_bytes),
            label.to_ascii_lowercase()
        ));
        let low = v.free_bytes < DISK_LOW || v.free_bytes.saturating_mul(20) < v.total_bytes;
        if low {
            let critical = v.free_bytes < DISK_CRITICAL;
            findings.push(
                finding(
                    if role == VolumeRole::System {
                        "system.disk.low"
                    } else {
                        "system.disk.project_low"
                    },
                    if critical {
                        FindingSeverity::Critical
                    } else {
                        FindingSeverity::Warning
                    },
                    format!("Little space left on {}", label.to_ascii_lowercase()),
                    "Installs, builds and Git need free space. When a drive fills up, commands fail in confusing ways. Free up space on this drive.",
                )
                .detail("Volume", label)
                .detail("Free", bytes(v.free_bytes))
                .detail("Size", bytes(v.total_bytes)),
            );
        }
    }
    if parts.is_empty() {
        return CheckOutput::could_not_check(
            facts
                .volume_reason
                .clone()
                .unwrap_or_else(|| "Free space wasn't measured.".into()),
        );
    }
    CheckOutput::with(parts.join(" · "), findings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn microphone_permission_states_are_truthful_and_actionable() {
        let granted = microphone_permission_output(MicrophonePermissionState::Granted);
        assert_eq!(granted, CheckOutput::passed("Granted"));

        let denied = microphone_permission_output(MicrophonePermissionState::Denied);
        assert_eq!(denied.summary, "Denied");
        assert_eq!(
            denied.findings[0].code,
            "system.microphone_permission.denied"
        );
        assert!(denied.findings[0].explanation.contains("System Settings"));

        let pending = microphone_permission_output(MicrophonePermissionState::NotDetermined);
        assert_eq!(pending.summary, "Not requested");
        assert_eq!(
            pending.findings[0].code,
            "system.microphone_permission.not_determined"
        );
        assert!(pending.findings[0].explanation.contains("does not open"));

        let unknown = microphone_permission_output(MicrophonePermissionState::Unknown);
        assert_eq!(unknown.summary, "Couldn't determine");
        assert_eq!(
            unknown.findings[0].code,
            "system.microphone_permission.unknown"
        );

        let unsupported = microphone_permission_output(MicrophonePermissionState::Unsupported);
        assert!(matches!(unsupported.ended, super::super::Ended::Skipped(_)));
    }

    #[test]
    fn path_sanity_finds_relative_missing_and_duplicate_entries() {
        let dir = tempfile::tempdir().expect("dir");
        let real = dir.path().display().to_string();
        let gone = dir.path().join("gone").display().to_string();
        let sep = if cfg!(windows) { ";" } else { ":" };
        let value = [
            real.as_str(),
            ".",
            "bin",
            gone.as_str(),
            &format!("{real}/"),
            "",
        ]
        .join(sep);
        let report = analyze_path(OsStr::new(&value), cfg!(windows));
        assert_eq!(report.relative, vec![".", "bin", "(an empty entry)"]);
        assert_eq!(report.missing, vec![gone]);
        assert_eq!(report.duplicates.len(), 1);
    }

    #[test]
    fn unexpanded_variables_count_as_relative() {
        let report = analyze_path(OsStr::new("%USERPROFILE%\\bin"), true);
        assert_eq!(report.relative.len(), 1);
    }
}
