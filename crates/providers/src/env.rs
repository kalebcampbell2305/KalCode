//! Environments for provider child processes.
//!
//! A provider launched by KalCode must behave as it does when the user starts it in their own
//! terminal (AGENTS.md native provider parity rule), so provider sessions get
//! [`EnvPolicy::NATIVE`]: everything KalCode itself inherited, except KalCode-internal variables
//! (`KALCODE_*`, WebView2 debugging variables). SSH agents, `GH_TOKEN`, toolchain homes, cloud
//! settings and the variables MCP servers reference reach the provider as they would natively.
//!
//! KalCode's own short-lived probes (Environment Doctor `--version` checks) keep an allow-list:
//! [`EnvPolicy::BASE`] plus the probe's own names. A managed account session also drops the few
//! variables that would make *that* provider authenticate as someone other than the selected
//! account ([`strip_auth_overrides`]).

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

/// Which variables a child may receive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EnvPolicy {
    /// Variable-name prefixes passed on top of the base allow-list (e.g. `RUSTUP_`).
    pub provider_prefixes: &'static [&'static str],
    /// Exact variable names passed on top of the base allow-list.
    pub provider_names: &'static [&'static str],
    /// Pass every variable except KalCode-internal ones, as a native terminal would.
    pub inherit_all: bool,
}

impl EnvPolicy {
    /// Only the base allow-list; no provider variables. For KalCode's own short-lived probes.
    pub const BASE: Self = Self {
        provider_prefixes: &[],
        provider_names: &[],
        inherit_all: false,
    };

    /// The user's whole environment minus KalCode-internal variables: what every provider
    /// session receives (native provider parity).
    pub const NATIVE: Self = Self {
        provider_prefixes: &[],
        provider_names: &[],
        inherit_all: true,
    };

    fn allows(&self, name: &str) -> bool {
        let upper = name.to_ascii_uppercase();
        if ALWAYS_DENY_PREFIXES.iter().any(|p| upper.starts_with(p)) {
            return false;
        }
        self.inherit_all
            || BASE_ALLOW.contains(&upper.as_str())
            || self.provider_names.contains(&upper.as_str())
            || self.provider_prefixes.iter().any(|p| upper.starts_with(p))
    }
}

/// Variables that make a provider authenticate as something other than its own signed-in
/// account: an API key, an injected OAuth token, a different cloud backend or another profile
/// directory. A managed account session drops these for its own provider so an agent launched on
/// "Claude B" really is Claude B. Everything else passes, including other providers' keys.
pub fn auth_overrides(provider_id: &str) -> &'static [&'static str] {
    match provider_id {
        "claude-code" => &[
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_USE_BEDROCK",
            "CLAUDE_CODE_USE_VERTEX",
            "CLAUDE_CODE_USE_FOUNDRY",
            "CLAUDE_CONFIG_DIR",
            "CLAUDE_SECURESTORAGE_CONFIG_DIR",
        ],
        "codex" => &[
            "CODEX_API_KEY",
            "OPENAI_API_KEY",
            "CODEX_HOME",
            // Developer overrides that point Codex's sign-in at another issuer or client.
            "CODEX_APP_SERVER_LOGIN_ISSUER",
            "CODEX_APP_SERVER_LOGIN_CLIENT_ID",
            "CODEX_APP_SERVER_DEV_OPEN_APP_URL",
        ],
        "gemini-cli" => &[
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_GENAI_USE_VERTEXAI",
            "GOOGLE_GENAI_USE_GCA",
            "GOOGLE_CLOUD_ACCESS_TOKEN",
            "GEMINI_CLI_HOME",
        ],
        _ => &[],
    }
}

/// Removes [`auth_overrides`] for `provider_id`, matching names case-insensitively as Windows
/// does.
pub fn strip_auth_overrides(env: &mut BTreeMap<OsString, OsString>, provider_id: &str) {
    let names = auth_overrides(provider_id);
    env.retain(|name, _| {
        !name
            .to_str()
            .is_some_and(|n| names.iter().any(|o| n.eq_ignore_ascii_case(o)))
    });
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
        inherit_all: false,
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
            inherit_all: true,
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

    #[test]
    fn native_policy_passes_the_user_environment_except_kalcode_internals() {
        let env = sanitized_env(
            vars(&[
                ("PATH", "/usr/bin"),
                ("SSH_AUTH_SOCK", "/tmp/agent.sock"),
                ("GH_TOKEN", "t"),
                ("JAVA_HOME", "/jdk"),
                ("PSModulePath", "C:\\ps"),
                ("AWS_PROFILE", "dev"),
                ("MCP_TIMEOUT", "30000"),
                ("OPENAI_API_KEY", "o"),
                ("ANTHROPIC_API_KEY", "a"),
                ("KALCODE_DATA_DIR", "/k"),
                ("WEBVIEW2_USER_DATA_FOLDER", "/w"),
            ]),
            &EnvPolicy::NATIVE,
        );
        for name in [
            "PATH",
            "SSH_AUTH_SOCK",
            "GH_TOKEN",
            "JAVA_HOME",
            "PSModulePath",
            "AWS_PROFILE",
            "MCP_TIMEOUT",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
        ] {
            assert!(lookup(&env, name).is_some(), "{name} must pass: {env:?}");
        }
        assert!(lookup(&env, "KALCODE_DATA_DIR").is_none());
        assert!(lookup(&env, "WEBVIEW2_USER_DATA_FOLDER").is_none());
        assert_eq!(lookup(&env, NO_CWD_EXE_SEARCH), Some(OsStr::new("1")));
    }

    #[test]
    fn managed_sessions_drop_only_their_own_provider_auth_overrides() {
        let mut env = sanitized_env(
            vars(&[
                ("anthropic_api_key", "a"),
                ("CLAUDE_CODE_OAUTH_TOKEN", "t"),
                ("ANTHROPIC_BASE_URL", "https://proxy"),
                ("OPENAI_API_KEY", "o"),
                ("GH_TOKEN", "g"),
            ]),
            &EnvPolicy::NATIVE,
        );
        strip_auth_overrides(&mut env, "claude-code");
        assert!(lookup(&env, "ANTHROPIC_API_KEY").is_none());
        assert!(lookup(&env, "CLAUDE_CODE_OAUTH_TOKEN").is_none());
        for kept in ["ANTHROPIC_BASE_URL", "OPENAI_API_KEY", "GH_TOKEN"] {
            assert!(lookup(&env, kept).is_some(), "{kept}: {env:?}");
        }
        strip_auth_overrides(&mut env, "codex");
        assert!(lookup(&env, "OPENAI_API_KEY").is_none());
    }
}
