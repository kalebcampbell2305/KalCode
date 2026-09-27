//! Account-bound service ownership. The observer is the only builder/drainer; IPC only borrows
//! epoch leases. No account/coordinator lock is held while building or stopping a service.

use std::ops::Deref;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kalcode_core::{IpcError, KalError};
use tauri::{AppHandle, Manager};

use crate::account::runtime::{AccountRuntime, AuthorityLease};
use crate::runtime_lifecycle::{Lease, Lifecycle, Phase};
use crate::{
    AppState, context_commands::ContextState, git_commands::GitState,
    kalvoice_commands::KalVoiceState, locator_commands::LocatorState,
    notification_commands::NotificationsState, permission_commands::PermissionState,
    provider_auth_commands::ProviderAuthState, provider_commands::ProviderState,
    provider_health_commands::ProviderHealthState, provider_pane_commands::ProviderPanesState,
    thread_commands::ThreadsState,
};

#[derive(Default)]
pub struct RuntimeBundle {
    block_after_cleanup: bool,
    startup_issue: Option<RecoveryIssue>,
    pub context: Option<Arc<ContextState>>,
    pub auth: Option<Arc<ProviderAuthState>>,
    pub notifications: Option<Arc<NotificationsState>>,
    pub panes: Option<Arc<ProviderPanesState>>,
    pub providers: Option<Arc<ProviderState>>,
    pub health: Option<Arc<ProviderHealthState>>,
    pub permissions: Option<Arc<PermissionState>>,
    pub threads: Option<Arc<ThreadsState>>,
    pub locator: Option<Arc<LocatorState>>,
    pub git: Option<Arc<GitState>>,
    pub voice: Option<Arc<KalVoiceState>>,
    pub resources: Option<Arc<crate::resource_commands::ResourceGovernorState>>,
    pub doctor: Option<Arc<crate::doctor_commands::DoctorState>>,
    pub utilities: Option<Arc<crate::utility_commands::UtilityState>>,
}

impl RuntimeBundle {
    fn build_into(
        &mut self,
        app: &AppHandle,
        state: &AppState,
        account: Arc<AccountRuntime>,
        valid: impl Fn() -> bool,
    ) {
        let bundle = self;
        macro_rules! check {
            () => {
                if !valid() {
                    return;
                }
            };
        }
        check!();
        let auth = Arc::new(match ProviderAuthState::start(state) {
            Ok(auth) => auth,
            Err(error_code) => {
                tracing::error!(event = "runtime.bootstrap_failed", error_code = %error_code);
                bundle.block_after_cleanup = true;
                bundle.startup_issue = Some(RecoveryIssue::from_startup_code(&error_code));
                ProviderAuthState::unavailable()
            }
        });
        let authority = auth.runtime_authority();
        bundle.auth = Some(auth);
        check!();
        let Some(core) = &state.core else {
            return;
        };
        bundle.context = Some(Arc::new(ContextState::default()));
        check!();
        let Some(runtime_authority) = &authority else {
            return;
        };
        let Ok(terminal_guardian) = runtime_authority.terminal_guardian() else {
            return;
        };
        if core.install_terminal_guardian(terminal_guardian).is_err()
            || core.resume_terminals_after_logout().is_err()
        {
            return;
        }
        check!();
        let notifications = Arc::new(NotificationsState::start(state.core.as_ref()));
        let resources = Arc::new(crate::resource_commands::ResourceGovernorState::start());
        resources.sync_workspaces(state);
        bundle.resources = Some(resources.clone());
        bundle.notifications = Some(notifications.clone());
        check!();
        let panes = Arc::new(ProviderPanesState::start(state, authority.clone()));
        bundle.panes = Some(panes.clone());
        check!();
        let Ok(providers) = ProviderState::from_process(runtime_authority) else {
            return;
        };
        let providers = Arc::new(providers);
        bundle.providers = Some(providers.clone());
        check!();
        let health = Arc::new(ProviderHealthState::start(
            state.core.clone(),
            &providers.registry(),
        ));
        health.bind(app);
        bundle.health = Some(health.clone());
        check!();
        let modes = Arc::new(crate::thread_commands::ThreadModes::default());
        let permissions = Arc::new(PermissionState::new(
            state.core.clone(),
            state.core.clone().map_or_else(
                || {
                    Arc::new(kalcode_permissions::NoWorkspaces)
                        as Arc<dyn kalcode_permissions::WorkspaceRoots>
                },
                |core| Arc::new(kalcode_permissions::CoreWorkspaceRoots::new(core)),
            ),
            modes.clone(),
        ));
        bundle.permissions = Some(permissions.clone());
        check!();
        let threads = Arc::new(ThreadsState::start(
            state.core.as_ref(),
            providers.registry(),
            permissions.service(),
            &modes,
            authority.clone(),
            panes.routes.clone(),
            health.monitor(),
            resources.clone(),
        ));
        bundle.threads = Some(threads.clone());
        check!();
        let locator = Arc::new(LocatorState::start(
            state,
            threads.runtime_handle(),
            providers.registry(),
        ));
        bundle.locator = Some(locator.clone());
        check!();
        bundle.git = Some(Arc::new(GitState::new(&state.paths.data_dir)));
        check!();
        if let Some(git) = &bundle.git {
            bundle.utilities = Some(Arc::new(crate::utility_commands::UtilityState::start(
                state,
                permissions.service(),
                git,
                app,
            )));
        }
        check!();
        let voice = match crate::kalvoice_components::KalVoiceComponentManager::for_runtime(
            state,
            resources.clone(),
        ) {
            Ok(components) => crate::kalvoice_commands::init(
                app,
                state.core.clone(),
                &state.info,
                crate::kalvoice_commands::KalVoiceServices {
                    registry: providers.registry(),
                    provider_runtime: runtime_authority.clone(),
                    threads: threads.runtime_handle(),
                    permissions: permissions.service(),
                    locator: locator.handle(),
                    components,
                    resources: resources.clone(),
                    account: account.clone(),
                },
            ),
            Err(error) => {
                tracing::warn!(
                    event = "kalvoice.components_unavailable",
                    code = error.code()
                );
                KalVoiceState::unavailable(
                    "KalVoice's signed component storage could not be initialized.",
                )
            }
        };
        let voice = Arc::new(voice);
        bundle.voice = Some(voice.clone());
        check!();
        if let Some(git) = &bundle.git {
            bundle.doctor = Some(Arc::new(crate::doctor_commands::DoctorState::start(
                state.core.clone(),
                providers.registry(),
                health.monitor(),
                permissions.service(),
                git.0.clone(),
                voice,
            )));
        }
        panes.bind(permissions.service().as_ref(), threads.runtime().ok());
        notifications.bind(threads.runtime_handle());
    }

    fn complete(&self) -> bool {
        self.context.is_some()
            && self
                .auth
                .as_ref()
                .is_some_and(|auth| auth.runtime_authority().is_some())
            && self
                .permissions
                .as_ref()
                .is_some_and(|permissions| permissions.service().is_some())
            && self
                .threads
                .as_ref()
                .is_some_and(|threads| threads.runtime().is_ok())
            && self.voice.is_some()
    }

    fn stop(&self, app: &AppHandle) -> bool {
        // Attempt every cleanup even when an earlier owner fails. Keep the whole bundle on
        // failure, so retry can prove termination rather than trusting a now-empty registry.
        // Source-bearing Context previews are the exception: leases are already drained here,
        // so erase them before any cleanup retry and never carry them into another account.
        let mut clean = true;
        if let Some(context) = &self.context {
            context.clear();
        }
        let authority = self.auth.as_ref().and_then(|auth| auth.runtime_authority());
        if let Some(authority) = &authority {
            clean &= authority.seal().is_ok();
        }
        if let Some(voice) = &self.voice {
            clean &= voice.shutdown(app);
        }
        if let Some(utilities) = &self.utilities {
            clean &= utilities.shutdown_checked().is_ok();
        }
        if let Some(doctor) = &self.doctor {
            clean &= doctor.shutdown_checked().is_ok();
        }
        if let Some(auth) = &self.auth {
            clean &= auth.shutdown();
        }
        if let Some(threads) = &self.threads {
            clean &= threads.shutdown_checked().is_ok();
        }
        if let Some(panes) = &self.panes {
            clean &= panes.shutdown_checked().is_ok();
        }
        if let Some(locator) = &self.locator {
            locator.shutdown();
        }
        if let Some(health) = &self.health {
            health.shutdown();
        }
        if let Some(resources) = &self.resources {
            clean &= resources.shutdown_checked();
        }
        if let Some(notifications) = &self.notifications {
            notifications.shutdown();
        }
        if let Some(views) = app.try_state::<crate::browser_commands::BrowserViews>() {
            clean &= crate::browser_commands::close_all(app, &views).is_ok();
        }
        if let Some(core) = app.state::<AppState>().core.as_ref() {
            clean &= core.drain_terminals_for_logout().is_ok();
        }
        if let Some(authority) = &authority {
            clean &= authority.drain_guardian().is_ok();
        }
        clean
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetainedBundleOutcome {
    StillValid,
    WaitingForLeases,
    BlockedUnclean,
    Cleaned,
}

fn reconcile_retained_bundle(
    lifecycle: &Lifecycle,
    active_generation: Option<u64>,
    block_after_cleanup: bool,
    stop: impl FnOnce() -> bool,
) -> RetainedBundleOutcome {
    if active_generation.is_some_and(|generation| lifecycle.acquire(generation).is_some()) {
        return RetainedBundleOutcome::StillValid;
    }
    let Some(epoch) = lifecycle.begin_drain(lifecycle.phase() == Phase::AppExiting) else {
        return RetainedBundleOutcome::WaitingForLeases;
    };
    // Queued work is invalidated. Already-running commands keep ownership until they return;
    // stopping service internals while those leases exist would race them.
    if lifecycle.pending() != (false, 0) {
        return RetainedBundleOutcome::WaitingForLeases;
    }
    if lifecycle.finish_drain(epoch, stop()) {
        if block_after_cleanup {
            lifecycle.block_unclean();
        }
        RetainedBundleOutcome::Cleaned
    } else {
        RetainedBundleOutcome::BlockedUnclean
    }
}

pub struct RuntimeCoordinator {
    pub lifecycle: Lifecycle,
    account: Arc<AccountRuntime>,
    bundle: Mutex<Option<Arc<RuntimeBundle>>>,
    startup_issue: Mutex<Option<RecoveryIssue>>,
}

#[derive(Clone, Copy, Debug, serde::Serialize)]
pub struct RecoveryIssue {
    code: &'static str,
    message: &'static str,
    retryable: bool,
}

impl RecoveryIssue {
    fn from_startup_code(code: &str) -> Self {
        let (code, message) = match code {
            "workspace_owned" => (
                "workspace_owned",
                "Another KalCode instance owns this workspace. Close that instance, then try again.",
            ),
            "workspace_recovery_pending" => (
                "workspace_recovery_pending",
                "Previous provider processes are still being checked or stopped. Wait a moment, then try again.",
            ),
            "workspace_recovery_metadata_invalid" => (
                "workspace_recovery_metadata_invalid",
                "Workspace recovery metadata could not be validated. Retry the safety check; if this persists, contact KalCode support.",
            ),
            "provider_guardian_unavailable" => (
                "provider_guardian_unavailable",
                "The workspace safety helper could not start. Try again; if this persists, repair the KalCode installation.",
            ),
            _ => (
                "workspace_startup_failed",
                "A required workspace service could not start. Try again; if this persists, contact KalCode support.",
            ),
        };
        Self {
            code,
            message,
            retryable: true,
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    phase: &'static str,
    ready: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    recovery: Option<RecoveryIssue>,
}

#[tauri::command]
pub fn runtime_status(coordinator: tauri::State<'_, Arc<RuntimeCoordinator>>) -> RuntimeStatus {
    if coordinator.bundle.is_poisoned() {
        coordinator.lifecycle.block_unclean();
    }
    // Account expiry/revocation is authoritative even between observer iterations.
    if coordinator.lifecycle.phase() == Phase::Ready
        && coordinator
            .account
            .acquire_active_lease()
            .ok()
            .and_then(|lease| coordinator.lifecycle.acquire(lease.generation()))
            .is_none()
    {
        coordinator.request_drain(false);
    }
    let phase = coordinator.lifecycle.phase();
    RuntimeStatus {
        phase: match phase {
            Phase::SignedOut => "signed_out",
            Phase::Starting => "starting",
            Phase::Ready => "ready",
            Phase::Draining => "draining",
            Phase::BlockedUnclean => "blocked_unclean",
            Phase::AppExiting => "app_exiting",
        },
        ready: phase == Phase::Ready,
        recovery: if phase == Phase::BlockedUnclean {
            Some(
                if coordinator.bundle.is_poisoned() || coordinator.startup_issue.is_poisoned() {
                    RecoveryIssue {
                        code: "workspace_authority_unavailable",
                        message: "Workspace safety state could not be validated. Close KalCode and contact support if this persists.",
                        retryable: false,
                    }
                } else {
                    coordinator.startup_issue.lock().ok().and_then(|issue| *issue).unwrap_or(RecoveryIssue {
                    code: "workspace_cleanup_pending", message: "Active workspace resources have not finished closing. Wait a moment, then try again.", retryable: true,
                })
                },
            )
        } else {
            None
        },
    }
}

#[tauri::command]
pub fn runtime_retry(
    coordinator: tauri::State<'_, Arc<RuntimeCoordinator>>,
) -> Result<(), crate::account::runtime::AccountRuntimeError> {
    coordinator.retry_startup().map_err(|_| crate::account::runtime::AccountRuntimeError {
        code: "workspace_retry_unavailable",
        message: "Workspace recovery is still protecting active or unverified resources. Wait a moment, then try again.",
        retryable: true,
    })
}

pub struct AccountMutation(crate::runtime_lifecycle::MutationLease);

impl AccountMutation {
    pub fn acquire(
        coordinator: &Arc<RuntimeCoordinator>,
    ) -> Result<Self, crate::account::runtime::AccountRuntimeError> {
        coordinator.lifecycle.acquire_mutation().map(Self).ok_or(
            crate::account::runtime::AccountRuntimeError {
                code: "runtime_draining",
                message: "Wait for account cleanup before trying again.",
                retryable: true,
            },
        )
    }

    pub fn revalidate(&self) -> Result<(), crate::account::runtime::AccountRuntimeError> {
        if self.0.valid() {
            Ok(())
        } else {
            Err(crate::account::runtime::AccountRuntimeError {
                code: "runtime_draining",
                message: "Wait for account cleanup before trying again.",
                retryable: true,
            })
        }
    }
}

impl<'de> tauri::ipc::CommandArg<'de, tauri::Wry> for AccountMutation {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, tauri::Wry>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        let coordinator = command
            .message
            .state_ref()
            .try_get::<Arc<RuntimeCoordinator>>()
            .ok_or_else(|| tauri::ipc::InvokeError::from(unavailable()))?;
        coordinator
            .lifecycle
            .acquire_mutation()
            .map(Self)
            .ok_or_else(|| unavailable().into())
    }
}

pub type RuntimeAccess = RuntimeState<ThreadsState>;

impl RuntimeCoordinator {
    pub fn new(account: Arc<AccountRuntime>) -> Arc<Self> {
        Arc::new(Self {
            lifecycle: Lifecycle::default(),
            account,
            bundle: Mutex::new(None),
            startup_issue: Mutex::new(None),
        })
    }

    /// Retry only after actual cleanup released every local owner. The observer then runs
    /// ordinary guardian startup, which remains the authority for external workspace custody.
    fn retry_startup(&self) -> Result<(), IpcError> {
        let bundle = self.bundle.lock().map_err(|_| unavailable())?;
        if bundle.is_some() || self.startup_issue.is_poisoned() {
            return Err(unavailable());
        }
        if self.lifecycle.phase() == Phase::SignedOut {
            return Ok(());
        }
        if self.lifecycle.phase() != Phase::BlockedUnclean || !self.lifecycle.finish_empty_drain() {
            return Err(unavailable());
        }
        Ok(())
    }

    pub fn observe(self: &Arc<Self>, app: AppHandle) -> std::io::Result<()> {
        let coordinator = self.clone();
        std::thread::Builder::new()
            .name("kalcode-account-runtime".into())
            .spawn(move || {
                let mut watch = coordinator.account.subscribe_authority();
                watch.current();
                loop {
                    coordinator.reconcile(&app);
                    if coordinator.lifecycle.phase() == Phase::AppExiting
                        && coordinator
                            .bundle
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .is_none()
                    {
                        break;
                    }
                    watch.wait_for_change(Duration::from_millis(100));
                }
            })
            .map(|_| ())
    }

    fn reconcile(&self, app: &AppHandle) {
        if self.bundle.is_poisoned() {
            self.lifecycle.block_unclean();
            return;
        }
        let active = self.account.acquire_active_lease().ok();
        let current = self
            .bundle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(bundle) = current {
            let outcome = reconcile_retained_bundle(
                &self.lifecycle,
                active.as_ref().map(AuthorityLease::generation),
                bundle.block_after_cleanup && active.is_some(),
                || bundle.stop(app),
            );
            if outcome == RetainedBundleOutcome::Cleaned {
                let stopped = self
                    .bundle
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take();
                drop(stopped);
            }
            return;
        }
        if self.lifecycle.phase() == Phase::Draining {
            self.lifecycle.finish_empty_drain();
            return;
        }
        let Some(authority) = active else {
            return;
        };
        let Some(mut permit) = self.lifecycle.begin_build(authority.generation()) else {
            return;
        };
        let mut partial = RuntimeBundle::default();
        let built = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            partial.build_into(app, &app.state::<AppState>(), self.account.clone(), || {
                self.account.validate_active_lease(&authority)
                    && self.lifecycle.phase() == Phase::Starting
            });
        }));
        let complete = built.is_ok() && partial.complete();
        *self
            .startup_issue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = partial.startup_issue;
        let bundle = Arc::new(partial);
        *self
            .bundle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(bundle);
        if complete && self.account.validate_active_lease(&authority) && permit.publish() {
            return;
        }
        drop(permit);
        // The next observer iteration cleans the retained partial bundle, including failures.
    }

    pub fn request_drain(&self, exiting: bool) {
        self.lifecycle.begin_drain(exiting);
    }

    pub fn wait_drained(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if self.bundle.is_poisoned() {
                self.lifecycle.block_unclean();
                return false;
            }
            if self
                .bundle
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_none()
                && self.lifecycle.pending() == (false, 0)
                && matches!(self.lifecycle.phase(), Phase::SignedOut | Phase::AppExiting)
            {
                return true;
            }
            if Instant::now() >= deadline {
                self.lifecycle.block_unclean();
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn acquire<T: RuntimeService>(&self) -> Result<RuntimeState<T>, IpcError> {
        if self.bundle.is_poisoned() {
            self.lifecycle.block_unclean();
            return Err(unavailable());
        }
        let authority = self
            .account
            .acquire_active_lease()
            .map_err(|_| unavailable())?;
        let epoch = self
            .lifecycle
            .acquire(authority.generation())
            .ok_or_else(unavailable)?;
        let bundle = self
            .bundle
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .ok_or_else(unavailable)?;
        let service = T::resolve(&bundle).ok_or_else(unavailable)?;
        let state = RuntimeState {
            service,
            account: self.account.clone(),
            authority,
            epoch,
        };
        state.revalidate()?;
        Ok(state)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use super::*;

    struct UntouchedStore;
    impl kalcode_secure_store::SecretStore for UntouchedStore {
        fn backend(&self) -> &'static str {
            "untouched-test-store"
        }
        fn set(
            &self,
            _: &kalcode_secure_store::SecretKey,
            _: &kalcode_secure_store::SecretString,
        ) -> Result<(), kalcode_secure_store::SecretStoreError> {
            panic!("runtime recovery must not mutate account credentials")
        }
        fn get(
            &self,
            _: &kalcode_secure_store::SecretKey,
        ) -> Result<
            Option<kalcode_secure_store::SecretString>,
            kalcode_secure_store::SecretStoreError,
        > {
            panic!("runtime recovery must not read account credentials")
        }
        fn delete(
            &self,
            _: &kalcode_secure_store::SecretKey,
        ) -> Result<bool, kalcode_secure_store::SecretStoreError> {
            panic!("runtime recovery must not delete account credentials")
        }
    }

    fn test_coordinator() -> Arc<RuntimeCoordinator> {
        RuntimeCoordinator::new(Arc::new(AccountRuntime::production(Arc::new(
            UntouchedStore,
        ))))
    }

    #[test]
    fn retry_after_failed_start_cleanup_reenters_authoritative_startup() {
        let coordinator = test_coordinator();
        let permit = coordinator.lifecycle.begin_build(7).unwrap();
        drop(permit);
        assert_eq!(
            reconcile_retained_bundle(&coordinator.lifecycle, Some(7), true, || true),
            RetainedBundleOutcome::Cleaned
        );
        assert_eq!(coordinator.lifecycle.phase(), Phase::BlockedUnclean);
        assert!(coordinator.retry_startup().is_ok());
        assert!(coordinator.lifecycle.begin_build(7).is_some());
    }

    #[test]
    fn retry_never_drops_a_retained_bundle_or_reopens_exit() {
        let coordinator = test_coordinator();
        coordinator.lifecycle.block_unclean();
        let retained = Arc::new(RuntimeBundle::default());
        *coordinator.bundle.lock().unwrap() = Some(retained.clone());
        assert!(coordinator.retry_startup().is_err());
        assert!(Arc::ptr_eq(
            coordinator.bundle.lock().unwrap().as_ref().unwrap(),
            &retained
        ));
        assert_eq!(coordinator.lifecycle.phase(), Phase::BlockedUnclean);
        coordinator.bundle.lock().unwrap().take();
        coordinator.request_drain(true);
        assert!(coordinator.retry_startup().is_err());
        assert_eq!(coordinator.lifecycle.phase(), Phase::AppExiting);
    }

    #[test]
    fn recovery_status_never_serializes_untrusted_startup_details() {
        let issue = RecoveryIssue::from_startup_code("private-file-or-token-details");
        let status = RuntimeStatus {
            phase: "blocked_unclean",
            ready: false,
            recovery: Some(issue),
        };
        let serialized = serde_json::to_value(status).unwrap();
        assert_eq!(serialized["recovery"]["code"], "workspace_startup_failed");
        assert!(
            !serialized
                .to_string()
                .contains("private-file-or-token-details")
        );
        for code in [
            "workspace_owned",
            "workspace_recovery_pending",
            "workspace_recovery_metadata_invalid",
            "provider_guardian_unavailable",
        ] {
            let issue = RecoveryIssue::from_startup_code(code);
            assert_eq!(issue.code, code);
            assert!(issue.retryable);
        }
    }

    struct RetryableService {
        can_stop: AtomicBool,
        attempts: AtomicUsize,
    }

    impl RetryableService {
        fn stop(&self) -> bool {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            self.can_stop.load(Ordering::SeqCst)
        }
    }

    #[test]
    fn blocked_cleanup_retries_same_bundle_without_reopening_admission() {
        let lifecycle = Lifecycle::default();
        let epoch = lifecycle.begin_start(7).unwrap();
        assert!(lifecycle.publish(epoch));
        let service = RetryableService {
            can_stop: AtomicBool::new(false),
            attempts: AtomicUsize::new(0),
        };

        assert_eq!(
            reconcile_retained_bundle(&lifecycle, Some(7), false, || service.stop()),
            RetainedBundleOutcome::StillValid
        );
        assert_eq!(service.attempts.load(Ordering::SeqCst), 0);

        assert_eq!(
            reconcile_retained_bundle(&lifecycle, None, false, || service.stop()),
            RetainedBundleOutcome::BlockedUnclean
        );
        assert_eq!(lifecycle.phase(), Phase::BlockedUnclean);
        assert_eq!(service.attempts.load(Ordering::SeqCst), 1);
        assert!(lifecycle.acquire(7).is_none());
        assert!(lifecycle.begin_start(8).is_none());

        service.can_stop.store(true, Ordering::SeqCst);
        assert_eq!(
            reconcile_retained_bundle(&lifecycle, Some(8), false, || service.stop()),
            RetainedBundleOutcome::Cleaned
        );
        assert_eq!(service.attempts.load(Ordering::SeqCst), 2);
        assert_eq!(lifecycle.phase(), Phase::SignedOut);
        assert!(lifecycle.begin_start(8).is_some());
    }

    #[test]
    fn context_cleanup_waits_for_generation_lease_before_relogin() {
        let lifecycle = Lifecycle::default();
        let epoch = lifecycle.begin_start(7).unwrap();
        assert!(lifecycle.publish(epoch));
        let in_flight = lifecycle.acquire(7).expect("generation N command lease");
        let context = ContextState::default();
        let cleaned = AtomicBool::new(false);

        assert_eq!(
            reconcile_retained_bundle(&lifecycle, None, false, || {
                context.clear();
                cleaned.store(true, Ordering::SeqCst);
                true
            }),
            RetainedBundleOutcome::WaitingForLeases
        );
        assert!(!cleaned.load(Ordering::SeqCst));
        assert!(lifecycle.begin_start(8).is_none());

        drop(in_flight);
        assert_eq!(
            reconcile_retained_bundle(&lifecycle, None, false, || {
                context.clear();
                cleaned.store(true, Ordering::SeqCst);
                true
            }),
            RetainedBundleOutcome::Cleaned
        );
        assert!(cleaned.load(Ordering::SeqCst));
        assert!(lifecycle.begin_start(8).is_some());
    }

    #[test]
    fn fatal_bootstrap_failure_cleans_partial_owners_then_stays_blocked() {
        let lifecycle = Lifecycle::default();
        let permit = lifecycle.begin_build(7).expect("bootstrap permit");
        drop(permit);

        assert_eq!(
            reconcile_retained_bundle(&lifecycle, Some(7), true, || true),
            RetainedBundleOutcome::Cleaned
        );
        assert_eq!(lifecycle.phase(), Phase::BlockedUnclean);
        assert!(lifecycle.begin_start(7).is_none());
    }
}

fn unavailable() -> IpcError {
    KalError::validation(
        "runtime_not_ready",
        "Sign in to an active account and wait for KalCode to finish starting or recovering.",
    )
    .to_ipc()
}

pub trait RuntimeService: Send + Sync + 'static {
    fn resolve(bundle: &RuntimeBundle) -> Option<Arc<Self>>;
}

macro_rules! service {
    ($type:ty, $field:ident) => {
        impl RuntimeService for $type {
            fn resolve(bundle: &RuntimeBundle) -> Option<Arc<Self>> {
                bundle.$field.clone()
            }
        }
    };
}
service!(ProviderAuthState, auth);
service!(ContextState, context);
service!(NotificationsState, notifications);
service!(ProviderPanesState, panes);
service!(ProviderState, providers);
service!(ProviderHealthState, health);
service!(PermissionState, permissions);
service!(ThreadsState, threads);
service!(LocatorState, locator);
service!(GitState, git);
service!(KalVoiceState, voice);
service!(crate::resource_commands::ResourceGovernorState, resources);
service!(crate::doctor_commands::DoctorState, doctor);
service!(crate::utility_commands::UtilityState, utilities);

pub struct RuntimeState<T: RuntimeService> {
    service: Arc<T>,
    account: Arc<AccountRuntime>,
    authority: AuthorityLease,
    epoch: Lease,
}

impl<T: RuntimeService> RuntimeState<T> {
    pub fn from_app(app: &AppHandle) -> Result<Self, IpcError> {
        app.try_state::<Arc<RuntimeCoordinator>>()
            .ok_or_else(unavailable)?
            .acquire::<T>()
    }
    pub fn revalidate(&self) -> Result<(), IpcError> {
        self.revalidate_core().map_err(|error| error.to_ipc())
    }
    pub fn revalidate_core(&self) -> Result<(), KalError> {
        if self.epoch.valid() && self.account.validate_active_lease(&self.authority) {
            Ok(())
        } else {
            Err(KalError::validation(
                "runtime_not_ready",
                "This request belongs to a runtime that has stopped. Try again after signing in.",
            ))
        }
    }
    pub fn inner(&self) -> &T {
        &self.service
    }
    /// Read native account identity under the same lease that admits the command. A revocation
    /// or account switch between the snapshot and its use invalidates this request.
    pub fn account_id(&self) -> Result<String, IpcError> {
        self.revalidate()?;
        let id = self.account.snapshot().account.ok_or_else(unavailable)?.id;
        self.revalidate()?;
        Ok(id)
    }

    /// The authenticated account generation bound to this lease, never supplied by the WebView.
    pub fn generation(&self) -> u64 {
        self.authority.generation()
    }
}

impl<T: RuntimeService> Deref for RuntimeState<T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.service
    }
}

impl<'de, T: RuntimeService> tauri::ipc::CommandArg<'de, tauri::Wry> for RuntimeState<T> {
    fn from_command(
        command: tauri::ipc::CommandItem<'de, tauri::Wry>,
    ) -> Result<Self, tauri::ipc::InvokeError> {
        command
            .message
            .state_ref()
            .try_get::<Arc<RuntimeCoordinator>>()
            .ok_or_else(|| tauri::ipc::InvokeError::from(unavailable()))?
            .acquire::<T>()
            .map_err(Into::into)
    }
}
