//! Dedicated provider profiles stored beneath KalCode's application-data directory.
//!
//! The caller supplies an absolute child of an existing application-data directory. KalCode
//! creates only fixed provider/session subdirectories, rejects filesystem links and reparse
//! points in their ancestry, and never reads, copies, or rewrites provider authentication files.
//! Provider launch environments retain the ordinary OS/home variables used for executable
//! discovery while selecting the dedicated profile with Claude's config and secure-storage
//! selectors, `CODEX_HOME`, or `GEMINI_CLI_HOME`.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs::File;
#[cfg(not(windows))]
use std::fs::OpenOptions;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError, Weak};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::{AgentInput, AgentSession, ProviderError};
use kalcode_contracts::permissions::ApprovalDecision;

use crate::detect::DetectEnv;
use crate::env::EnvPolicy;
use crate::guardian::{
    GuardianAuthority, GuardianLease, ProfileCapability, ProfileGeneration, ProfileIdentity,
    ProviderProbeGuardian, RegisteredJob,
};

#[cfg(windows)]
#[path = "managed_lock.rs"]
mod managed_lock;

const SUPPORTED_PROVIDERS: &str =
    "provider account leases support only claude-code, codex, gemini-cli, and cursor";
const UNSAFE_PATH: &str = "managed profile storage must not contain filesystem links";
const MANAGED_PROFILE_DIRECTORY: &str = "provider-profiles";
const OBSERVER_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

type ProfilePriorityKey = (&'static str, String);

#[derive(Default)]
struct ProfilePriorityEntry {
    reader_admissions: usize,
    observers: usize,
    observer_cancellations: Vec<Weak<AtomicBool>>,
    writers: usize,
}

#[derive(Default)]
struct ProfilePriorityCoordinator {
    entries: Mutex<BTreeMap<ProfilePriorityKey, ProfilePriorityEntry>>,
    changed: Condvar,
}

struct ObserverAdmission {
    coordinator: Arc<ProfilePriorityCoordinator>,
    key: ProfilePriorityKey,
    canceled: Arc<AtomicBool>,
}

struct ReaderAdmission {
    coordinator: Arc<ProfilePriorityCoordinator>,
    key: ProfilePriorityKey,
}

struct WriterAdmission {
    coordinator: Arc<ProfilePriorityCoordinator>,
    key: ProfilePriorityKey,
}

static PROFILE_PRIORITY_COORDINATORS: OnceLock<
    Mutex<BTreeMap<PathBuf, Weak<ProfilePriorityCoordinator>>>,
> = OnceLock::new();

fn priority_coordinator(root: &Path) -> Arc<ProfilePriorityCoordinator> {
    let coordinators = PROFILE_PRIORITY_COORDINATORS.get_or_init(Mutex::default);
    let mut coordinators = coordinators.lock().unwrap_or_else(PoisonError::into_inner);
    coordinators.retain(|_, coordinator| coordinator.strong_count() > 0);
    if let Some(coordinator) = coordinators.get(root).and_then(Weak::upgrade) {
        return coordinator;
    }
    let coordinator = Arc::new(ProfilePriorityCoordinator::default());
    coordinators.insert(root.to_path_buf(), Arc::downgrade(&coordinator));
    coordinator
}

impl ProfilePriorityCoordinator {
    fn admit_reader(
        self: &Arc<Self>,
        key: ProfilePriorityKey,
    ) -> Result<ReaderAdmission, ProfileLeaseError> {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = entries.entry(key.clone()).or_default();
        if entry.writers > 0 {
            return Err(ProfileLeaseError::InUse);
        }
        entry.reader_admissions = entry.reader_admissions.saturating_add(1);
        Ok(ReaderAdmission {
            coordinator: Arc::clone(self),
            key,
        })
    }

    fn begin_observer(
        self: &Arc<Self>,
        key: ProfilePriorityKey,
    ) -> Result<ObserverAdmission, ProfileLeaseError> {
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = entries.entry(key.clone()).or_default();
        if entry.writers > 0 {
            return Err(ProfileLeaseError::InUse);
        }
        let canceled = Arc::new(AtomicBool::new(false));
        entry.observers = entry.observers.saturating_add(1);
        entry.observer_cancellations.push(Arc::downgrade(&canceled));
        Ok(ObserverAdmission {
            coordinator: Arc::clone(self),
            key,
            canceled,
        })
    }

    fn begin_writer(
        self: &Arc<Self>,
        key: ProfilePriorityKey,
        timeout: Duration,
    ) -> Result<WriterAdmission, ProfileLeaseError> {
        let deadline = Instant::now() + timeout;
        let mut entries = self.entries.lock().unwrap_or_else(PoisonError::into_inner);
        {
            let entry = entries.entry(key.clone()).or_default();
            entry.writers = entry.writers.saturating_add(1);
            entry.observer_cancellations.retain(|cancellation| {
                cancellation.upgrade().is_some_and(|cancellation| {
                    cancellation.store(true, Ordering::Release);
                    true
                })
            });
        }
        loop {
            if entries
                .get(&key)
                .is_none_or(|entry| entry.observers == 0 && entry.reader_admissions == 0)
            {
                return Ok(WriterAdmission {
                    coordinator: Arc::clone(self),
                    key,
                });
            }
            let now = Instant::now();
            if now >= deadline {
                finish_writer(&mut entries, &key);
                self.changed.notify_all();
                return Err(ProfileLeaseError::InUse);
            }
            let waited = self
                .changed
                .wait_timeout(entries, deadline.saturating_duration_since(now))
                .unwrap_or_else(PoisonError::into_inner);
            entries = waited.0;
            if waited.1.timed_out()
                && entries
                    .get(&key)
                    .is_some_and(|entry| entry.observers > 0 || entry.reader_admissions > 0)
            {
                finish_writer(&mut entries, &key);
                self.changed.notify_all();
                return Err(ProfileLeaseError::InUse);
            }
        }
    }
}

fn finish_writer(
    entries: &mut BTreeMap<ProfilePriorityKey, ProfilePriorityEntry>,
    key: &ProfilePriorityKey,
) {
    if let Some(entry) = entries.get_mut(key) {
        entry.writers = entry.writers.saturating_sub(1);
        if entry.writers == 0 && entry.observers == 0 && entry.reader_admissions == 0 {
            entries.remove(key);
        }
    }
}

impl Drop for ObserverAdmission {
    fn drop(&mut self) {
        let mut entries = self
            .coordinator
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(entry) = entries.get_mut(&self.key) {
            entry.observers = entry.observers.saturating_sub(1);
            entry
                .observer_cancellations
                .retain(|cancellation| cancellation.strong_count() > 0);
            if entry.writers == 0 && entry.observers == 0 && entry.reader_admissions == 0 {
                entries.remove(&self.key);
            }
        }
        self.coordinator.changed.notify_all();
    }
}

impl Drop for ReaderAdmission {
    fn drop(&mut self) {
        let mut entries = self
            .coordinator
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(entry) = entries.get_mut(&self.key) {
            entry.reader_admissions = entry.reader_admissions.saturating_sub(1);
            if entry.writers == 0 && entry.observers == 0 && entry.reader_admissions == 0 {
                entries.remove(&self.key);
            }
        }
        self.coordinator.changed.notify_all();
    }
}

impl Drop for WriterAdmission {
    fn drop(&mut self) {
        let mut entries = self
            .coordinator
            .entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        finish_writer(&mut entries, &self.key);
        self.coordinator.changed.notify_all();
    }
}

/// Why an account-lifecycle operation could not exclusively lock a managed profile.
#[derive(Debug, thiserror::Error)]
pub enum ProfileLifecycleLeaseError {
    #[error("the managed provider profile is in use")]
    InUse,
    #[error(transparent)]
    Unavailable(ProviderError),
}

#[derive(Debug)]
enum ProfileLeaseError {
    InUse,
    Unavailable(ProviderError),
}

impl ProfileLeaseError {
    fn into_provider_error(self) -> ProviderError {
        match self {
            Self::InUse => ProviderError::Refused {
                code: kalcode_contracts::threads::error_codes::PROVIDER_ACCOUNT_BUSY.to_owned(),
                message: "This account is busy with a sign-in or account change in KalCode. \
                          Finish it, then resume this thread."
                    .to_owned(),
            },
            Self::Unavailable(error) => error,
        }
    }
}

#[derive(Clone, Copy)]
enum ManagedProvider {
    Claude,
    Codex,
    Gemini,
    Cursor,
}

impl ManagedProvider {
    fn parse(provider: &str) -> Result<Self, ProviderError> {
        match provider {
            "claude-code" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "gemini-cli" => Ok(Self::Gemini),
            "cursor" => Ok(Self::Cursor),
            _ => Err(ProviderError::Start(SUPPORTED_PROVIDERS.into())),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude-code",
            Self::Codex => "codex",
            Self::Gemini => "gemini-cli",
            Self::Cursor => "cursor",
        }
    }

    fn home_variable(self) -> Option<&'static str> {
        match self {
            Self::Claude => Some("CLAUDE_CONFIG_DIR"),
            Self::Codex => Some("CODEX_HOME"),
            // Gemini appends `.gemini` to this documented parent directory.
            Self::Gemini => Some("GEMINI_CLI_HOME"),
            // Cursor has no verified account-isolation selector. Its canonical account is
            // a reference to the native sign-in; leases still protect account operations.
            Self::Cursor => None,
        }
    }
}

/// Canonical root for account-scoped provider profiles and per-thread neutral directories.
#[derive(Clone)]
pub struct ManagedProfiles {
    root: PathBuf,
    guardian: Option<GuardianBinding>,
    priority: Arc<ProfilePriorityCoordinator>,
}

#[derive(Clone)]
struct GuardianBinding {
    authority: GuardianAuthority,
    profile_generation: ProfileGeneration,
}

impl std::fmt::Debug for ManagedProfiles {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ManagedProfiles")
            .field("root", &self.root)
            .field("guarded", &self.guardian.is_some())
            .finish()
    }
}

impl ManagedProfiles {
    /// Opens the one canonical managed-profile root beneath KalCode's data directory.
    pub fn for_data_dir(data_dir: &Path) -> Result<Self, ProviderError> {
        Self::new(data_dir.join(MANAGED_PROFILE_DIRECTORY))
    }

    /// Opens or creates an absolute managed-profile root directly below an existing directory.
    /// Every existing ancestor must be an ordinary directory rather than a symlink, junction, or
    /// other Windows reparse point.
    pub fn new(root: PathBuf) -> Result<Self, ProviderError> {
        if !root.is_absolute()
            || root.file_name().is_none()
            || root
                .components()
                .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        {
            return Err(ProviderError::Start(
                "managed profile storage must be an absolute child directory".into(),
            ));
        }
        let parent = root.parent().ok_or_else(|| {
            ProviderError::Start(
                "managed profile storage must have an existing parent directory".into(),
            )
        })?;
        verify_existing_directory(parent)?;
        let canonical_parent = canonicalize_directory(parent)?;

        match std::fs::symlink_metadata(&root) {
            Ok(metadata) => verify_directory_metadata(&metadata)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                create_private_directory(&root)?;
            }
            Err(error) => return Err(io_error("couldn't inspect managed profile storage", error)),
        }
        verify_existing_directory(&root)?;
        let canonical_root = canonicalize_directory(&root)?;
        if canonical_root.parent() != Some(canonical_parent.as_path()) {
            return Err(ProviderError::Start(UNSAFE_PATH.into()));
        }
        Ok(Self {
            priority: priority_coordinator(&canonical_root),
            root: canonical_root,
            guardian: None,
        })
    }

    /// Opens the canonical managed-profile root and binds every acquired profile lease to the
    /// same desktop-generation guardian authority.
    pub fn for_data_dir_guarded(
        data_dir: &Path,
        authority: GuardianAuthority,
        profile_generation: ProfileGeneration,
    ) -> Result<Self, ProviderError> {
        let mut profiles = Self::for_data_dir(data_dir)?;
        profiles.guardian = Some(GuardianBinding {
            authority,
            profile_generation,
        });
        Ok(profiles)
    }

    pub fn probe_guardian(&self) -> Result<ProviderProbeGuardian, ProviderError> {
        let binding = self.guardian.as_ref().ok_or_else(|| {
            ProviderError::Start("provider runtime guardian is not configured".into())
        })?;
        binding
            .authority
            .probe_guardian(binding.profile_generation)
            .map_err(|error| ProviderError::Start(error.to_string()))
    }

    /// Returns one account's dedicated provider profile, creating it without following links.
    ///
    /// For `gemini-cli` this is the parent exported as `GEMINI_CLI_HOME`; Gemini creates its
    /// `.gemini` child. Claude and Codex receive the directory directly through
    /// `CLAUDE_CONFIG_DIR` / `CLAUDE_SECURESTORAGE_CONFIG_DIR` and `CODEX_HOME` respectively.
    pub fn profile_home(&self, provider: &str, account_id: &str) -> Result<PathBuf, ProviderError> {
        let provider = ManagedProvider::parse(provider)?;
        self.account_root(provider, account_id)?;
        self.ensure_directory(&["providers", provider.id(), "accounts", account_id, "home"])
    }

    /// Returns one account's existing provider profile without creating anything, or `None` when
    /// the account has never been prepared. Passive readers (provider usage) use this.
    pub fn existing_profile_home(
        &self,
        provider: &str,
        account_id: &str,
    ) -> Result<Option<PathBuf>, ProviderError> {
        let provider = ManagedProvider::parse(provider)?;
        if !canonical_uuid(account_id) {
            return Err(ProviderError::Start(
                "managed profiles require a canonical account id".into(),
            ));
        }
        self.verify_root()?;
        let home = self
            .root
            .join("providers")
            .join(provider.id())
            .join("accounts")
            .join(account_id)
            .join("home");
        match std::fs::symlink_metadata(&home) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error("couldn't inspect a managed directory", error)),
        }
        verify_existing_directory(&home)?;
        let canonical = canonicalize_directory(&home)?;
        if !canonical.starts_with(&self.root) {
            return Err(ProviderError::Start(UNSAFE_PATH.into()));
        }
        Ok(Some(canonical))
    }

    /// Returns a stable provider/account/thread directory outside every repository.
    pub fn session_dir(
        &self,
        provider: &str,
        account_id: &str,
        thread_id: &str,
    ) -> Result<PathBuf, ProviderError> {
        let provider = ManagedProvider::parse(provider)?;
        if !canonical_uuid(thread_id) {
            return Err(ProviderError::Start(
                "managed profile sessions require a canonical thread id".into(),
            ));
        }
        self.account_root(provider, account_id)?;
        self.ensure_directory(&[
            "providers",
            provider.id(),
            "accounts",
            account_id,
            "sessions",
            thread_id,
        ])
    }

    /// Returns a stable provider/account directory used only by that account's supported sign-in
    /// flow. It is a sibling of the account's thread directories, outside every repository.
    pub fn sign_in_dir(&self, provider: &str, account_id: &str) -> Result<PathBuf, ProviderError> {
        let provider = ManagedProvider::parse(provider)?;
        self.account_root(provider, account_id)?;
        self.ensure_directory(&[
            "providers",
            provider.id(),
            "accounts",
            account_id,
            "sign-in",
        ])
    }

    /// Returns a cloned detection environment whose variables are also safe to launch.
    /// `HOME` and `USERPROFILE` remain unchanged so executable discovery still uses the person's
    /// normal installation locations; provider auth/config selectors are replaced by exactly one
    /// dedicated managed-profile selector.
    pub fn prepare_env(
        &self,
        provider: &str,
        account_id: &str,
        source: &DetectEnv,
    ) -> Result<DetectEnv, ProviderError> {
        Ok(DetectEnv {
            vars: self
                .launch_env(provider, account_id, source)?
                .into_iter()
                .collect(),
            windows: source.windows,
            probe_timeout: source.probe_timeout,
            system_root: source.system_root.clone(),
        })
    }

    /// Where the user's native provider configuration lives for `source`, ignoring anything
    /// inside this managed root.
    pub(crate) fn native_homes(&self, source: &DetectEnv) -> crate::native_config::NativeHomes {
        crate::native_config::NativeHomes::from_env(source, &self.root)
    }

    /// The complete environment to pass to a managed provider process: the user's own
    /// environment with this account's profile selector.
    pub fn launch_env(
        &self,
        provider: &str,
        account_id: &str,
        source: &DetectEnv,
    ) -> Result<BTreeMap<OsString, OsString>, ProviderError> {
        let provider = ManagedProvider::parse(provider)?;
        let Some(home_variable) = provider.home_variable() else {
            self.account_root(provider, account_id)?;
            return Ok(source.provider_env(&EnvPolicy::NATIVE));
        };
        let home = self.profile_home(provider.id(), account_id)?;
        // The user's own environment, as in a native terminal (native provider parity), minus
        // only what would make this provider authenticate as something other than the selected
        // account: its API keys/tokens and its own profile selectors.
        let mut env = source.provider_env(&EnvPolicy::NATIVE);
        crate::env::strip_auth_overrides(&mut env, provider.id());
        // The plain form names the same directory as the canonical `\\?\` verbatim path, which
        // Node.js tools, shells and plugin hooks running under the provider do not handle
        // (Gemini CLI 0.61.0 crashes at startup with "EISDIR: illegal operation on a directory,
        // lstat 'C:'"; `cmd.exe` refuses a verbatim working directory).
        let selected_home = plain_path(&home);
        env.insert(home_variable.into(), selected_home.clone().into_os_string());
        if matches!(provider, ManagedProvider::Claude) {
            // Claude Code resolves its credential store independently from general config in
            // current native builds. Pin both selectors to the exact same account directory so
            // a managed session cannot authenticate as a standalone or different managed
            // account while displaying this profile's cached identity.
            env.insert(
                "CLAUDE_SECURESTORAGE_CONFIG_DIR".into(),
                selected_home.into_os_string(),
            );
        }
        // The user's native settings, MCP servers, plugins, skills, agents and instructions
        // reach this profile; its credentials and session state stay its own.
        crate::native_config::sync(
            provider.id(),
            &crate::native_config::NativeHomes::from_env(source, &self.root),
            &home,
        );
        Ok(env)
    }

    /// Acquires a shared lease held for one provider session's lifetime. Multiple sessions may
    /// share a profile, while an exclusive sign-in lease is rejected until all sessions end.
    pub fn acquire_session_lease(
        &self,
        provider: &str,
        account_id: &str,
    ) -> Result<ProfileLease, ProviderError> {
        self.acquire_lease(provider, account_id, LeaseMode::SharedSession)
            .map_err(ProfileLeaseError::into_provider_error)
    }

    /// Acquires a shared, read-only observer lease. Explicit authentication or lifecycle writers
    /// cancel and drain observers before taking the exclusive OS profile lock; ordinary sessions
    /// may run concurrently because observers never refresh or write provider credentials.
    pub fn acquire_observer_lease(
        &self,
        provider: &str,
        account_id: &str,
    ) -> Result<ProfileLease, ProviderError> {
        self.acquire_lease(provider, account_id, LeaseMode::SharedObserver)
            .map_err(ProfileLeaseError::into_provider_error)
    }

    /// Acquires the exclusive lease required while running the provider's supported sign-in
    /// flow. It fails immediately when a session or another sign-in currently uses the profile.
    pub fn acquire_sign_in_lease(
        &self,
        provider: &str,
        account_id: &str,
    ) -> Result<ProfileLease, ProviderError> {
        self.acquire_lease(provider, account_id, LeaseMode::ExclusiveAuth)
            .map_err(ProfileLeaseError::into_provider_error)
    }

    /// Acquires the exclusive lock used to archive account metadata. It shares the exact lock
    /// domain used by provider sessions and supported sign-in flows.
    pub fn acquire_account_lifecycle_lease(
        &self,
        provider: &str,
        account_id: &str,
    ) -> Result<ProfileLease, ProfileLifecycleLeaseError> {
        self.acquire_lease(provider, account_id, LeaseMode::ExclusiveLifecycle)
            .map_err(|error| match error {
                ProfileLeaseError::InUse => ProfileLifecycleLeaseError::InUse,
                ProfileLeaseError::Unavailable(error) => {
                    ProfileLifecycleLeaseError::Unavailable(error)
                }
            })
    }

    fn acquire_lease(
        &self,
        provider: &str,
        account_id: &str,
        mode: LeaseMode,
    ) -> Result<ProfileLease, ProfileLeaseError> {
        let provider = ManagedProvider::parse(provider).map_err(ProfileLeaseError::Unavailable)?;
        // A lease is useful only for a profile whose complete path still passes the same
        // containment/link checks as environment preparation.
        self.profile_home(provider.id(), account_id)
            .map_err(ProfileLeaseError::Unavailable)?;
        let key = (provider.id(), account_id.to_owned());
        let observer = match mode {
            LeaseMode::SharedObserver => Some(self.priority.begin_observer(key.clone())?),
            LeaseMode::SharedSession => None,
            LeaseMode::ExclusiveAuth | LeaseMode::ExclusiveLifecycle => None,
        };
        // Retain this short admission until the OS shared lock attempt completes so a lifecycle
        // writer that has declared priority cannot be overtaken between the check and the lock.
        let _reader = match mode {
            LeaseMode::SharedSession => Some(self.priority.admit_reader(key.clone())?),
            LeaseMode::SharedObserver
            | LeaseMode::ExclusiveAuth
            | LeaseMode::ExclusiveLifecycle => None,
        };
        let _writer = match mode {
            LeaseMode::ExclusiveAuth | LeaseMode::ExclusiveLifecycle => {
                Some(self.priority.begin_writer(key, OBSERVER_DRAIN_TIMEOUT)?)
            }
            LeaseMode::SharedObserver | LeaseMode::SharedSession => None,
        };
        let locks = self
            .ensure_directory(&["providers", provider.id(), "accounts", account_id, "locks"])
            .map_err(ProfileLeaseError::Unavailable)?;
        let path = locks.join("profile.lock");
        verify_regular_file_or_missing(&path).map_err(ProfileLeaseError::Unavailable)?;
        let file = open_private_lock_file(&path).map_err(ProfileLeaseError::Unavailable)?;
        verify_regular_file_or_missing(&path).map_err(ProfileLeaseError::Unavailable)?;
        let result = match mode {
            LeaseMode::SharedObserver | LeaseMode::SharedSession => {
                lease_file(&file).try_lock_shared()
            }
            LeaseMode::ExclusiveAuth | LeaseMode::ExclusiveLifecycle => {
                lease_file(&file).try_lock()
            }
        };
        match result {
            Ok(()) => {
                let guardian = match &self.guardian {
                    Some(binding) => {
                        let account_id = uuid::Uuid::try_parse(account_id).map_err(|_| {
                            ProfileLeaseError::Unavailable(ProviderError::Start(
                                "managed profiles require a canonical account id".into(),
                            ))
                        })?;
                        let identity = ProfileIdentity::new(
                            kalcode_contracts::agent::ProviderId::new(provider.id()),
                            account_id,
                            binding.profile_generation,
                        )
                        .map_err(guardian_provider_error)?;
                        Some(
                            binding
                                .authority
                                .acquire(identity, mode.capability())
                                .map_err(guardian_provider_error)?,
                        )
                    }
                    None => None,
                };
                Ok(ProfileLease {
                    _file: file,
                    root: self.root.clone(),
                    provider: provider.id(),
                    account_id: account_id.to_owned(),
                    exclusive: matches!(
                        mode,
                        LeaseMode::ExclusiveAuth | LeaseMode::ExclusiveLifecycle
                    ),
                    guardian,
                    observer,
                })
            }
            Err(std::fs::TryLockError::WouldBlock) => Err(ProfileLeaseError::InUse),
            Err(std::fs::TryLockError::Error(error)) => Err(ProfileLeaseError::Unavailable(
                io_error("couldn't lock the managed provider profile", error),
            )),
        }
    }

    fn ensure_directory(&self, components: &[&str]) -> Result<PathBuf, ProviderError> {
        self.verify_root()?;
        let mut current = self.root.clone();
        for component in components {
            if !safe_component(component) {
                return Err(ProviderError::Start(UNSAFE_PATH.into()));
            }
            current.push(component);
            match std::fs::symlink_metadata(&current) {
                Ok(metadata) => verify_directory_metadata(&metadata)?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    create_private_directory(&current)?;
                }
                Err(error) => {
                    return Err(io_error("couldn't inspect a managed directory", error));
                }
            }
            verify_existing_directory(&current)?;
            let canonical = canonicalize_directory(&current)?;
            if !canonical.starts_with(&self.root) {
                return Err(ProviderError::Start(UNSAFE_PATH.into()));
            }
            current = canonical;
        }
        Ok(current)
    }

    fn account_root(
        &self,
        provider: ManagedProvider,
        account_id: &str,
    ) -> Result<PathBuf, ProviderError> {
        if !canonical_uuid(account_id) {
            return Err(ProviderError::Start(
                "managed profiles require a canonical account id".into(),
            ));
        }
        self.ensure_directory(&["providers", provider.id(), "accounts", account_id])
    }

    fn verify_root(&self) -> Result<(), ProviderError> {
        verify_existing_directory(&self.root)?;
        if canonicalize_directory(&self.root)? != self.root {
            return Err(ProviderError::Start(UNSAFE_PATH.into()));
        }
        Ok(())
    }
}

/// Holds an OS file lock. Dropping this value releases the session/sign-in lease; no stale PID
/// file or recovery heuristic is involved.
#[must_use = "the managed-profile lease must be retained for the operation's lifetime"]
pub struct ProfileLease {
    _file: ProfileLockFile,
    root: PathBuf,
    provider: &'static str,
    account_id: String,
    exclusive: bool,
    guardian: Option<GuardianLease>,
    observer: Option<ObserverAdmission>,
}

impl ProfileLease {
    /// Creates a PREPARED guardian job while this exact OS profile lease is held.
    pub fn prepare_guarded_job(&self, label: &str) -> Result<RegisteredJob, ProviderError> {
        let guardian = self.guardian.as_ref().ok_or_else(|| {
            ProviderError::Start("provider runtime guardian is not configured".into())
        })?;
        guardian
            .prepare_job(label.to_owned())
            .map_err(|error| ProviderError::Start(error.to_string()))
    }

    /// Confirms that a caller-supplied lease is the exclusive guard for this exact profile.
    /// This prevents an authentication adapter from accidentally preparing one account while
    /// retaining an unrelated account's lock.
    pub(crate) fn is_exclusive_for(
        &self,
        profiles: &ManagedProfiles,
        provider: &str,
        account_id: &str,
    ) -> bool {
        self.exclusive
            && self.root == profiles.root
            && self.provider == provider
            && self.account_id == account_id
    }

    /// Confirms that a caller-supplied lease is the read-only observer guard for this profile.
    pub(crate) fn is_observer_for(
        &self,
        profiles: &ManagedProfiles,
        provider: &str,
        account_id: &str,
    ) -> bool {
        self.observer.is_some()
            && self.root == profiles.root
            && self.provider == provider
            && self.account_id == account_id
    }

    /// Cancellation signal asserted when an explicit sign-in, sign-out, or archive takes priority.
    pub(crate) fn observer_cancellation(&self) -> Option<Arc<AtomicBool>> {
        self.observer
            .as_ref()
            .map(|observer| Arc::clone(&observer.canceled))
    }
}

/// A profile lease with independent owners for the session object and process-exit waiter. The
/// underlying OS lock is released only after every owner has been dropped.
#[derive(Clone)]
pub struct SharedProfileLease {
    _lease: Arc<ProfileLease>,
}

impl SharedProfileLease {
    pub fn prepare_guarded_job(&self, label: &str) -> Result<RegisteredJob, ProviderError> {
        self._lease.prepare_guarded_job(label)
    }
}

/// Converts an acquired lease into a shareable lifetime guard.
pub fn share_profile_lease(lease: ProfileLease) -> SharedProfileLease {
    SharedProfileLease {
        _lease: Arc::new(lease),
    }
}

/// Retains account isolation until the underlying session has been dropped. A successful
/// `terminate` does not unlock early: the provider may still be draining its process tree.
pub fn hold_session_lease(
    session: Box<dyn AgentSession>,
    lease: ProfileLease,
) -> Box<dyn AgentSession> {
    hold_shared_session_lease(session, share_profile_lease(lease))
}

/// Retains one owner of a shared profile lease until the underlying session has been dropped.
/// Another owner may be held by a process-exit waiter so a kill request cannot unlock early.
pub fn hold_shared_session_lease(
    session: Box<dyn AgentSession>,
    lease: SharedProfileLease,
) -> Box<dyn AgentSession> {
    Box::new(LeasedSession {
        session,
        _lease: lease,
    })
}

struct LeasedSession {
    // Rust drops fields in declaration order: provider cleanup precedes unlocking its profile.
    session: Box<dyn AgentSession>,
    _lease: SharedProfileLease,
}

impl AgentSession for LeasedSession {
    fn provider_session_id(&self) -> Option<String> {
        self.session.provider_session_id()
    }
    fn send(&self, input: AgentInput) -> Result<(), ProviderError> {
        self.session.send(input)
    }
    fn interrupt(&self) -> Result<(), ProviderError> {
        self.session.interrupt()
    }
    fn terminate(&self) -> Result<(), ProviderError> {
        self.session.terminate()
    }
    fn respond_to_approval(
        &self,
        request_id: &str,
        decision: ApprovalDecision,
    ) -> Result<(), ProviderError> {
        self.session.respond_to_approval(request_id, decision)
    }
}

#[derive(Clone, Copy)]
enum LeaseMode {
    SharedObserver,
    SharedSession,
    ExclusiveAuth,
    ExclusiveLifecycle,
}

impl LeaseMode {
    const fn capability(self) -> ProfileCapability {
        match self {
            Self::SharedObserver | Self::SharedSession => ProfileCapability::SharedSession,
            Self::ExclusiveAuth => ProfileCapability::ExclusiveAuth,
            Self::ExclusiveLifecycle => ProfileCapability::ExclusiveLifecycle,
        }
    }
}

fn guardian_provider_error(error: crate::guardian::GuardianError) -> ProfileLeaseError {
    ProfileLeaseError::Unavailable(ProviderError::Start(error.to_string()))
}

/// The ordinary form of a canonical path for a provider that cannot take Windows verbatim paths
/// (`\\?\C:\…` becomes `C:\…`, `\\?\UNC\server\share\…` becomes `\\server\share\…`). Every
/// other path, including other verbatim forms, is returned unchanged.
pub(crate) fn plain_path(path: &Path) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path.to_path_buf();
    };
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\")
        && rest.as_bytes().get(1) == Some(&b':')
    {
        return PathBuf::from(rest);
    }
    path.to_path_buf()
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::try_parse(value).is_ok_and(|id| id.hyphenated().to_string().as_str() == value)
}

fn safe_component(value: &str) -> bool {
    let mut components = Path::new(value).components();
    matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none()
}

fn canonicalize_directory(path: &Path) -> Result<PathBuf, ProviderError> {
    std::fs::canonicalize(path).map_err(|error| io_error("couldn't resolve managed storage", error))
}

fn verify_existing_directory(path: &Path) -> Result<(), ProviderError> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        let metadata = std::fs::symlink_metadata(ancestor)
            .map_err(|error| io_error("couldn't inspect managed storage ancestry", error))?;
        verify_directory_metadata(&metadata)?;
    }
    Ok(())
}

fn verify_directory_metadata(metadata: &std::fs::Metadata) -> Result<(), ProviderError> {
    if is_link_or_reparse(metadata) || !metadata.is_dir() {
        return Err(ProviderError::Start(UNSAFE_PATH.into()));
    }
    Ok(())
}

fn verify_regular_file_or_missing(path: &Path) -> Result<(), ProviderError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if !is_link_or_reparse(&metadata) && metadata.is_file() => Ok(()),
        Ok(_) => Err(ProviderError::Start(UNSAFE_PATH.into())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(io_error("couldn't inspect a managed lock", error)),
    }
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(unix)]
fn create_private_directory(path: &Path) -> Result<(), ProviderError> {
    use std::os::unix::fs::DirBuilderExt;

    let mut builder = std::fs::DirBuilder::new();
    builder.mode(0o700);
    match builder.create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(io_error("couldn't create managed profile storage", error)),
    }
}

#[cfg(not(unix))]
fn create_private_directory(path: &Path) -> Result<(), ProviderError> {
    match std::fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(io_error("couldn't create managed profile storage", error)),
    }
}

#[cfg(windows)]
type ProfileLockFile = managed_lock::ManagedProfileLock;

#[cfg(not(windows))]
type ProfileLockFile = File;

#[cfg(windows)]
fn lease_file(lock: &ProfileLockFile) -> &File {
    lock.file()
}

#[cfg(not(windows))]
fn lease_file(lock: &ProfileLockFile) -> &File {
    lock
}

#[cfg(windows)]
fn open_private_lock_file(path: &Path) -> Result<ProfileLockFile, ProviderError> {
    let parent = path.parent().ok_or_else(|| {
        ProviderError::Start("managed profile lock must have a parent directory".into())
    })?;
    let name = path
        .file_name()
        .ok_or_else(|| ProviderError::Start("managed profile lock must have a file name".into()))?;
    managed_lock::ManagedProfileLock::open(parent, name)
        .map_err(|error| io_error("couldn't open a managed profile lease", error))
}

#[cfg(not(windows))]
fn open_private_lock_file(path: &Path) -> Result<ProfileLockFile, ProviderError> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|error| io_error("couldn't open a managed profile lease", error))
}

fn io_error(context: &str, error: std::io::Error) -> ProviderError {
    ProviderError::Io(format!("{context}: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::time::Duration;

    fn source(vars: &[(&str, &OsStr)]) -> DetectEnv {
        DetectEnv {
            vars: vars
                .iter()
                .map(|(name, value)| (OsString::from(name), (*value).to_os_string()))
                .collect(),
            windows: cfg!(windows),
            probe_timeout: Some(Duration::from_millis(17)),
            system_root: None,
        }
    }

    fn value<'a>(env: &'a DetectEnv, name: &str) -> Option<&'a OsStr> {
        env.vars
            .iter()
            .find(|(key, _)| {
                key.to_str()
                    .is_some_and(|key| key.eq_ignore_ascii_case(name))
            })
            .map(|(_, value)| value.as_os_str())
    }

    fn fixture_root(temp: &tempfile::TempDir) -> PathBuf {
        if cfg!(target_os = "macos") {
            temp.path().canonicalize().expect("canonical temp")
        } else {
            temp.path().to_path_buf()
        }
    }

    #[test]
    fn plain_path_strips_only_drive_and_unc_verbatim_prefixes() {
        assert_eq!(
            plain_path(Path::new(r"\\?\C:\data\home")),
            PathBuf::from(r"C:\data\home")
        );
        assert_eq!(
            plain_path(Path::new(r"\\?\UNC\server\share\home")),
            PathBuf::from(r"\\server\share\home")
        );
        assert_eq!(
            plain_path(Path::new(r"\\?\GLOBALROOT\x")),
            PathBuf::from(r"\\?\GLOBALROOT\x")
        );
        assert_eq!(
            plain_path(Path::new("/tmp/home")),
            PathBuf::from("/tmp/home")
        );
    }

    #[test]
    fn gemini_home_selector_is_never_a_verbatim_path() {
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = fixture_root(&temp);
        let profiles = ManagedProfiles::new(temp_root.join("managed")).expect("profiles");
        let account_id = kalcode_contracts::ids::new_id();
        let env = profiles
            .launch_env("gemini-cli", &account_id, &source(&[]))
            .expect("env");
        let home = env
            .get(OsStr::new("GEMINI_CLI_HOME"))
            .expect("gemini home selector");
        assert!(
            !home.to_string_lossy().starts_with(r"\\?\"),
            "{}",
            home.to_string_lossy()
        );
        assert_eq!(
            std::fs::canonicalize(home).expect("same directory"),
            profiles
                .profile_home("gemini-cli", &account_id)
                .expect("profile home")
        );
    }

    #[test]
    fn root_must_be_an_absolute_child_of_an_existing_directory() {
        assert!(ManagedProfiles::new(PathBuf::from("relative/profiles")).is_err());

        let temp = tempfile::tempdir().expect("temp");
        let temp_root = fixture_root(&temp);
        let root = temp_root.join("managed");
        let profiles = ManagedProfiles::new(root.clone()).expect("managed profiles");
        assert!(root.is_dir());
        assert_eq!(
            profiles.root,
            std::fs::canonicalize(root).expect("canonical")
        );

        assert!(ManagedProfiles::new(temp_root.join("missing/child")).is_err());
    }

    #[test]
    fn profile_and_session_paths_are_stable_and_reject_untrusted_names() {
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = fixture_root(&temp);
        let profiles = ManagedProfiles::new(temp_root.join("managed")).expect("profiles");
        let account_id = kalcode_contracts::ids::new_id();
        let thread_id = kalcode_contracts::ids::new_id();

        let codex = profiles
            .profile_home("codex", &account_id)
            .expect("codex home");
        assert_eq!(
            codex,
            profiles
                .profile_home("codex", &account_id)
                .expect("stable home")
        );
        let claude = profiles
            .profile_home("claude-code", &account_id)
            .expect("claude home");
        assert_ne!(claude, codex);
        assert!(profiles.profile_home("unknown", &account_id).is_err());
        for invalid in [
            "../escape",
            "not-a-uuid",
            "0192f3c4-0000-7000-8000-00000000000A",
        ] {
            assert!(
                profiles.profile_home("codex", invalid).is_err(),
                "{invalid}"
            );
        }

        let session = profiles
            .session_dir("gemini-cli", &account_id, &thread_id)
            .expect("session");
        assert_eq!(
            session,
            profiles
                .session_dir("gemini-cli", &account_id, &thread_id)
                .expect("stable session")
        );
        assert!(
            session.starts_with(
                profiles
                    .root
                    .join("providers")
                    .join("gemini-cli")
                    .join("accounts")
                    .join(&account_id)
            )
        );
        for invalid in [
            "../escape",
            "not-a-uuid",
            "0192f3c4-0000-7000-8000-00000000000A",
        ] {
            assert!(
                profiles.session_dir("codex", &account_id, invalid).is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn launch_env_is_the_users_environment_and_never_touches_original_auth_files() {
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = fixture_root(&temp);
        let original = temp_root.join("person");
        std::fs::create_dir(&original).expect("person home");
        let codex_config = original.join(".codex");
        let gemini_config = original.join(".gemini");
        let claude_config = original.join(".claude");
        std::fs::create_dir(&codex_config).expect("codex config");
        std::fs::create_dir(&gemini_config).expect("gemini config");
        std::fs::create_dir(&claude_config).expect("claude config");
        let codex_auth = codex_config.join("auth.json");
        let gemini_auth = gemini_config.join("oauth_creds.json");
        let claude_auth = claude_config.join(".credentials.json");
        std::fs::write(&codex_auth, b"original-codex").expect("codex fixture");
        std::fs::write(&gemini_auth, b"original-gemini").expect("gemini fixture");
        std::fs::write(&claude_auth, b"original-claude").expect("claude fixture");
        let hostile_codex = temp_root.join("hostile-codex");
        let hostile_gemini = temp_root.join("hostile-gemini");
        let hostile_claude = temp_root.join("hostile-claude");
        let hostile_claude_credentials = temp_root.join("hostile-claude-credentials");
        let source = source(&[
            ("HOME", original.as_os_str()),
            ("USERPROFILE", original.as_os_str()),
            ("PATH", temp_root.as_os_str()),
            ("CODEX_HOME", hostile_codex.as_os_str()),
            ("GEMINI_CLI_HOME", hostile_gemini.as_os_str()),
            ("CLAUDE_CONFIG_DIR", hostile_claude.as_os_str()),
            (
                "CLAUDE_SECURESTORAGE_CONFIG_DIR",
                hostile_claude_credentials.as_os_str(),
            ),
            ("ANTHROPIC_API_KEY", OsStr::new("fixture-anthropic")),
            ("OPENAI_API_KEY", OsStr::new("fixture-openai")),
            ("GEMINI_API_KEY", OsStr::new("fixture-gemini")),
            ("GEMINI_FORCE_ENCRYPTED_FILE_STORAGE", OsStr::new("true")),
            ("GEMINI_FORCE_FILE_STORAGE", OsStr::new("true")),
            ("GOOGLE_APPLICATION_CREDENTIALS", OsStr::new("fixture-path")),
            ("KALCODE_INTERNAL", OsStr::new("test-internal")),
        ]);
        let profiles = ManagedProfiles::new(temp_root.join("managed")).expect("profiles");
        let account_a = kalcode_contracts::ids::new_id();
        let account_b = kalcode_contracts::ids::new_id();

        let codex = profiles
            .prepare_env("codex", &account_a, &source)
            .expect("codex env");
        let gemini = profiles
            .prepare_env("gemini-cli", &account_a, &source)
            .expect("gemini env");
        let claude = profiles
            .prepare_env("claude-code", &account_a, &source)
            .expect("claude env");
        let codex_b = profiles
            .prepare_env("codex", &account_b, &source)
            .expect("second codex account");

        assert_eq!(value(&codex, "HOME"), Some(original.as_os_str()));
        assert_eq!(value(&codex, "USERPROFILE"), Some(original.as_os_str()));
        let home = |provider: &str, account: &str| {
            plain_path(&profiles.profile_home(provider, account).expect("home")).into_os_string()
        };
        // Each provider's own selector names this account's profile, in the plain path form.
        assert_eq!(
            value(&codex, "CODEX_HOME"),
            Some(home("codex", &account_a).as_os_str())
        );
        assert_eq!(
            value(&gemini, "GEMINI_CLI_HOME"),
            Some(home("gemini-cli", &account_a).as_os_str())
        );
        assert_eq!(
            value(&claude, "CLAUDE_CONFIG_DIR"),
            Some(home("claude-code", &account_a).as_os_str())
        );
        assert_eq!(
            value(&claude, "CLAUDE_SECURESTORAGE_CONFIG_DIR"),
            value(&claude, "CLAUDE_CONFIG_DIR"),
            "Claude's credential store and account metadata must select the same managed profile"
        );
        assert_ne!(value(&codex, "CODEX_HOME"), value(&codex_b, "CODEX_HOME"));
        // Only what would authenticate a provider as someone else is dropped, and only for that
        // provider; everything else is the user's own environment, as in a native terminal.
        assert!(value(&codex, "OPENAI_API_KEY").is_none());
        assert!(value(&claude, "ANTHROPIC_API_KEY").is_none());
        assert!(value(&gemini, "GEMINI_API_KEY").is_none());
        assert_eq!(
            value(&codex, "ANTHROPIC_API_KEY"),
            Some(OsStr::new("fixture-anthropic"))
        );
        assert_eq!(
            value(&claude, "OPENAI_API_KEY"),
            Some(OsStr::new("fixture-openai"))
        );
        assert_eq!(
            value(&codex, "CLAUDE_CONFIG_DIR"),
            Some(hostile_claude.as_os_str())
        );
        for name in [
            "GEMINI_FORCE_ENCRYPTED_FILE_STORAGE",
            "GOOGLE_APPLICATION_CREDENTIALS",
        ] {
            assert!(value(&claude, name).is_some(), "claude lost {name}");
            assert!(value(&gemini, name).is_some(), "gemini lost {name}");
        }
        for env in [&codex, &gemini, &claude] {
            assert!(value(env, "KALCODE_INTERNAL").is_none());
        }
        assert_eq!(codex.probe_timeout, source.probe_timeout);
        assert_eq!(gemini.windows, source.windows);
        assert_eq!(
            value(&source, "CODEX_HOME"),
            Some(hostile_codex.as_os_str())
        );
        assert_eq!(
            std::fs::read(codex_auth).expect("codex fixture unchanged"),
            b"original-codex"
        );
        assert_eq!(
            std::fs::read(gemini_auth).expect("gemini fixture unchanged"),
            b"original-gemini"
        );
        assert_eq!(
            std::fs::read(claude_auth).expect("claude fixture unchanged"),
            b"original-claude"
        );
    }

    #[test]
    fn shared_session_leases_exclude_sign_in_and_sign_in_excludes_sessions() {
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = fixture_root(&temp);
        let profiles = ManagedProfiles::new(temp_root.join("managed")).expect("profiles");
        let account_a = kalcode_contracts::ids::new_id();
        let account_b = kalcode_contracts::ids::new_id();

        let first = profiles
            .acquire_session_lease("codex", &account_a)
            .expect("first session");
        let second = profiles
            .acquire_session_lease("codex", &account_a)
            .expect("second session");
        assert!(profiles.acquire_sign_in_lease("codex", &account_a).is_err());
        let independent = profiles
            .acquire_sign_in_lease("codex", &account_b)
            .expect("independent account sign in");
        drop(independent);
        drop((first, second));

        let sign_in = profiles
            .acquire_sign_in_lease("codex", &account_a)
            .expect("sign in");
        assert!(profiles.acquire_session_lease("codex", &account_a).is_err());
        assert!(profiles.acquire_sign_in_lease("codex", &account_a).is_err());
        let other_account = profiles
            .acquire_session_lease("codex", &account_b)
            .expect("other account session");
        drop(other_account);
        drop(sign_in);
        let _released = profiles
            .acquire_session_lease("codex", &account_a)
            .expect("released lease");
    }

    #[test]
    fn lifecycle_writer_cancels_exact_observer_and_blocks_later_same_account_readers() {
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = fixture_root(&temp);
        let profiles = Arc::new(ManagedProfiles::new(temp_root.join("managed")).expect("profiles"));
        let same_root = Arc::new(
            ManagedProfiles::new(temp_root.join("managed")).expect("same canonical profiles"),
        );
        let account = kalcode_contracts::ids::new_id();
        let other = kalcode_contracts::ids::new_id();
        let observer = profiles
            .acquire_observer_lease("codex", &account)
            .expect("observer");
        let canceled = observer
            .observer_cancellation()
            .expect("observer cancellation");

        let writer_profiles = Arc::clone(&same_root);
        let writer_account = account.clone();
        let writer = std::thread::spawn(move || {
            writer_profiles.acquire_account_lifecycle_lease("codex", &writer_account)
        });
        let deadline = Instant::now() + Duration::from_secs(1);
        while !canceled.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(
            canceled.load(Ordering::Acquire),
            "writer must cancel observer"
        );
        assert!(profiles.acquire_observer_lease("codex", &account).is_err());
        assert!(profiles.acquire_session_lease("codex", &account).is_err());
        let independent = profiles
            .acquire_session_lease("codex", &other)
            .expect("other account remains independent");
        drop(independent);

        drop(observer);
        let exclusive = writer.join().expect("writer thread").expect("writer lease");
        assert!(profiles.acquire_session_lease("codex", &account).is_err());
        drop(exclusive);
        let _released = profiles
            .acquire_session_lease("codex", &account)
            .expect("reader after lifecycle writer");
    }

    #[test]
    fn timed_out_writer_admission_clears_priority_gate() {
        let coordinator = Arc::new(ProfilePriorityCoordinator::default());
        let key = ("codex", kalcode_contracts::ids::new_id());
        let observer = coordinator
            .begin_observer(key.clone())
            .expect("observer admission");
        assert!(matches!(
            coordinator.begin_writer(key.clone(), Duration::from_millis(10)),
            Err(ProfileLeaseError::InUse)
        ));
        drop(observer);
        let _reader = coordinator
            .begin_observer(key)
            .expect("timed-out writer must clear pending admission");
    }

    #[test]
    fn canonical_data_root_and_lifecycle_lease_share_the_profile_lock() {
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = fixture_root(&temp);
        let profiles = ManagedProfiles::for_data_dir(&temp_root).expect("profiles");
        let same = ManagedProfiles::for_data_dir(&temp_root).expect("same root");
        let account = kalcode_contracts::ids::new_id();
        let session = profiles
            .acquire_session_lease("codex", &account)
            .expect("session");
        assert!(
            same.acquire_account_lifecycle_lease("codex", &account)
                .is_err()
        );
        drop(session);
        let exclusive = same
            .acquire_account_lifecycle_lease("codex", &account)
            .expect("lifecycle lease");
        assert!(profiles.acquire_session_lease("codex", &account).is_err());
        drop(exclusive);
        let _released = profiles
            .acquire_session_lease("codex", &account)
            .expect("released");
    }

    #[cfg(windows)]
    #[test]
    fn live_profile_lock_file_cannot_be_renamed_or_replaced() {
        let temp = tempfile::tempdir().expect("temp");
        let profiles = ManagedProfiles::new(temp.path().join("managed")).expect("profiles");
        let account = kalcode_contracts::ids::new_id();
        let session = profiles
            .acquire_session_lease("codex", &account)
            .expect("session");
        let locks = profiles
            .root
            .join("providers")
            .join("codex")
            .join("accounts")
            .join(&account)
            .join("locks");
        let lock = locks.join("profile.lock");

        assert!(
            std::fs::rename(&lock, locks.join("profile.lock.old")).is_err(),
            "a live profile lock must not be renameable out of its namespace"
        );
        assert!(
            profiles.acquire_sign_in_lease("codex", &account).is_err(),
            "an exclusive lease must not acquire a replacement lock while a session is live"
        );
        drop(session);
    }

    #[cfg(windows)]
    #[test]
    fn live_profile_lock_parent_cannot_be_renamed_or_replaced() {
        let temp = tempfile::tempdir().expect("temp");
        let profiles = ManagedProfiles::new(temp.path().join("managed")).expect("profiles");
        let account = kalcode_contracts::ids::new_id();
        let session = profiles
            .acquire_session_lease("codex", &account)
            .expect("session");
        let account_root = profiles
            .root
            .join("providers")
            .join("codex")
            .join("accounts")
            .join(&account);
        let locks = account_root.join("locks");

        assert!(
            std::fs::rename(&locks, account_root.join("locks.old")).is_err(),
            "a live profile lock parent must not be renameable"
        );
        assert!(
            profiles.acquire_sign_in_lease("codex", &account).is_err(),
            "an exclusive lease must not acquire a recreated parent while a session is live"
        );
        drop(session);
    }

    #[cfg(windows)]
    #[test]
    fn multiply_linked_profile_lock_is_rejected() {
        let temp = tempfile::tempdir().expect("temp");
        let profiles = ManagedProfiles::new(temp.path().join("managed")).expect("profiles");
        let account = kalcode_contracts::ids::new_id();
        let locks = profiles
            .ensure_directory(&["providers", "codex", "accounts", &account, "locks"])
            .expect("locks");
        let lock = locks.join("profile.lock");
        std::fs::write(&lock, b"").expect("lock fixture");
        std::fs::hard_link(&lock, temp.path().join("profile-lock-alias"))
            .expect("hardlink fixture");

        assert!(
            profiles.acquire_session_lease("codex", &account).is_err(),
            "a multiply linked lock must never become the account lease authority"
        );
    }

    #[cfg(windows)]
    #[test]
    fn shared_and_exclusive_lock_domain_fails_closed_under_contention() {
        let temp = tempfile::tempdir().expect("temp");
        let profiles =
            Arc::new(ManagedProfiles::new(temp.path().join("managed")).expect("managed profiles"));
        let account = kalcode_contracts::ids::new_id();
        let shared = profiles
            .acquire_session_lease("codex", &account)
            .expect("shared lease");
        let barrier = Arc::new(std::sync::Barrier::new(9));
        let mut contenders = Vec::new();
        for _ in 0..8 {
            let profiles = Arc::clone(&profiles);
            let account = account.clone();
            let barrier = Arc::clone(&barrier);
            contenders.push(std::thread::spawn(move || {
                barrier.wait();
                profiles.acquire_sign_in_lease("codex", &account).is_err()
            }));
        }
        barrier.wait();
        assert!(
            contenders
                .into_iter()
                .all(|contender| contender.join().expect("contender")),
            "every concurrent exclusive contender must fail while a shared lease is live"
        );
        drop(shared);
        let _exclusive = profiles
            .acquire_sign_in_lease("codex", &account)
            .expect("exclusive after shared lease release");
    }

    #[test]
    fn session_wrapper_retains_the_lease_through_provider_cleanup() {
        struct Session {
            profiles: ManagedProfiles,
            account: String,
            dropped: std::sync::Arc<std::sync::atomic::AtomicBool>,
        }
        impl AgentSession for Session {
            fn provider_session_id(&self) -> Option<String> {
                Some("fixture-session".into())
            }
            fn send(&self, _: AgentInput) -> Result<(), ProviderError> {
                Ok(())
            }
            fn interrupt(&self) -> Result<(), ProviderError> {
                Ok(())
            }
            fn terminate(&self) -> Result<(), ProviderError> {
                Ok(())
            }
            fn respond_to_approval(
                &self,
                _: &str,
                _: ApprovalDecision,
            ) -> Result<(), ProviderError> {
                Err(ProviderError::Unsupported)
            }
        }
        impl Drop for Session {
            fn drop(&mut self) {
                assert!(
                    self.profiles
                        .acquire_sign_in_lease("codex", &self.account)
                        .is_err()
                );
                self.dropped
                    .store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = fixture_root(&temp);
        let profiles = ManagedProfiles::new(temp_root.join("managed")).expect("profiles");
        let account = kalcode_contracts::ids::new_id();
        let lease = profiles
            .acquire_session_lease("codex", &account)
            .expect("lease");
        let dropped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let session = hold_session_lease(
            Box::new(Session {
                profiles: profiles.clone(),
                account: account.clone(),
                dropped: dropped.clone(),
            }),
            lease,
        );
        assert_eq!(
            session.provider_session_id().as_deref(),
            Some("fixture-session")
        );
        session.terminate().expect("terminate");
        assert!(profiles.acquire_sign_in_lease("codex", &account).is_err());
        drop(session);
        assert!(dropped.load(std::sync::atomic::Ordering::SeqCst));
        let _released = profiles
            .acquire_sign_in_lease("codex", &account)
            .expect("released after cleanup");
    }

    #[test]
    fn linked_ancestry_and_linked_profile_directories_are_rejected_when_supported() {
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = fixture_root(&temp);
        let outside = temp_root.join("outside");
        std::fs::create_dir(&outside).expect("outside");
        let linked_parent = temp_root.join("linked-parent");
        if !directory_link(&outside, &linked_parent) {
            eprintln!("directory links are unavailable; link cases skipped");
            return;
        }
        assert!(ManagedProfiles::new(linked_parent.join("managed")).is_err());

        let profiles = ManagedProfiles::new(temp_root.join("managed")).expect("profiles");
        let account_id = kalcode_contracts::ids::new_id();
        let profile_parent = profiles
            .ensure_directory(&["providers"])
            .expect("profile parent");
        assert!(directory_link(&outside, &profile_parent.join("codex")));
        assert!(profiles.profile_home("codex", &account_id).is_err());

        let separate = ManagedProfiles::new(temp_root.join("separate")).expect("separate");
        let account_root = separate
            .ensure_directory(&["providers", "gemini-cli", "accounts", &account_id])
            .expect("account root");
        let locks = account_root.join("locks");
        std::fs::create_dir(&locks).expect("locks");
        std::fs::remove_dir(&locks).expect("remove ordinary locks directory");
        assert!(directory_link(&outside, &locks));
        assert!(
            separate
                .acquire_session_lease("gemini-cli", &account_id)
                .is_err()
        );
    }

    #[cfg(windows)]
    fn directory_link(target: &Path, link: &Path) -> bool {
        use std::os::windows::process::CommandExt;

        // Directory junctions need no developer-mode or elevation privilege.
        let mut command = std::process::Command::new("cmd");
        command.creation_flags(0x0800_0000);
        command
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|output| output.status.success())
    }

    #[cfg(unix)]
    fn directory_link(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
}
