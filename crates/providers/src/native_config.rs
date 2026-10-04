//! Native configuration parity for managed provider profiles.
//!
//! A managed account runs its provider with a dedicated profile directory (`CLAUDE_CONFIG_DIR`,
//! `CODEX_HOME`, `GEMINI_CLI_HOME`) so each account keeps its own credentials and session state.
//! Without this module that directory would also hide everything else the user configured for
//! the provider: settings, MCP servers, plugins, skills, agents, commands and global
//! instructions. A provider inside KalCode must keep what it has in a native terminal (AGENTS.md
//! native provider parity rule), so before every managed launch:
//!
//! - **Shared directories** (skills, agents, plugins, commands, ...) become links to the user's
//!   native directories (a junction on Windows, a symlink elsewhere). Installing a plugin or
//!   skill inside KalCode installs it for the native CLI too, exactly as a second native terminal
//!   would. They are linked, never copied: a skills folder can be gigabytes.
//! - **Small instruction files** (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, ...) are copied.
//! - **Settings** (`settings.json`) and **Claude's user MCP servers** (`.claude.json`) are merged
//!   three ways against the last native snapshot: a native change reaches the profile, a value
//!   the user changed inside KalCode survives, and keys only the profile has are kept.
//!
//! Account boundaries stay intact. Credentials, account identity and onboarding state are never
//! read from or written to the native side, and settings that would make the provider
//! authenticate as something other than the selected account (an API key helper, injected keys,
//! another cloud backend, Gemini's auth type) are not merged. Every step is best effort: a
//! failure is logged and the provider still starts.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use crate::detect::DetectEnv;

/// Per-profile record of what was last taken from the native side.
const STATE_FILE: &str = ".kalcode-native-config.json";
/// Upper bound for any JSON or instruction file read here.
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// Suffix for a profile's own directory or file that a native link or copy replaces.
const BACKUP_SUFFIX: &str = "kalcode-before-native-config";

const CLAUDE_SHARED_DIRS: &[&str] = &[
    "agents",
    "commands",
    "skills",
    "rules",
    "output-styles",
    "hooks",
    "plugins",
];
const CLAUDE_FILES: &[&str] = &["CLAUDE.md", "keybindings.json"];
/// Settings that choose how Claude authenticates. The selected KalCode account decides that.
const CLAUDE_AUTH_SETTINGS: &[&str] = &[
    "apiKeyHelper",
    "awsAuthRefresh",
    "awsCredentialExport",
    "forceLoginMethod",
    "forceLoginOrgUUID",
];
/// Per-project `.claude.json` keys that configure MCP servers.
const CLAUDE_PROJECT_MCP_KEYS: &[&str] = &[
    "mcpServers",
    "enabledMcpjsonServers",
    "disabledMcpjsonServers",
    "enableAllProjectMcpServers",
];

const CODEX_SHARED_DIRS: &[&str] = &["skills", "prompts", "rules", "agents", "plugins"];
const CODEX_FILES: &[&str] = &["AGENTS.md", "AGENTS.override.md", "hooks.json"];

const GEMINI_SHARED_DIRS: &[&str] = &["skills", "extensions", "commands", "agents", "policies"];
const GEMINI_FILES: &[&str] = &["GEMINI.md"];

/// Where the user's native provider configuration lives. A location inside KalCode's managed
/// profile root is ignored (KalCode started from a managed terminal).
#[derive(Debug, Clone, Default)]
pub struct NativeHomes {
    claude_dir: Option<PathBuf>,
    claude_global: Option<PathBuf>,
    codex_home: Option<PathBuf>,
    gemini_dir: Option<PathBuf>,
}

impl NativeHomes {
    /// Resolves native locations the way each CLI does: its own selector variable when set,
    /// otherwise the documented default under the user's home.
    pub fn from_env(source: &DetectEnv, managed_root: &Path) -> Self {
        let home = source.home();
        let var = |name: &str| {
            source
                .var(name)
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
        };
        let outside = |path: Option<PathBuf>| path.filter(|path| !is_within(path, managed_root));
        let (claude_dir, claude_global) = match var("CLAUDE_CONFIG_DIR") {
            Some(dir) => (Some(dir.clone()), Some(dir.join(".claude.json"))),
            None => (
                home.as_ref().map(|home| home.join(".claude")),
                home.as_ref().map(|home| home.join(".claude.json")),
            ),
        };
        Self {
            claude_dir: outside(claude_dir),
            claude_global: outside(claude_global),
            codex_home: outside(
                var("CODEX_HOME").or_else(|| home.as_ref().map(|home| home.join(".codex"))),
            ),
            gemini_dir: outside(
                var("GEMINI_CLI_HOME")
                    .or_else(|| home.clone())
                    .map(|home| home.join(".gemini")),
            ),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_tests(native_home: &Path) -> Self {
        Self {
            claude_dir: Some(native_home.join(".claude")),
            claude_global: Some(native_home.join(".claude.json")),
            codex_home: Some(native_home.join(".codex")),
            gemini_dir: Some(native_home.join(".gemini")),
        }
    }
}

/// Brings the user's native configuration for `provider_id` into one account's managed profile
/// `home` (the directory exported as that provider's profile selector). Never fails the launch.
pub fn sync(provider_id: &str, native: &NativeHomes, home: &Path) {
    let mut state = State::load(home);
    match provider_id {
        "claude-code" => sync_claude(native, home, &mut state),
        "codex" => sync_codex(native, home, &mut state),
        "gemini-cli" => {
            let gemini = home.join(".gemini");
            if let Err(error) = ensure_profile_dir(&gemini) {
                warn(provider_id, "profile", &error);
                return;
            }
            sync_gemini(native, &gemini, &mut state);
        }
        _ => return,
    }
    state.save(home);
}

fn sync_claude(native: &NativeHomes, home: &Path, state: &mut State) {
    const PROVIDER: &str = "claude-code";
    let Some(native_dir) = native.claude_dir.as_deref().filter(|dir| dir.is_dir()) else {
        return;
    };
    link_dirs(PROVIDER, native_dir, home, CLAUDE_SHARED_DIRS);
    copy_files(PROVIDER, native_dir, home, CLAUDE_FILES, state);
    let mut native_settings = read_object(&native_dir.join("settings.json"));
    if let Some(settings) = native_settings.as_mut() {
        for key in CLAUDE_AUTH_SETTINGS {
            settings.remove(*key);
        }
        if let Some(Value::Object(env)) = settings.get_mut("env") {
            for name in crate::env::auth_overrides(PROVIDER) {
                env.retain(|key, _| !key.eq_ignore_ascii_case(name));
            }
        }
    }
    merge_settings(
        PROVIDER,
        native_settings,
        &home.join("settings.json"),
        state,
        "claudeSettings",
    );
    if let Some(global) = native.claude_global.as_deref()
        && let Some(native_global) = read_object(global)
    {
        merge_claude_mcp(home, &native_global, state);
    }
}

/// Merges the user-scope `mcpServers` and the per-project MCP keys of the native `.claude.json`
/// into the profile's own `.claude.json`. Account identity, onboarding and caches stay the
/// profile's own.
fn merge_claude_mcp(home: &Path, native_global: &Map<String, Value>, state: &mut State) {
    let native_servers = native_global
        .get("mcpServers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let native_projects = flatten_project_mcp(native_global);
    let last_servers = state.object("claudeMcpServers");
    let last_projects = state.object("claudeProjectMcp");
    let result = crate::claude::onboarding::edit_existing_config(home, |config| {
        let mut changed = false;
        let mut servers = config
            .get("mcpServers")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if merge3(&mut servers, &native_servers, last_servers.as_ref()) {
            config.insert("mcpServers".into(), Value::Object(servers));
            changed = true;
        }
        let mut projects = flatten_project_mcp(config);
        if merge3(&mut projects, &native_projects, last_projects.as_ref()) {
            unflatten_project_mcp(config, &projects);
            changed = true;
        }
        changed
    });
    match result {
        Ok(()) => {
            state.set("claudeMcpServers", Value::Object(native_servers));
            state.set("claudeProjectMcp", Value::Object(native_projects));
        }
        Err(error) => warn("claude-code", "mcp", &error),
    }
}

/// `{"<project path>\n<key>": value}` for the MCP keys of every project in a `.claude.json`.
fn flatten_project_mcp(config: &Map<String, Value>) -> Map<String, Value> {
    let mut flat = Map::new();
    let Some(projects) = config.get("projects").and_then(Value::as_object) else {
        return flat;
    };
    for (path, project) in projects {
        let Some(project) = project.as_object() else {
            continue;
        };
        for key in CLAUDE_PROJECT_MCP_KEYS {
            if let Some(value) = project.get(*key) {
                flat.insert(format!("{path}\n{key}"), value.clone());
            }
        }
    }
    flat
}

fn unflatten_project_mcp(config: &mut Map<String, Value>, flat: &Map<String, Value>) {
    let projects = config
        .entry("projects")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(projects) = projects.as_object_mut() else {
        return;
    };
    for project in projects.values_mut() {
        if let Some(project) = project.as_object_mut() {
            for key in CLAUDE_PROJECT_MCP_KEYS {
                project.remove(*key);
            }
        }
    }
    for (flat_key, value) in flat {
        let Some((path, key)) = flat_key.rsplit_once('\n') else {
            continue;
        };
        let project = projects
            .entry(path)
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(project) = project.as_object_mut() {
            project.insert(key.into(), value.clone());
        }
    }
}

fn sync_codex(native: &NativeHomes, home: &Path, state: &mut State) {
    const PROVIDER: &str = "codex";
    let Some(native_home) = native.codex_home.as_deref().filter(|dir| dir.is_dir()) else {
        return;
    };
    link_dirs(PROVIDER, native_home, home, CODEX_SHARED_DIRS);
    copy_files(PROVIDER, native_home, home, CODEX_FILES, state);
}

/// The profile's `config.toml`: the user's native Codex configuration (MCP servers, plugins,
/// features, model providers, project trust, ...) under KalCode's header. Only
/// `cli_auth_credentials_store` is left out, since it would move this account's sign-in to a
/// different store and make a connected account look signed out.
pub(crate) fn codex_config(native: &NativeHomes, header: &str) -> String {
    let mut config = header.to_owned();
    let Some(text) = native
        .codex_home
        .as_deref()
        .and_then(|home| read_text(&home.join("config.toml")))
    else {
        return config;
    };
    let mut top_level = true;
    for line in text.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with('[') {
            top_level = false;
        }
        if top_level && toml_key(trimmed) == Some("cli_auth_credentials_store") {
            continue;
        }
        config.push_str(line);
        config.push('\n');
    }
    config
}

/// The bare key of a `key = value` TOML line, if it is one.
fn toml_key(line: &str) -> Option<&str> {
    let (key, _) = line.split_once('=')?;
    let key = key.trim().trim_matches(|c| c == '"' || c == '\'');
    (!key.is_empty()).then_some(key)
}

fn sync_gemini(native: &NativeHomes, gemini: &Path, state: &mut State) {
    const PROVIDER: &str = "gemini-cli";
    let Some(native_dir) = native.gemini_dir.as_deref().filter(|dir| dir.is_dir()) else {
        return;
    };
    link_dirs(PROVIDER, native_dir, gemini, GEMINI_SHARED_DIRS);
    copy_files(PROVIDER, native_dir, gemini, GEMINI_FILES, state);
    let mut native_settings = read_object(&native_dir.join("settings.json"));
    if let Some(Value::Object(security)) = native_settings
        .as_mut()
        .and_then(|settings| settings.get_mut("security"))
    {
        // The selected KalCode account decides how Gemini signs in.
        security.remove("auth");
    }
    merge_settings(
        PROVIDER,
        native_settings,
        &gemini.join("settings.json"),
        state,
        "geminiSettings",
    );
}

fn link_dirs(provider: &str, native_root: &Path, profile: &Path, names: &[&str]) {
    for name in names {
        if let Err(error) = link_dir(&native_root.join(name), profile, name) {
            warn(provider, name, &error);
        }
    }
}

/// Makes `profile/name` a link to the native directory `native`. A profile directory that
/// already has content is kept beside it as `<name>.kalcode-before-native-config`, never
/// deleted. Nothing is linked while the native directory does not exist.
fn link_dir(native: &Path, profile: &Path, name: &str) -> std::io::Result<()> {
    match std::fs::metadata(native) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    }
    let link = profile.join(name);
    match std::fs::symlink_metadata(&link) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
        Ok(metadata) if is_link(&metadata) => {
            if same_directory(&link, native) {
                return Ok(());
            }
            remove_dir_link(&link)?;
        }
        Ok(metadata) if metadata.is_dir() => {
            if std::fs::read_dir(&link)?.next().is_none() {
                std::fs::remove_dir(&link)?;
            } else {
                std::fs::rename(&link, backup_path(profile, name))?;
            }
        }
        // A file where the CLI expects a directory is the profile's own business.
        Ok(_) => return Ok(()),
    }
    match create_dir_link(native, &link) {
        // Another launch of the same account linked it first.
        Err(error)
            if error.kind() == std::io::ErrorKind::AlreadyExists
                && same_directory(&link, native) =>
        {
            Ok(())
        }
        result => result,
    }
}

fn backup_path(profile: &Path, name: &str) -> PathBuf {
    let first = profile.join(format!("{name}.{BACKUP_SUFFIX}"));
    if std::fs::symlink_metadata(&first).is_err() {
        return first;
    }
    profile.join(format!(
        "{name}.{BACKUP_SUFFIX}-{}",
        uuid::Uuid::new_v4().simple()
    ))
}

fn same_directory(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Copies small native instruction files into the profile. A profile copy the user edited
/// inside KalCode since the last copy is kept as a backup before the native version replaces
/// it; a native deletion removes only an unedited copy.
fn copy_files(
    provider: &str,
    native_root: &Path,
    profile: &Path,
    names: &[&str],
    state: &mut State,
) {
    for name in names {
        let key = format!("file:{provider}:{name}");
        if let Err(error) = copy_file(&native_root.join(name), profile, name, &key, state) {
            warn(provider, name, &error);
        }
    }
}

fn copy_file(
    native: &Path,
    profile: &Path,
    name: &str,
    key: &str,
    state: &mut State,
) -> std::io::Result<()> {
    let target = profile.join(name);
    let current = match std::fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_file() && !is_link(&metadata) => Some(read_bounded(&target)?),
        // Never write through a link or over a directory.
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let last = state.string(key);
    let unedited = |bytes: &[u8]| last.as_deref() == Some(fingerprint(bytes).as_str());
    let source = match std::fs::metadata(native) {
        Ok(metadata) if metadata.is_file() => Some(read_bounded(native)?),
        Ok(_) => None,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    match (source, current) {
        (Some(source), current) => {
            if current.as_deref() == Some(source.as_slice()) {
                state.set(key, Value::String(fingerprint(&source)));
                return Ok(());
            }
            if let Some(current) = current
                && !unedited(&current)
            {
                std::fs::rename(&target, backup_path(profile, name))?;
            }
            write_atomically(&target, &source)?;
            state.set(key, Value::String(fingerprint(&source)));
        }
        (None, Some(current)) => {
            if unedited(&current) {
                std::fs::remove_file(&target)?;
            }
            state.remove(key);
        }
        (None, None) => state.remove(key),
    }
    Ok(())
}

/// Three-way merge of a native settings object into a profile settings file.
fn merge_settings(
    provider: &str,
    native: Option<Map<String, Value>>,
    target: &Path,
    state: &mut State,
    state_key: &str,
) {
    let Some(native) = native else {
        return;
    };
    let mut current = match std::fs::symlink_metadata(target) {
        Ok(metadata) if metadata.is_file() && !is_link(&metadata) => match read_object(target) {
            Some(current) => current,
            // Unreadable profile settings stay untouched rather than being replaced.
            None => return,
        },
        Ok(_) => return,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(error) => {
            warn(provider, "settings", &error);
            return;
        }
    };
    let last = state.object(state_key);
    if merge3(&mut current, &native, last.as_ref()) {
        let mut bytes = match serde_json::to_vec_pretty(&Value::Object(current)) {
            Ok(bytes) => bytes,
            Err(error) => {
                warn(provider, "settings", &std::io::Error::other(error));
                return;
            }
        };
        bytes.push(b'\n');
        if let Err(error) = write_atomically(target, &bytes) {
            warn(provider, "settings", &error);
            return;
        }
    }
    state.set(state_key, Value::Object(native));
}

/// Merges `native` into `profile` given the native snapshot from the previous merge (`last`):
///
/// - a key the profile lacks is added, unless it is unchanged natively since the last merge
///   (the user removed it inside KalCode);
/// - objects on both sides merge recursively;
/// - otherwise the native value wins when it changed natively since the last merge (always on
///   the first merge), and the profile's value stays when only the profile changed it;
/// - a key removed natively is removed from the profile unless the profile changed it.
///
/// Returns whether `profile` changed.
fn merge3(
    profile: &mut Map<String, Value>,
    native: &Map<String, Value>,
    last: Option<&Map<String, Value>>,
) -> bool {
    let mut changed = false;
    for (key, native_value) in native {
        let last_value = last.and_then(|last| last.get(key));
        let unchanged_natively = last_value == Some(native_value);
        match profile.get_mut(key) {
            None => {
                if !unchanged_natively {
                    profile.insert(key.clone(), native_value.clone());
                    changed = true;
                }
            }
            Some(Value::Object(profile_object)) if native_value.is_object() => {
                if let Some(native_object) = native_value.as_object() {
                    changed |= merge3(
                        profile_object,
                        native_object,
                        last_value.and_then(Value::as_object),
                    );
                }
            }
            Some(profile_value) => {
                if !unchanged_natively && profile_value != native_value {
                    *profile_value = native_value.clone();
                    changed = true;
                }
            }
        }
    }
    if let Some(last) = last {
        for (key, last_value) in last {
            if !native.contains_key(key) && profile.get(key) == Some(last_value) {
                profile.remove(key);
                changed = true;
            }
        }
    }
    changed
}

/// What was last taken from the native side, kept in the profile beside the provider's files.
struct State {
    value: Map<String, Value>,
    dirty: bool,
}

impl State {
    fn load(home: &Path) -> Self {
        Self {
            value: read_object(&home.join(STATE_FILE)).unwrap_or_default(),
            dirty: false,
        }
    }

    fn object(&self, key: &str) -> Option<Map<String, Value>> {
        self.value.get(key).and_then(Value::as_object).cloned()
    }

    fn string(&self, key: &str) -> Option<String> {
        self.value
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
    }

    fn set(&mut self, key: &str, value: Value) {
        if self.value.get(key) != Some(&value) {
            self.value.insert(key.into(), value);
            self.dirty = true;
        }
    }

    fn remove(&mut self, key: &str) {
        if self.value.remove(key).is_some() {
            self.dirty = true;
        }
    }

    fn save(self, home: &Path) {
        if !self.dirty {
            return;
        }
        let path = home.join(STATE_FILE);
        let result = serde_json::to_vec(&Value::Object(self.value))
            .map_err(std::io::Error::other)
            .and_then(|bytes| write_atomically(&path, &bytes));
        if let Err(error) = result {
            warn("native-config", "state", &error);
        }
    }
}

/// A stable content fingerprint (FNV-1a, 64-bit) for change detection, not security.
fn fingerprint(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}-{}", bytes.len())
}

fn read_bounded(path: &Path) -> std::io::Result<Vec<u8>> {
    let file = std::fs::File::open(path)?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(
        &mut std::io::Read::take(file, MAX_FILE_BYTES + 1),
        &mut bytes,
    )?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_FILE_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "file is too large",
        ));
    }
    Ok(bytes)
}

fn read_text(path: &Path) -> Option<String> {
    read_bounded(path)
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
}

fn read_object(path: &Path) -> Option<Map<String, Value>> {
    let bytes = read_bounded(path).ok()?;
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn write_atomically(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("no parent directory"))?;
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("no file name"))?
        .to_string_lossy();
    let temp = parent.join(format!(
        ".{name}.kalcode-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let result = std::fs::write(&temp, bytes).and_then(|()| std::fs::rename(&temp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn ensure_profile_dir(path: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !is_link(&metadata) => Ok(()),
        Ok(_) => Err(std::io::Error::other("not an ordinary directory")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => std::fs::create_dir(path),
        Err(error) => Err(error),
    }
}

fn is_within(path: &Path, root: &Path) -> bool {
    let canonical = |path: &Path| {
        crate::managed::plain_path(&std::fs::canonicalize(path).unwrap_or_else(|_| path.into()))
    };
    canonical(path).starts_with(canonical(root))
}

fn warn(provider: &str, item: &str, error: &dyn std::fmt::Display) {
    tracing::warn!(
        event = "native_config.sync_failed",
        provider,
        item,
        error = %error
    );
}

#[cfg(windows)]
fn is_link(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(windows)]
fn remove_dir_link(link: &Path) -> std::io::Result<()> {
    // Removes a junction or directory symlink itself, never its target's contents.
    std::fs::remove_dir(link)
}

#[cfg(not(windows))]
fn remove_dir_link(link: &Path) -> std::io::Result<()> {
    std::fs::remove_file(link)
}

#[cfg(not(windows))]
fn create_dir_link(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

/// Creates a directory junction (an NTFS mount-point reparse point), which unlike a directory
/// symlink needs neither administrator rights nor Developer Mode.
#[cfg(windows)]
#[allow(unsafe_code)]
fn create_dir_link(target: &Path, link: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::fs::OpenOptionsExt as _;
    use std::os::windows::io::AsRawHandle as _;

    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::IO::DeviceIoControl;

    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FSCTL_SET_REPARSE_POINT: u32 = 0x0009_00A4;
    const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003;
    let too_long = || std::io::Error::new(std::io::ErrorKind::InvalidInput, "path is too long");

    let target = crate::managed::plain_path(&std::fs::canonicalize(target)?);
    let print: Vec<u16> = target.as_os_str().encode_wide().collect();
    let substitute: Vec<u16> = r"\??\"
        .encode_utf16()
        .chain(print.iter().copied())
        .collect();
    let substitute_bytes = u16::try_from(substitute.len() * 2).map_err(|_| too_long())?;
    let print_bytes = u16::try_from(print.len() * 2).map_err(|_| too_long())?;
    // Both names are NUL-terminated in the path buffer; the lengths exclude the terminators.
    let path_buffer: Vec<u16> = substitute
        .iter()
        .copied()
        .chain([0])
        .chain(print.iter().copied())
        .chain([0])
        .collect();
    let data_length = u16::try_from(8 + path_buffer.len() * 2).map_err(|_| too_long())?;
    let mut buffer = Vec::with_capacity(8 + usize::from(data_length));
    buffer.extend(IO_REPARSE_TAG_MOUNT_POINT.to_le_bytes());
    buffer.extend(data_length.to_le_bytes());
    buffer.extend(0u16.to_le_bytes()); // Reserved
    buffer.extend(0u16.to_le_bytes()); // SubstituteNameOffset
    buffer.extend(substitute_bytes.to_le_bytes());
    buffer.extend((substitute_bytes + 2).to_le_bytes()); // PrintNameOffset
    buffer.extend(print_bytes.to_le_bytes());
    for unit in path_buffer {
        buffer.extend(unit.to_le_bytes());
    }
    let buffer_length = u32::try_from(buffer.len()).map_err(|_| too_long())?;

    std::fs::create_dir(link)?;
    let result = (|| {
        let directory = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(link)?;
        let mut returned = 0u32;
        // SAFETY: the handle is a live directory handle owned by `directory`, and `buffer` is an
        // initialized REPARSE_DATA_BUFFER of `buffer_length` bytes that outlives the call.
        unsafe {
            DeviceIoControl(
                HANDLE(directory.as_raw_handle()),
                FSCTL_SET_REPARSE_POINT,
                Some(buffer.as_ptr().cast()),
                buffer_length,
                None,
                0,
                Some(&raw mut returned),
                None,
            )
        }
        .map_err(|error| std::io::Error::from_raw_os_error(error.code().0 & 0xFFFF))
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir(link);
    }
    result
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(value: Value) -> Map<String, Value> {
        value.as_object().cloned().expect("object")
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
        std::fs::write(path, text).expect("write");
    }

    #[test]
    fn first_merge_takes_native_values_and_keeps_profile_only_keys() {
        let mut profile = object(json!({"model": "opus", "theme": "light"}));
        let native = object(json!({"theme": "dark", "enabledPlugins": {"a@m": true}}));
        assert!(merge3(&mut profile, &native, None));
        assert_eq!(
            Value::Object(profile),
            json!({"model": "opus", "theme": "dark", "enabledPlugins": {"a@m": true}})
        );
    }

    #[test]
    fn later_merges_keep_kalcode_edits_and_follow_native_edits_and_removals() {
        let last = object(json!({"theme": "dark", "verbose": true, "env": {"A": "1", "B": "2"}}));
        // Inside KalCode the user changed the theme; natively they changed env.B, removed
        // verbose and env.A, and added a key.
        let mut profile =
            object(json!({"theme": "light", "verbose": true, "env": {"A": "1", "B": "2"}}));
        let native = object(json!({"theme": "dark", "env": {"B": "3"}, "new": 1}));
        assert!(merge3(&mut profile, &native, Some(&last)));
        assert_eq!(
            Value::Object(profile),
            json!({"theme": "light", "env": {"B": "3"}, "new": 1})
        );
    }

    #[test]
    fn a_key_removed_inside_kalcode_is_not_re_added_until_it_changes_natively() {
        let last = object(json!({"statusLine": "a"}));
        let mut profile = Map::new();
        assert!(!merge3(&mut profile, &last.clone(), Some(&last)));
        assert!(profile.is_empty());
        assert!(merge3(
            &mut profile,
            &object(json!({"statusLine": "b"})),
            Some(&last)
        ));
        assert_eq!(profile["statusLine"], "b");
    }

    #[test]
    fn claude_profile_gains_native_settings_mcp_and_instructions_but_not_auth() {
        let temp = tempfile::tempdir().expect("temp");
        let native = temp.path().join("user");
        let home = temp.path().join("profile");
        std::fs::create_dir_all(&home).expect("profile");
        write(
            &native.join(".claude/settings.json"),
            r#"{"enabledPlugins":{"p@m":true},"apiKeyHelper":"x","env":{"ANTHROPIC_API_KEY":"k","FOO":"1"}}"#,
        );
        write(&native.join(".claude/CLAUDE.md"), "native instructions\n");
        write(&native.join(".claude/skills/demo/SKILL.md"), "skill\n");
        write(
            &native.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"native@example.com"},"mcpServers":{"github":{"command":"gh-mcp"}},"projects":{"C:/repo":{"mcpServers":{"local":{"command":"l"}},"allowedTools":["x"]}}}"#,
        );
        write(
            &home.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"account@example.com"},"hasCompletedOnboarding":true}"#,
        );
        write(
            &home.join("settings.json"),
            r#"{"skipDangerousModePermissionPrompt":true}"#,
        );

        sync("claude-code", &NativeHomes::for_tests(&native), &home);

        let settings = read_object(&home.join("settings.json")).expect("settings");
        assert_eq!(settings["enabledPlugins"], json!({"p@m": true}));
        assert_eq!(settings["skipDangerousModePermissionPrompt"], true);
        assert!(!settings.contains_key("apiKeyHelper"));
        assert_eq!(settings["env"], json!({"FOO": "1"}));
        let config = read_object(&home.join(".claude.json")).expect("config");
        assert_eq!(
            config["oauthAccount"]["emailAddress"],
            "account@example.com"
        );
        assert_eq!(
            config["mcpServers"],
            json!({"github": {"command": "gh-mcp"}})
        );
        assert_eq!(
            config["projects"]["C:/repo"],
            json!({"mcpServers": {"local": {"command": "l"}}})
        );
        assert_eq!(
            std::fs::read_to_string(home.join("CLAUDE.md")).expect("CLAUDE.md"),
            "native instructions\n"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("skills/demo/SKILL.md")).expect("linked skill"),
            "skill\n"
        );
        assert!(is_link(
            &std::fs::symlink_metadata(home.join("skills")).expect("skills")
        ));
        // The native side is never written.
        let native_config = read_object(&native.join(".claude.json")).expect("native");
        assert_eq!(
            native_config["oauthAccount"]["emailAddress"],
            "native@example.com"
        );
        assert!(!native.join(".claude").join(STATE_FILE).exists());

        // A second launch is a no-op, and a skill added natively is visible at once.
        write(&native.join(".claude/skills/later/SKILL.md"), "later\n");
        sync("claude-code", &NativeHomes::for_tests(&native), &home);
        assert!(home.join("skills/later/SKILL.md").is_file());
    }

    #[test]
    fn a_profile_directory_with_content_is_kept_as_a_backup_before_linking() {
        let temp = tempfile::tempdir().expect("temp");
        let native = temp.path().join("user");
        let home = temp.path().join("profile");
        write(&native.join(".codex/skills/s/SKILL.md"), "native\n");
        write(&home.join("skills/own/SKILL.md"), "profile\n");
        std::fs::create_dir_all(home.join("prompts")).expect("empty prompts");
        write(&native.join(".codex/prompts/p.md"), "prompt\n");
        write(&native.join(".codex/AGENTS.md"), "global agents\n");

        sync("codex", &NativeHomes::for_tests(&native), &home);

        assert!(home.join("skills/s/SKILL.md").is_file());
        assert!(home.join("prompts/p.md").is_file());
        assert_eq!(
            std::fs::read_to_string(home.join(format!("skills.{BACKUP_SUFFIX}/own/SKILL.md")))
                .expect("backup"),
            "profile\n"
        );
        assert_eq!(
            std::fs::read_to_string(home.join("AGENTS.md")).expect("AGENTS.md"),
            "global agents\n"
        );
    }

    #[test]
    fn instruction_copies_follow_native_changes_and_keep_kalcode_edits_as_backups() {
        let temp = tempfile::tempdir().expect("temp");
        let native = temp.path().join("user");
        let home = temp.path().join("profile");
        std::fs::create_dir_all(&home).expect("profile");
        let homes = NativeHomes::for_tests(&native);
        write(&native.join(".codex/AGENTS.md"), "v1\n");
        sync("codex", &homes, &home);
        write(&native.join(".codex/AGENTS.md"), "v2\n");
        sync("codex", &homes, &home);
        assert_eq!(
            std::fs::read_to_string(home.join("AGENTS.md")).expect("v2"),
            "v2\n"
        );

        write(&home.join("AGENTS.md"), "edited in KalCode\n");
        write(&native.join(".codex/AGENTS.md"), "v3\n");
        sync("codex", &homes, &home);
        assert_eq!(
            std::fs::read_to_string(home.join("AGENTS.md")).expect("v3"),
            "v3\n"
        );
        assert_eq!(
            std::fs::read_to_string(home.join(format!("AGENTS.md.{BACKUP_SUFFIX}")))
                .expect("backup"),
            "edited in KalCode\n"
        );

        std::fs::remove_file(native.join(".codex/AGENTS.md")).expect("native delete");
        sync("codex", &homes, &home);
        assert!(!home.join("AGENTS.md").exists());
    }

    #[test]
    fn codex_config_is_native_except_the_credential_store() {
        let temp = tempfile::tempdir().expect("temp");
        let native = temp.path().join("user");
        write(
            &native.join(".codex/config.toml"),
            "model = \"gpt-5\"\ncli_auth_credentials_store = \"keyring\"\n\n[mcp_servers.docs]\ncommand = \"docs-mcp\"\n\n[features]\ncli_auth_credentials_store = \"kept: not top level\"\n",
        );
        let config = codex_config(&NativeHomes::for_tests(&native), "# header\n");
        assert_eq!(
            config,
            "# header\nmodel = \"gpt-5\"\n\n[mcp_servers.docs]\ncommand = \"docs-mcp\"\n\n[features]\ncli_auth_credentials_store = \"kept: not top level\"\n"
        );
        assert_eq!(
            codex_config(&NativeHomes::default(), "# header\n"),
            "# header\n"
        );
    }

    #[test]
    fn gemini_settings_merge_without_the_auth_type() {
        let temp = tempfile::tempdir().expect("temp");
        let native = temp.path().join("user");
        let home = temp.path().join("profile");
        std::fs::create_dir_all(&home).expect("profile");
        write(
            &native.join(".gemini/settings.json"),
            r#"{"mcpServers":{"s":{"command":"c"}},"security":{"auth":{"selectedType":"gemini-api-key"},"folderTrust":{"enabled":false}}}"#,
        );
        write(&native.join(".gemini/GEMINI.md"), "gemini memory\n");
        write(
            &home.join(".gemini/settings.json"),
            r#"{"security":{"auth":{"selectedType":"oauth-personal"}}}"#,
        );
        sync("gemini-cli", &NativeHomes::for_tests(&native), &home);
        let settings = read_object(&home.join(".gemini/settings.json")).expect("settings");
        assert_eq!(settings["mcpServers"], json!({"s": {"command": "c"}}));
        assert_eq!(
            settings["security"]["auth"]["selectedType"],
            "oauth-personal"
        );
        assert_eq!(settings["security"]["folderTrust"]["enabled"], false);
        assert!(home.join(".gemini/GEMINI.md").is_file());
    }

    #[test]
    fn native_locations_inside_the_managed_root_are_ignored() {
        let temp = tempfile::tempdir().expect("temp");
        let root = temp.path().join("provider-profiles");
        let inside = root.join("providers/claude-code/accounts/a/home");
        std::fs::create_dir_all(&inside).expect("inside");
        let source = DetectEnv {
            vars: vec![
                ("CLAUDE_CONFIG_DIR".into(), inside.clone().into_os_string()),
                ("HOME".into(), temp.path().join("user").into_os_string()),
                (
                    "USERPROFILE".into(),
                    temp.path().join("user").into_os_string(),
                ),
            ],
            windows: cfg!(windows),
            probe_timeout: None,
            system_root: None,
        };
        let homes = NativeHomes::from_env(&source, &root);
        assert!(homes.claude_dir.is_none());
        assert_eq!(
            homes.codex_home,
            Some(temp.path().join("user").join(".codex"))
        );
    }
}
