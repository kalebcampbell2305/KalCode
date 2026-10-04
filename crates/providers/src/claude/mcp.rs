//! The user's own Claude Code MCP servers, passed to KalCode sessions so tool calling works as it
//! does in a native terminal (AGENTS.md "Permanent provider tool capability rule").
//!
//! Claude Code keeps user-scope servers under `mcpServers` and local-scope servers under
//! `projects["<workspace>"].mcpServers` in its global config file: `$CLAUDE_CONFIG_DIR/.claude.json`
//! when the selector is set, otherwise `~/.claude.json`
//! (https://code.claude.com/docs/en/mcp#mcp-installation-scopes). A KalCode account profile has its
//! own config directory, so the servers the person configured in their normal terminal live in the
//! native file. Both are read; the account profile wins a name clash, as it would natively.
//!
//! Repository `.mcp.json` servers are never read here: in `-p` mode Claude Code would start them
//! with no trust prompt, so headless sessions keep `--strict-mcp-config` and see only these.
//!
//! The written file can hold server credentials (headers, environment), exactly like the source
//! files. It lives in a private KalCode or profile directory, is owner-only on Unix, and is never
//! logged.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// Largest config file read. Real files hold history and caches; servers are a small part.
const MAX_CONFIG_BYTES: u64 = 32 * 1024 * 1024;

/// Where Claude Code's global config files are for one launch environment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConfigFiles {
    /// The account profile's file (`$CLAUDE_CONFIG_DIR/.claude.json`), when a profile is selected.
    pub profile: Option<PathBuf>,
    /// The person's native file (`~/.claude.json`).
    pub native: Option<PathBuf>,
}

impl ConfigFiles {
    /// Resolves both files from a provider launch environment.
    pub fn from_env(env: &BTreeMap<OsString, OsString>) -> Self {
        let get = |name: &str| {
            env.iter()
                .find(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.as_os_str())
                .filter(|value| !value.is_empty())
        };
        // Claude Code finds `~` the way Node's `os.homedir()` does: USERPROFILE on Windows (a
        // Git Bash `HOME` such as `/c/Users/me` is not a Windows path), HOME elsewhere.
        let home = if cfg!(windows) {
            get("USERPROFILE").or_else(|| get("HOME"))
        } else {
            get("HOME").or_else(|| get("USERPROFILE"))
        };
        Self::new(get("CLAUDE_CONFIG_DIR"), home)
    }

    pub fn new(config_dir: Option<&OsStr>, home: Option<&OsStr>) -> Self {
        let profile = config_dir.map(|dir| Path::new(dir).join(".claude.json"));
        let native = home
            .map(|home| Path::new(home).join(".claude.json"))
            .filter(|native| Some(native) != profile.as_ref());
        Self { profile, native }
    }
}

/// The servers a session should see, split by where they come from.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct UserServers {
    /// Defined in the account profile itself (Claude Code loads these natively).
    pub profile: Map<String, Value>,
    /// Defined only in the person's native config.
    pub native_only: Map<String, Value>,
}

impl UserServers {
    /// Reads user- and local-scope servers for `workspace`. Unreadable or malformed files
    /// contribute nothing: a broken config never stops a session from starting.
    pub fn read(files: &ConfigFiles, workspace: &Path) -> Self {
        let profile = files
            .profile
            .as_deref()
            .map(|file| servers_in(file, workspace))
            .unwrap_or_default();
        let native_only = files
            .native
            .as_deref()
            .map(|file| servers_in(file, workspace))
            .unwrap_or_default()
            .into_iter()
            .filter(|(name, _)| !profile.contains_key(name))
            .collect();
        Self {
            profile,
            native_only,
        }
    }

    /// Every server (profile first), for a session that loads no MCP config on its own.
    pub fn all(&self) -> Map<String, Value> {
        let mut all = self.profile.clone();
        for (name, server) in &self.native_only {
            all.entry(name.clone()).or_insert_with(|| server.clone());
        }
        all
    }
}

/// User-scope plus local-scope servers in one config file. Local scope wins a name clash.
fn servers_in(file: &Path, workspace: &Path) -> Map<String, Value> {
    let Some(config) = read_json(file) else {
        return Map::new();
    };
    let mut servers = server_map(config.get("mcpServers"));
    if let Some(projects) = config.get("projects").and_then(Value::as_object) {
        let wanted = project_key(workspace);
        for (key, project) in projects {
            if project_key(Path::new(key)) == wanted {
                servers.extend(server_map(project.get("mcpServers")));
            }
        }
    }
    servers
}

fn server_map(value: Option<&Value>) -> Map<String, Value> {
    value
        .and_then(Value::as_object)
        .map(|servers| {
            servers
                .iter()
                .filter(|(name, server)| !name.is_empty() && server.is_object())
                .map(|(name, server)| (name.clone(), server.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn read_json(file: &Path) -> Option<Value> {
    let metadata = std::fs::metadata(file).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES {
        return None;
    }
    serde_json::from_slice(&std::fs::read(file).ok()?).ok()
}

/// Claude Code keys projects by path with forward slashes; Windows paths compare
/// case-insensitively and may carry the verbatim prefix `canonicalize` adds.
fn project_key(path: &Path) -> String {
    let text = crate::managed::plain_path(path)
        .to_string_lossy()
        .replace('\\', "/");
    let trimmed = text.trim_end_matches('/');
    let trimmed = if trimmed.is_empty() { "/" } else { trimmed };
    if cfg!(windows) {
        trimmed.to_lowercase()
    } else {
        trimmed.to_owned()
    }
}

/// Writes `{"mcpServers": …}` for `--mcp-config`, or removes a stale file and returns `None`
/// when there is nothing to pass.
pub fn write_config(path: &Path, servers: &Map<String, Value>) -> std::io::Result<Option<PathBuf>> {
    if servers.is_empty() {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        return Ok(None);
    }
    let body = serde_json::to_vec(&serde_json::json!({ "mcpServers": servers }))
        .map_err(std::io::Error::other)?;
    write_private(path, &body)?;
    Ok(Some(path.to_path_buf()))
}

fn write_private(path: &Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let temp = path.with_extension("json.tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    file.write_all(body)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&temp, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(dir: &Path, name: &str, value: Value) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, serde_json::to_vec(&value).expect("json")).expect("write");
        path
    }

    #[test]
    fn native_and_profile_servers_merge_with_the_profile_winning() {
        let dir = tempfile::tempdir().expect("dir");
        let workspace = dir.path().join("repo");
        std::fs::create_dir(&workspace).expect("repo");
        let mut projects = Map::new();
        projects.insert(
            workspace.to_string_lossy().replace('\\', "/"),
            json!({"mcpServers": {"obsidian": {"command": "obs"}}}),
        );
        projects.insert(
            "/elsewhere".into(),
            json!({"mcpServers": {"other": {"command": "x"}}}),
        );
        let native = write(
            dir.path(),
            "native.json",
            json!({
                "mcpServers": {
                    "github": {"type": "http", "url": "https://native.example/mcp"},
                    "memory": {"command": "npx", "args": ["memory"]},
                    "bad": "not an object"
                },
                "projects": projects
            }),
        );
        let profile = write(
            dir.path(),
            "profile.json",
            json!({ "mcpServers": { "github": {"type": "http", "url": "https://profile.example"} } }),
        );
        let servers = UserServers::read(
            &ConfigFiles {
                profile: Some(profile),
                native: Some(native),
            },
            &workspace,
        );
        assert_eq!(
            servers.profile.keys().collect::<Vec<_>>(),
            ["github"],
            "the profile's own servers"
        );
        let native_only: Vec<&String> = servers.native_only.keys().collect();
        assert_eq!(native_only, ["memory", "obsidian"]);
        let all = servers.all();
        assert_eq!(all["github"]["url"], "https://profile.example");
        assert!(
            !all.contains_key("other"),
            "another project's local servers"
        );
        assert!(!all.contains_key("bad"));
    }

    #[test]
    fn missing_or_broken_files_contribute_nothing() {
        let dir = tempfile::tempdir().expect("dir");
        let broken = dir.path().join("broken.json");
        std::fs::write(&broken, b"{ not json").expect("write");
        let servers = UserServers::read(
            &ConfigFiles {
                profile: Some(dir.path().join("missing.json")),
                native: Some(broken),
            },
            dir.path(),
        );
        assert_eq!(servers, UserServers::default());
    }

    #[test]
    fn config_files_come_from_the_launch_environment() {
        let mut env = BTreeMap::new();
        env.insert(OsString::from("HOME"), OsString::from("/home/a"));
        env.insert(
            OsString::from("CLAUDE_CONFIG_DIR"),
            OsString::from("/data/profile"),
        );
        let files = ConfigFiles::from_env(&env);
        assert_eq!(
            files.profile.as_deref(),
            Some(Path::new("/data/profile/.claude.json"))
        );
        assert_eq!(
            files.native.as_deref(),
            Some(Path::new("/home/a/.claude.json"))
        );
        // No profile selector: the native file is Claude Code's own, read once.
        env.remove(&OsString::from("CLAUDE_CONFIG_DIR"));
        let files = ConfigFiles::from_env(&env);
        assert_eq!(files.profile, None);
        assert!(files.native.is_some());
    }

    #[test]
    fn the_written_config_is_loadable_and_empty_sets_remove_it() {
        let dir = tempfile::tempdir().expect("dir");
        let path = dir.path().join("claude-mcp.json");
        let mut servers = Map::new();
        servers.insert("time".into(), json!({"command": "uvx", "args": ["time"]}));
        assert_eq!(
            write_config(&path, &servers).expect("write"),
            Some(path.clone())
        );
        let written: Value =
            serde_json::from_slice(&std::fs::read(&path).expect("read")).expect("json");
        assert_eq!(written["mcpServers"]["time"]["command"], "uvx");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).expect("meta").permissions().mode();
            assert_eq!(mode & 0o077, 0, "owner-only");
        }
        assert_eq!(write_config(&path, &Map::new()).expect("clear"), None);
        assert!(!path.exists());
    }
}
