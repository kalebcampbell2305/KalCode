//! Compatibility repair for Claude profiles connected before Claude Code persisted its
//! onboarding-complete marker.
//!
//! This module never inspects credentials. A non-empty provider-native `oauthAccount.accountUuid`
//! is only evidence that the profile has previously completed account setup; Claude Code remains
//! the authority that accepts or rejects the native authentication session at process startup.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, Weak};

use kalcode_contracts::agent::{ProviderError, ProviderId};

use crate::managed::{ManagedProfiles, ProfileLease};

const CONFIG_NAME: &str = ".claude.json";
// Claude stores long-lived project metadata here as well as account setup. Keep reads bounded
// without rejecting established profiles that have accumulated substantial native state.
const MAX_CONFIG_BYTES: u64 = 16 * 1024 * 1024;
const INVALID_CONFIG: &str = "the managed Claude setup metadata is invalid";
const UNSAFE_CONFIG: &str = "the managed Claude setup metadata is not a safe ordinary file";

static PROFILE_GATES: OnceLock<Mutex<BTreeMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SetupState {
    Complete,
    LegacyConnected,
    ProviderMustHandle,
}

struct LoadedConfig {
    value: serde_json::Value,
    permissions: std::fs::Permissions,
    retained: same_file::Handle,
}

/// Runs a legacy compatibility bootstrap before the caller acquires its shared session lease.
///
/// The fast path is read-only and does not serialize profiles that already carry the native
/// marker. Legacy callers for one profile are serialized in-process; every waiter rechecks after
/// the first repair, so a multi-agent fan-out does not race the exclusive OS lease.
pub(crate) fn prepare_connected_profile(
    profiles: &ManagedProfiles,
    account_id: &str,
    migrate_exclusively: impl FnOnce() -> Result<(), ProviderError>,
) -> Result<(), ProviderError> {
    let home = profiles.profile_home(ProviderId::CLAUDE_CODE, account_id)?;
    let path = home.join(CONFIG_NAME);
    match inspect(&path)? {
        SetupState::ProviderMustHandle => return Ok(()),
        SetupState::Complete => {
            let Some(gate) = active_profile_gate(&home) else {
                return Ok(());
            };
            let _guard = gate.lock().unwrap_or_else(PoisonError::into_inner);
            if inspect(&path)? == SetupState::LegacyConnected {
                migrate_exclusively()?;
            }
            return Ok(());
        }
        SetupState::LegacyConnected => {}
    }

    let gate = profile_gate(home);
    let _guard = gate.lock().unwrap_or_else(PoisonError::into_inner);
    if inspect(&path)? == SetupState::LegacyConnected {
        migrate_exclusively()?;
    }
    Ok(())
}

/// Returns only an already-active migration gate. The ordinary completed-profile path never
/// creates a gate or requests an exclusive profile lease, but it must wait for a migration that
/// has installed the marker and has not yet released that exclusive lease.
fn active_profile_gate(home: &Path) -> Option<Arc<Mutex<()>>> {
    let gates = PROFILE_GATES.get()?;
    gates
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(home)
        .and_then(Weak::upgrade)
}

/// Sets exactly Claude's onboarding marker while the selected profile's canonical exclusive
/// lease is held. Missing/unconnected profiles remain untouched so Claude can run its real login.
pub(crate) fn complete_with_lease(
    profiles: &ManagedProfiles,
    account_id: &str,
    lease: &ProfileLease,
) -> Result<(), ProviderError> {
    if !lease.is_exclusive_for(profiles, ProviderId::CLAUDE_CODE, account_id) {
        return Err(ProviderError::Start(
            "the managed Claude setup lease does not match the selected account".into(),
        ));
    }
    let home = profiles.profile_home(ProviderId::CLAUDE_CODE, account_id)?;
    let path = home.join(CONFIG_NAME);
    let Some(mut loaded) = load(&path)? else {
        return Ok(());
    };
    match classify(&loaded.value)? {
        SetupState::Complete | SetupState::ProviderMustHandle => Ok(()),
        SetupState::LegacyConnected => {
            let object = loaded
                .value
                .as_object_mut()
                .ok_or_else(|| ProviderError::Start(INVALID_CONFIG.into()))?;
            object.insert(
                "hasCompletedOnboarding".to_owned(),
                serde_json::Value::Bool(true),
            );
            replace_atomically(&path, loaded)
        }
    }
}

/// Applies `edit` to a profile's existing `.claude.json` and replaces it atomically when `edit`
/// reports a change. A missing file is left for Claude's own first run. Native configuration
/// parity uses this for the user's MCP servers; Claude's account and onboarding keys are never
/// passed to `edit` for change.
pub(crate) fn edit_existing_config(
    home: &Path,
    edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>) -> bool,
) -> Result<(), ProviderError> {
    let path = home.join(CONFIG_NAME);
    let gate = profile_gate(home.to_path_buf());
    let _guard = gate.lock().unwrap_or_else(PoisonError::into_inner);
    let Some(mut loaded) = load(&path)? else {
        return Ok(());
    };
    let object = loaded
        .value
        .as_object_mut()
        .ok_or_else(|| ProviderError::Start(INVALID_CONFIG.into()))?;
    if edit(object) {
        replace_atomically(&path, loaded)?;
    }
    Ok(())
}

fn profile_gate(home: PathBuf) -> Arc<Mutex<()>> {
    let gates = PROFILE_GATES.get_or_init(Mutex::default);
    let mut gates = gates.lock().unwrap_or_else(PoisonError::into_inner);
    gates.retain(|_, gate| gate.strong_count() > 0);
    if let Some(gate) = gates.get(&home).and_then(Weak::upgrade) {
        return gate;
    }
    let gate = Arc::new(Mutex::new(()));
    gates.insert(home, Arc::downgrade(&gate));
    gate
}

fn inspect(path: &Path) -> Result<SetupState, ProviderError> {
    let Some(loaded) = load(path)? else {
        return Ok(SetupState::ProviderMustHandle);
    };
    classify(&loaded.value)
}

fn classify(value: &serde_json::Value) -> Result<SetupState, ProviderError> {
    let object = value
        .as_object()
        .ok_or_else(|| ProviderError::Start(INVALID_CONFIG.into()))?;
    if object
        .get("hasCompletedOnboarding")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
    {
        return Ok(SetupState::Complete);
    }
    let connected = object
        .get("oauthAccount")
        .and_then(serde_json::Value::as_object)
        .and_then(|account| account.get("accountUuid"))
        .and_then(serde_json::Value::as_str)
        .is_some_and(|id| !id.trim().is_empty() && id.len() <= 256);
    Ok(if connected {
        SetupState::LegacyConnected
    } else {
        SetupState::ProviderMustHandle
    })
}

fn load(path: &Path) -> Result<Option<LoadedConfig>, ProviderError> {
    let before = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(io_error(
                "couldn't inspect managed Claude setup metadata",
                error,
            ));
        }
    };
    verify_metadata(path, &before)?;

    let mut file = File::open(path)
        .map_err(|error| io_error("couldn't open managed Claude setup metadata", error))?;
    let opened = file
        .metadata()
        .map_err(|error| io_error("couldn't inspect opened Claude setup metadata", error))?;
    verify_open_file(&file, &opened)?;
    let mut bytes = Vec::with_capacity(usize::try_from(opened.len()).unwrap_or(0));
    std::io::Read::take(&mut file, MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error("couldn't read managed Claude setup metadata", error))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_CONFIG_BYTES {
        return Err(ProviderError::Start(INVALID_CONFIG.into()));
    }

    let retained = same_file::Handle::from_file(file)
        .map_err(|error| io_error("couldn't retain managed Claude setup metadata", error))?;
    let after = std::fs::symlink_metadata(path)
        .map_err(|error| io_error("couldn't recheck managed Claude setup metadata", error))?;
    verify_metadata(path, &after)?;
    let current = same_file::Handle::from_path(path)
        .map_err(|error| io_error("couldn't verify managed Claude setup metadata", error))?;
    if current != retained {
        return Err(ProviderError::Start(UNSAFE_CONFIG.into()));
    }
    let value =
        serde_json::from_slice(&bytes).map_err(|_| ProviderError::Start(INVALID_CONFIG.into()))?;
    Ok(Some(LoadedConfig {
        value,
        permissions: after.permissions(),
        retained,
    }))
}

fn verify_metadata(path: &Path, metadata: &std::fs::Metadata) -> Result<(), ProviderError> {
    if !metadata.is_file()
        || is_link_or_reparse(metadata)
        || metadata.len() > MAX_CONFIG_BYTES
        || has_multiple_links_path(path, metadata)?
    {
        return Err(ProviderError::Start(UNSAFE_CONFIG.into()));
    }
    Ok(())
}

fn verify_open_file(file: &File, metadata: &std::fs::Metadata) -> Result<(), ProviderError> {
    if !metadata.is_file()
        || is_link_or_reparse(metadata)
        || metadata.len() > MAX_CONFIG_BYTES
        || has_multiple_links_file(file, metadata)?
    {
        return Err(ProviderError::Start(UNSAFE_CONFIG.into()));
    }
    Ok(())
}

fn replace_atomically(path: &Path, loaded: LoadedConfig) -> Result<(), ProviderError> {
    let parent = path
        .parent()
        .ok_or_else(|| ProviderError::Start(UNSAFE_CONFIG.into()))?;
    let bytes = serde_json::to_vec(&loaded.value)
        .map_err(|_| ProviderError::Start(INVALID_CONFIG.into()))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_CONFIG_BYTES {
        return Err(ProviderError::Start(INVALID_CONFIG.into()));
    }
    let temp = parent.join(format!(
        ".{CONFIG_NAME}.kalcode-{}.tmp",
        uuid::Uuid::new_v4().hyphenated()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| io_error("couldn't create managed Claude setup metadata", error))?;
        set_private_permissions(&file)?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| io_error("couldn't write managed Claude setup metadata", error))?;
        set_replacement_permissions(&file, loaded.permissions.clone())?;
        file.sync_all()
            .map_err(|error| io_error("couldn't sync managed Claude setup metadata", error))?;
        drop(file);

        verify_metadata(
            path,
            &std::fs::symlink_metadata(path).map_err(|error| {
                io_error("couldn't recheck managed Claude setup metadata", error)
            })?,
        )?;
        let current = same_file::Handle::from_path(path)
            .map_err(|error| io_error("couldn't recheck managed Claude setup metadata", error))?;
        verify_metadata(
            path,
            &std::fs::symlink_metadata(path).map_err(|error| {
                io_error("couldn't recheck managed Claude setup metadata", error)
            })?,
        )?;
        if current != loaded.retained {
            return Err(ProviderError::Start(UNSAFE_CONFIG.into()));
        }
        drop(current);
        drop(loaded.retained);
        replace_file(path, &temp)?;
        verify_metadata(
            path,
            &std::fs::symlink_metadata(path).map_err(|error| {
                io_error("couldn't verify installed Claude setup metadata", error)
            })?,
        )?;
        sync_parent(parent)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

#[cfg(windows)]
#[allow(unsafe_code)]
fn replace_file(target: &Path, replacement: &Path) -> Result<(), ProviderError> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows::Win32::Storage::FileSystem::{REPLACE_FILE_FLAGS, ReplaceFileW};
    use windows::core::PCWSTR;

    let mut target_wide: Vec<u16> = target.as_os_str().encode_wide().collect();
    target_wide.push(0);
    let mut replacement_wide: Vec<u16> = replacement.as_os_str().encode_wide().collect();
    replacement_wide.push(0);
    unsafe {
        ReplaceFileW(
            PCWSTR(target_wide.as_ptr()),
            PCWSTR(replacement_wide.as_ptr()),
            PCWSTR::null(),
            REPLACE_FILE_FLAGS(0),
            None,
            None,
        )
    }
    .map_err(|error| {
        io_error(
            "couldn't atomically install managed Claude setup metadata",
            std::io::Error::from_raw_os_error(error.code().0),
        )
    })
}

#[cfg(not(windows))]
fn replace_file(target: &Path, replacement: &Path) -> Result<(), ProviderError> {
    std::fs::rename(replacement, target).map_err(|error| {
        io_error(
            "couldn't atomically install managed Claude setup metadata",
            error,
        )
    })
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> Result<(), ProviderError> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| io_error("couldn't sync managed Claude profile", error))
}

#[cfg(not(unix))]
fn sync_parent(_parent: &Path) -> Result<(), ProviderError> {
    Ok(())
}

#[cfg(unix)]
fn set_private_permissions(file: &File) -> Result<(), ProviderError> {
    use std::os::unix::fs::PermissionsExt as _;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))
        .map_err(|error| io_error("couldn't protect managed Claude setup metadata", error))
}

#[cfg(not(unix))]
fn set_private_permissions(_file: &File) -> Result<(), ProviderError> {
    Ok(())
}

#[cfg(unix)]
fn set_replacement_permissions(
    file: &File,
    permissions: std::fs::Permissions,
) -> Result<(), ProviderError> {
    file.set_permissions(permissions)
        .map_err(|error| io_error("couldn't preserve managed Claude setup permissions", error))
}

#[cfg(not(unix))]
fn set_replacement_permissions(
    _file: &File,
    _permissions: std::fs::Permissions,
) -> Result<(), ProviderError> {
    // ReplaceFileW preserves the replaced file's ACL and other protected metadata.
    Ok(())
}

#[cfg(windows)]
fn has_multiple_links_path(
    path: &Path,
    _metadata: &std::fs::Metadata,
) -> Result<bool, ProviderError> {
    let file = File::open(path)
        .map_err(|error| io_error("couldn't inspect managed Claude setup metadata", error))?;
    has_multiple_links_file(&file, _metadata)
}

#[cfg(unix)]
fn has_multiple_links_path(
    _path: &Path,
    metadata: &std::fs::Metadata,
) -> Result<bool, ProviderError> {
    use std::os::unix::fs::MetadataExt as _;
    Ok(metadata.nlink() != 1)
}

#[cfg(not(any(unix, windows)))]
fn has_multiple_links_path(
    _path: &Path,
    _metadata: &std::fs::Metadata,
) -> Result<bool, ProviderError> {
    Ok(true)
}

#[cfg(windows)]
fn has_multiple_links_file(
    file: &File,
    _metadata: &std::fs::Metadata,
) -> Result<bool, ProviderError> {
    let cloned = file
        .try_clone()
        .map_err(|error| io_error("couldn't retain managed Claude setup metadata", error))?;
    Ok(winapi_util::file::information(cloned)
        .map_or(true, |information| information.number_of_links() != 1))
}

#[cfg(unix)]
fn has_multiple_links_file(
    _file: &File,
    metadata: &std::fs::Metadata,
) -> Result<bool, ProviderError> {
    use std::os::unix::fs::MetadataExt as _;
    Ok(metadata.nlink() != 1)
}

#[cfg(not(any(unix, windows)))]
fn has_multiple_links_file(
    _file: &File,
    _metadata: &std::fs::Metadata,
) -> Result<bool, ProviderError> {
    Ok(true)
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn io_error(context: &str, error: std::io::Error) -> ProviderError {
    ProviderError::Start(format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        _temp: tempfile::TempDir,
        profiles: ManagedProfiles,
        account_id: String,
        config: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().expect("temp");
            let root = if cfg!(target_os = "macos") {
                temp.path().canonicalize().expect("canonical temp")
            } else {
                temp.path().to_path_buf()
            };
            let profiles = ManagedProfiles::new(root.join("profiles")).expect("profiles");
            let account_id = kalcode_contracts::ids::new_id();
            let config = profiles
                .profile_home(ProviderId::CLAUDE_CODE, &account_id)
                .expect("profile home")
                .join(CONFIG_NAME);
            Self {
                _temp: temp,
                profiles,
                account_id,
                config,
            }
        }

        fn write(&self, value: serde_json::Value) -> Vec<u8> {
            let bytes = serde_json::to_vec(&value).expect("json");
            std::fs::write(&self.config, &bytes).expect("config");
            bytes
        }

        fn migrate(&self) -> Result<(), ProviderError> {
            let lease = self
                .profiles
                .acquire_sign_in_lease(ProviderId::CLAUDE_CODE, &self.account_id)?;
            complete_with_lease(&self.profiles, &self.account_id, &lease)
        }

        fn value(&self) -> serde_json::Value {
            serde_json::from_slice(&std::fs::read(&self.config).expect("read config"))
                .expect("valid config")
        }
    }

    #[test]
    fn legacy_connected_profile_sets_only_the_onboarding_flag() {
        let fixture = Fixture::new();
        fixture.write(serde_json::json!({
            "oauthAccount": {
                "accountUuid": "native-account-id",
                "emailAddress": "person@example.test"
            },
            "hasCompletedOnboarding": false,
            "theme": "dark",
            "nested": { "preserved": [1, true, "yes"] }
        }));

        fixture.migrate().expect("migration");
        let value = fixture.value();
        assert_eq!(value["hasCompletedOnboarding"], true);
        assert_eq!(value["theme"], "dark");
        assert_eq!(
            value["nested"],
            serde_json::json!({ "preserved": [1, true, "yes"] })
        );
        assert_eq!(value["oauthAccount"]["accountUuid"], "native-account-id");
    }

    #[test]
    fn completed_missing_and_unconnected_profiles_are_never_rewritten_or_created() {
        let complete = Fixture::new();
        let original = complete.write(serde_json::json!({
            "oauthAccount": { "accountUuid": "native-account-id" },
            "hasCompletedOnboarding": true,
            "spacing": "preserve exactly"
        }));
        prepare_connected_profile(&complete.profiles, &complete.account_id, || {
            panic!("completed profile must not request an exclusive lease")
        })
        .expect("completed fast path");
        assert_eq!(std::fs::read(&complete.config).expect("config"), original);

        let missing = Fixture::new();
        missing
            .migrate()
            .expect("missing profile is provider-owned");
        assert!(!missing.config.exists());

        for oauth_account in [
            serde_json::Value::Null,
            serde_json::json!("wrong-type"),
            serde_json::json!({}),
            serde_json::json!({ "accountUuid": "" }),
            serde_json::json!({ "emailAddress": "person@example.test" }),
        ] {
            let fixture = Fixture::new();
            let original = fixture.write(serde_json::json!({
                "oauthAccount": oauth_account,
                "hasCompletedOnboarding": false
            }));
            fixture.migrate().expect("provider handles real setup");
            assert_eq!(std::fs::read(&fixture.config).expect("config"), original);
        }
    }

    #[test]
    fn malformed_nonobject_and_oversized_metadata_fail_closed_without_content() {
        for bytes in [b"{not-json".to_vec(), b"[]".to_vec()] {
            let fixture = Fixture::new();
            std::fs::write(&fixture.config, &bytes).expect("bad config");
            let error = fixture.migrate().expect_err("invalid metadata");
            assert!(!error.to_string().contains("not-json"));
            assert_eq!(std::fs::read(&fixture.config).expect("unchanged"), bytes);
        }

        let fixture = Fixture::new();
        let bytes = vec![b' '; usize::try_from(MAX_CONFIG_BYTES).unwrap() + 1];
        std::fs::write(&fixture.config, &bytes).expect("oversized config");
        assert!(fixture.migrate().is_err());
        assert_eq!(std::fs::read(&fixture.config).expect("unchanged"), bytes);
    }

    #[test]
    fn profile_migration_is_idempotent_and_account_scoped() {
        let first = Fixture::new();
        let second_id = kalcode_contracts::ids::new_id();
        let second_config = first
            .profiles
            .profile_home(ProviderId::CLAUDE_CODE, &second_id)
            .expect("second profile")
            .join(CONFIG_NAME);
        first.write(serde_json::json!({
            "oauthAccount": { "accountUuid": "first" },
            "hasCompletedOnboarding": false
        }));
        let second_original = serde_json::to_vec(&serde_json::json!({
            "oauthAccount": { "accountUuid": "second" },
            "hasCompletedOnboarding": false
        }))
        .expect("second json");
        std::fs::write(&second_config, &second_original).expect("second config");

        first.migrate().expect("first migration");
        let after_first = std::fs::read(&first.config).expect("first config");
        first.migrate().expect("idempotent migration");
        assert_eq!(
            std::fs::read(&first.config).expect("first config"),
            after_first
        );
        assert_eq!(
            std::fs::read(&second_config).expect("second unchanged"),
            second_original
        );
    }

    #[cfg(unix)]
    #[test]
    fn atomic_replacement_preserves_existing_file_mode() {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};

        let fixture = Fixture::new();
        fixture.write(serde_json::json!({
            "oauthAccount": { "accountUuid": "native-account-id" },
            "hasCompletedOnboarding": false
        }));
        std::fs::set_permissions(&fixture.config, std::fs::Permissions::from_mode(0o640))
            .expect("chmod");
        fixture.migrate().expect("migration");
        assert_eq!(
            std::fs::metadata(&fixture.config).expect("metadata").mode() & 0o777,
            0o640
        );
    }

    #[test]
    fn multiply_linked_metadata_is_refused_without_touching_either_name() {
        let fixture = Fixture::new();
        let outside = fixture._temp.path().join("outside.json");
        let original = serde_json::to_vec(&serde_json::json!({
            "oauthAccount": { "accountUuid": "native-account-id" },
            "hasCompletedOnboarding": false
        }))
        .expect("json");
        std::fs::write(&outside, &original).expect("outside");
        std::fs::hard_link(&outside, &fixture.config).expect("hard link");

        assert!(fixture.migrate().is_err());
        assert_eq!(
            std::fs::read(&outside).expect("outside unchanged"),
            original
        );
        assert_eq!(
            std::fs::read(&fixture.config).expect("alias unchanged"),
            original
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_metadata_is_refused_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let outside = fixture._temp.path().join("outside-symlink.json");
        let original = serde_json::to_vec(&serde_json::json!({
            "oauthAccount": { "accountUuid": "native-account-id" },
            "hasCompletedOnboarding": false
        }))
        .expect("json");
        std::fs::write(&outside, &original).expect("outside");
        symlink(&outside, &fixture.config).expect("symlink");

        assert!(fixture.migrate().is_err());
        assert_eq!(
            std::fs::read(&outside).expect("outside unchanged"),
            original
        );
    }
}
