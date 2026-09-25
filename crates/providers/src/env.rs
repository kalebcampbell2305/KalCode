//! Sanitized environments for provider child processes.
//!
//! Provider processes never inherit KalCode's environment wholesale. They get an allow-list of
//! variables the OS and a CLI need to run (paths, locale, temp folders, proxies), plus only the
//! variables belonging to *that* provider (`ANTHROPIC_*` for Claude Code, `OPENAI_*` for Codex,
//! ...). A Claude Code process therefore never sees an OpenAI key and vice versa, and nothing
//! KalCode-internal (`KALCODE_*`, WebView2 debugging variables) reaches any provider.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};

/// Variables every provider CLI may need to start. Matched case-insensitively on Windows.
const BASE_ALLOW: &[&str] = &[
    // Executable lookup and the user's profile.
    "PATH",
    "PATHEXT",
    "HOME",
    "USER",
    "USERNAME",
    "LOGNAME",
    "SHELL",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMW6432",
    "COMMONPROGRAMFILES",
    "COMMONPROGRAMFILES(X86)",
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
    // Locale and terminal capabilities.
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "TZ",
    // XDG base directories (Linux): where CLIs keep their own config and credentials.
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    // Corporate networks: proxies and custom certificate authorities.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
];

/// Prefixes that are never passed through, even if a provider allow-list would match them.
const ALWAYS_DENY_PREFIXES: &[&str] = &["KALCODE_", "WEBVIEW2_", "WEBKIT_INSPECTOR"];

/// Which provider-specific variables a child may receive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvPolicy {
    /// Variable-name prefixes owned by the provider (e.g. `ANTHROPIC_`, `CLAUDE_`).
    pub provider_prefixes: &'static [&'static str],
    /// Exact variable names owned by the provider.
    pub provider_names: &'static [&'static str],
}

impl EnvPolicy {
    /// Only the base allow-list; no provider variables.
    pub const BASE: Self = Self {
        provider_prefixes: &[],
        provider_names: &[],
    };

    fn allows(&self, name: &str) -> bool {
        let upper = name.to_ascii_uppercase();
        if ALWAYS_DENY_PREFIXES.iter().any(|p| upper.starts_with(p)) {
            return false;
        }
        BASE_ALLOW.contains(&upper.as_str())
            || self.provider_names.contains(&upper.as_str())
            || self.provider_prefixes.iter().any(|p| upper.starts_with(p))
    }
}

/// Builds the environment for a provider child from `source` (normally `std::env::vars_os()`).
/// Variables with non-UTF-8 names are dropped. The result is [`harden`]ed.
pub fn sanitized_env<I>(source: I, policy: &EnvPolicy) -> BTreeMap<OsString, OsString>
where
    I: IntoIterator<Item = (OsString, OsString)>,
{
    let mut env = source
        .into_iter()
        .filter(|(name, _)| name.to_str().is_some_and(|n| policy.allows(n)))
        .collect();
    harden(&mut env);
    env
}

/// Tells `cmd.exe` (and every other caller of `NeedCurrentDirectoryForExePathW`) not to look
/// for a bare program name such as `node` in the current directory before `PATH`. Provider
/// sessions run with the workspace as their working directory, so without it a `node.cmd` or
/// `node.exe` committed to a repository would run in place of the real one whenever a `.cmd`
/// shim starts a program by bare name. Set on every platform (ignored outside Windows).
pub const NO_CWD_EXE_SEARCH: &str = "NoDefaultCurrentDirectoryInExePath";

/// Makes a provider environment safe to launch with, whatever it was built from:
/// - `NoDefaultCurrentDirectoryInExePath=1` is always set (see [`NO_CWD_EXE_SEARCH`]);
/// - `PATH` keeps only absolute entries. Empty and relative entries (`.`, `bin`, `""`) would
///   resolve against the child's working directory, which is the workspace.
pub fn harden(env: &mut BTreeMap<OsString, OsString>) {
    env.retain(|name, _| {
        !name
            .to_str()
            .is_some_and(|n| n.eq_ignore_ascii_case(NO_CWD_EXE_SEARCH))
    });
    env.insert(NO_CWD_EXE_SEARCH.into(), "1".into());
    for (name, value) in env.iter_mut() {
        if name
            .to_str()
            .is_some_and(|n| n.eq_ignore_ascii_case("PATH"))
        {
            *value = absolute_path_list(value);
        }
    }
}

/// The absolute entries of a `PATH`-style list, in order. Relative and empty entries are dropped.
pub fn absolute_path_entries(list: &OsStr) -> Vec<std::path::PathBuf> {
    std::env::split_paths(list)
        .filter(|dir| is_absolute_dir_entry(dir))
        .collect()
}

/// `C:\bin` and `\\server\share` are absolute; `.`, `bin`, `\bin` (drive-relative) and `C:bin`
/// are not.
fn is_absolute_dir_entry(dir: &std::path::Path) -> bool {
    !dir.as_os_str().is_empty() && dir.is_absolute()
}

fn absolute_path_list(list: &OsStr) -> OsString {
    std::env::join_paths(absolute_path_entries(list)).unwrap_or_default()
}

/// Reads one variable from a sanitized environment (case-insensitively on Windows).
pub fn lookup<'a>(env: &'a BTreeMap<OsString, OsString>, name: &str) -> Option<&'a OsStr> {
    env.iter()
        .find(|(key, _)| {
            key.to_str().is_some_and(|k| {
                if cfg!(windows) {
                    k.eq_ignore_ascii_case(name)
                } else {
                    k == name
                }
            })
        })
        .map(|(_, value)| value.as_os_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CLAUDE: EnvPolicy = EnvPolicy {
        provider_prefixes: &["ANTHROPIC_", "CLAUDE_"],
        provider_names: &[],
    };

    fn vars(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    #[test]
    fn keeps_base_and_own_provider_variables_only() {
        let env = sanitized_env(
            vars(&[
                ("PATH", "/usr/bin"),
                ("Path", "C:\\Windows"),
                ("ANTHROPIC_API_KEY", "a"),
                ("CLAUDE_CONFIG_DIR", "/c"),
                ("OPENAI_API_KEY", "o"),
                ("GEMINI_API_KEY", "g"),
                ("AWS_SECRET_ACCESS_KEY", "s"),
                ("GITHUB_TOKEN", "t"),
                ("KALCODE_DATA_DIR", "/k"),
                (
                    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                    "--remote-debugging-port=1",
                ),
                ("HTTPS_PROXY", "http://proxy"),
            ]),
            &CLAUDE,
        );
        let names: Vec<_> = env
            .keys()
            .map(|k| k.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names,
            [
                "ANTHROPIC_API_KEY",
                "CLAUDE_CONFIG_DIR",
                "HTTPS_PROXY",
                NO_CWD_EXE_SEARCH,
                "PATH",
                "Path"
            ]
        );
    }

    #[test]
    fn current_directory_exe_search_is_always_disabled() {
        // Even when the parent sets it to something else, or under another spelling.
        let env = sanitized_env(
            vars(&[("nodefaultcurrentdirectoryinexepath", "0"), ("TEMP", "/t")]),
            &CLAUDE,
        );
        let matching: Vec<_> = env
            .iter()
            .filter(|(k, _)| {
                k.to_str()
                    .is_some_and(|k| k.eq_ignore_ascii_case(NO_CWD_EXE_SEARCH))
            })
            .collect();
        assert_eq!(matching.len(), 1, "{env:?}");
        assert_eq!(matching[0].1, &OsString::from("1"));
        let base = sanitized_env(Vec::new(), &EnvPolicy::BASE);
        assert_eq!(lookup(&base, NO_CWD_EXE_SEARCH), Some(OsStr::new("1")));
    }

    #[test]
    fn path_keeps_only_absolute_entries() {
        let abs = std::env::temp_dir();
        let list = std::env::join_paths([
            std::path::PathBuf::from("."),
            std::path::PathBuf::from("node_modules/.bin"),
            abs.clone(),
            std::path::PathBuf::from(""),
            std::path::PathBuf::from("bin"),
        ])
        .expect("join");
        let mut sep_list = list.clone();
        // An empty entry in the middle (`a;;b`) is also a current-directory entry.
        sep_list.push(if cfg!(windows) { ";;" } else { "::" });
        sep_list.push(&abs);
        let env = sanitized_env(vec![("PATH".into(), sep_list)], &EnvPolicy::BASE);
        let path = lookup(&env, "PATH").expect("PATH");
        assert_eq!(absolute_path_entries(path), [abs.clone(), abs]);
        assert!(std::env::split_paths(path).all(|p| p.is_absolute()));
    }

    #[cfg(windows)]
    #[test]
    fn drive_relative_path_entries_are_not_absolute() {
        for entry in [r"\tools", r"C:tools", "."] {
            assert!(
                !is_absolute_dir_entry(std::path::Path::new(entry)),
                "{entry}"
            );
        }
        for entry in [r"C:\tools", r"\\server\share\bin"] {
            assert!(
                is_absolute_dir_entry(std::path::Path::new(entry)),
                "{entry}"
            );
        }
    }

    #[test]
    fn kalcode_variables_never_pass_even_if_a_prefix_matches() {
        let policy = EnvPolicy {
            provider_prefixes: &["KAL"],
            provider_names: &["KALCODE_LOG"],
        };
        let env = sanitized_env(vars(&[("KALCODE_LOG", "debug")]), &policy);
        assert!(lookup(&env, "KALCODE_LOG").is_none());
        assert_eq!(env.len(), 1, "only {NO_CWD_EXE_SEARCH}: {env:?}");
    }

    #[test]
    fn base_policy_passes_no_credentials() {
        let env = sanitized_env(
            vars(&[
                ("ANTHROPIC_API_KEY", "a"),
                ("OPENAI_API_KEY", "o"),
                ("TEMP", "/t"),
            ]),
            &EnvPolicy::BASE,
        );
        assert_eq!(env.len(), 2, "TEMP and {NO_CWD_EXE_SEARCH}: {env:?}");
        assert_eq!(lookup(&env, "TEMP"), Some(OsStr::new("/t")));
    }
}
