//! The environment of every `git` process KalCode starts.
//!
//! `env_clear()` first, then an allow-list of what Git needs to find the user's own
//! configuration and run at all (home folder, temp folders, system folders on Windows). Every
//! `GIT_*` variable from KalCode's own environment is dropped: `GIT_DIR`, `GIT_WORK_TREE`,
//! `GIT_INDEX_FILE`, `GIT_CONFIG*` (including `GIT_CONFIG_PARAMETERS` / `GIT_CONFIG_COUNT`, which
//! inject configuration), `GIT_SSH` / `GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `GIT_ASKPASS`,
//! `GIT_EXTERNAL_DIFF`, `GIT_PAGER`, `GIT_EDITOR`, `GIT_TRACE*`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
//! `GIT_OBJECT_DIRECTORY`, `GIT_NAMESPACE`, `GIT_CEILING_DIRECTORIES`, … — any of them would
//! redirect or extend what KalCode's internal operations do. KalCode then sets the few `GIT_*`
//! variables it *intends* (a temporary index, a fixed committer for checkpoints) per command.

use std::collections::BTreeMap;
use std::ffi::OsString;

/// Variables passed through from KalCode's environment. Matched case-insensitively.
const ALLOW: &[&str] = &[
    // Executable lookup (Git for Windows finds its helpers relative to itself, and `sh` on
    // PATH for the rare hook-free helper scripts) and the user's profile, where Git reads the
    // user's global configuration.
    "PATH",
    "PATHEXT",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "USER",
    "USERNAME",
    "LOGNAME",
    "XDG_CONFIG_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "OS",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    // Temporary folders.
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
];

/// Variables KalCode always sets for its own git processes.
const FIXED: &[(&str, &str)] = &[
    // Never prompt (there is no terminal; a prompt would hang until the timeout).
    ("GIT_TERMINAL_PROMPT", "0"),
    // Stable, English, parseable messages for error classification.
    ("LC_ALL", "C"),
    ("LANGUAGE", "C"),
    // No pager, even if a user config names one (belt and braces with `--no-pager`).
    ("GIT_PAGER", "cat"),
    ("PAGER", "cat"),
];

/// Builds the base environment for git processes from `source` (normally
/// `std::env::vars_os()`). Variables with non-UTF-8 names are dropped.
pub fn sanitized_env<I>(source: I) -> BTreeMap<OsString, OsString>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    let mut env: BTreeMap<OsString, OsString> = source
        .into_iter()
        .filter(|(name, _)| {
            name.to_str()
                .is_some_and(|n| ALLOW.contains(&n.to_ascii_uppercase().as_str()))
        })
        .collect();
    for (name, value) in FIXED {
        env.insert(OsString::from(name), OsString::from(value));
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    #[test]
    fn git_injection_variables_never_pass() {
        let hostile = [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_CONFIG",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_SYSTEM",
            "GIT_CONFIG_PARAMETERS",
            "GIT_CONFIG_COUNT",
            "GIT_CONFIG_KEY_0",
            "GIT_CONFIG_VALUE_0",
            "GIT_SSH",
            "GIT_SSH_COMMAND",
            "GIT_EXEC_PATH",
            "GIT_ASKPASS",
            "SSH_ASKPASS",
            "GIT_EXTERNAL_DIFF",
            "GIT_EDITOR",
            "EDITOR",
            "VISUAL",
            "GIT_TRACE",
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            "GIT_OBJECT_DIRECTORY",
            "GIT_NAMESPACE",
            "GIT_CEILING_DIRECTORIES",
            "GIT_PROXY_COMMAND",
            "KALCODE_DATA_DIR",
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "ANTHROPIC_API_KEY",
            "GITHUB_TOKEN",
        ];
        let mut pairs: Vec<(&str, &str)> = hostile.iter().map(|name| (*name, "x")).collect();
        pairs.push(("PATH", "/usr/bin"));
        pairs.push(("Path", "C:\\Windows"));
        pairs.push(("HOME", "/home/u"));
        let env = sanitized_env(vars(&pairs));
        for name in hostile {
            assert!(
                !env.contains_key(&OsString::from(name)) || name == "GIT_PAGER",
                "{name} leaked"
            );
        }
        assert_eq!(env.get(&OsString::from("PATH")), Some(&"/usr/bin".into()));
        assert_eq!(
            env.get(&OsString::from("Path")),
            Some(&"C:\\Windows".into())
        );
        assert_eq!(env.get(&OsString::from("HOME")), Some(&"/home/u".into()));
        assert_eq!(
            env.get(&OsString::from("GIT_TERMINAL_PROMPT")),
            Some(&"0".into())
        );
    }

    #[test]
    fn pager_variables_are_overridden_not_inherited() {
        let env = sanitized_env(vars(&[("GIT_PAGER", "evil"), ("PAGER", "evil")]));
        assert_eq!(env.get(&OsString::from("GIT_PAGER")), Some(&"cat".into()));
        assert_eq!(env.get(&OsString::from("PAGER")), Some(&"cat".into()));
    }
}
