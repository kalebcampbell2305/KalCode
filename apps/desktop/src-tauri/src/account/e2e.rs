//! Deterministic account authority used only by explicitly opted-in native E2E binaries.
//!
//! This module has no HTTP client, OS credential-store handle, browser continuation, production
//! signing key, or paid effect. The factory must run before the native core opens its database;
//! it refuses any data directory that is not an explicitly harness-marked account E2E directory.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kalcode_entitlements::Verifier;
use kalcode_secure_store::{SecretKey, SecretStore, SecretStoreError, SecretString};

use super::api::{
    AccountApi, ApiAccount, ApiError, BrowserUrlResponse, EmailStartResponse, EntitlementResponse,
    PaidTier, PkcePair, PollResponse, SignedInResponse, UsageResponse,
};
use super::model::{AccountUsageSnapshot, SessionSecret};
use super::runtime::{AccountRuntime, Clock};
use super::session_store::AccountSessionStore;

pub const FIXTURE_OPT_IN_ENV: &str = "KALCODE_E2E_ACCOUNT_FIXTURE";
pub const FIXTURE_ONBOARDING_VALUE: &str = "onboarding-v1";
pub const FIXTURE_READY_VALUE: &str = "ready-v1";
pub const FIXTURE_MARKER_FILENAME: &str = ".kalcode-account-e2e-v1";
pub const FIXTURE_MARKER_CONTENT: &str = "kalcode-account-e2e-v1\n";
pub const FIXTURE_DIRECTORY_PREFIX: &str = "kalcode-e2e-";
const FIXTURE_INITIALIZED_FILENAME: &str = ".kalcode-account-e2e-initialized-v1";
const FIXTURE_INITIALIZED_CONTENT: &str = "kalcode-account-e2e-initialized-v1\n";

const NOW: i64 = 1_790_000_060;
const ACCOUNT_ID: &str = "0b6f1c1e-5a39-4d0c-9a0f-2b1f7d9e4c11";
const TEST_PUBLIC_KEY: &str = "qcP_oTajE0Eubrj1mKtnsYQWs9tx7_aSG-4F49undqE";
const SESSION_TOKEN: &str = "kcs_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const POLL_TOKEN: &str = "ppppppppppppppppppppppppppppppppppppppppppp";
const FREE_TOKEN: &str = "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtdmVjdG9ycy0xIiwidHlwIjoia2FsY29kZS1lbnRpdGxlbWVudC52MSJ9.eyJ2ZXJzaW9uIjoxLCJhY2NvdW50SWQiOiIwYjZmMWMxZS01YTM5LTRkMGMtOWEwZi0yYjFmN2Q5ZTRjMTEiLCJ0aWVyIjoiZnJlZSIsInVucmVzdHJpY3RlZCI6ZmFsc2UsImZlYXR1cmVzIjpbXSwibGltaXRzIjp7ImNvbmN1cnJlbnRUaHJlYWRzIjoyLCJrYWx2b2ljZVJlcXVlc3RzUGVyTW9udGgiOjc1fSwiaXNzdWVkQXQiOjE3OTAwMDAwMDAsImV4cGlyZXNBdCI6MTc5MDYwNDgwMCwia2V5SWQiOiJ0ZXN0LXZlY3RvcnMtMSJ9.JPD0pSzGnCY4FEO0wpcQOQRHEsNtpVGwmYVQSR2vwVdgF52ldGAy9Yhbz8M9phFb98HFZXYXpqFBrFNPmRQ3CQ";
const FREE_USAGE_RECEIPT: &str = "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtdmVjdG9ycy0xIiwidHlwIjoia2FsY29kZS11c2FnZS52MSJ9.eyJ2ZXJzaW9uIjoxLCJhY2NvdW50SWQiOiIwYjZmMWMxZS01YTM5LTRkMGMtOWEwZi0yYjFmN2Q5ZTRjMTEiLCJ0aWVyIjoiZnJlZSIsInVzZWQiOjc1LCJhbGxvd2FuY2UiOjc1LCJwZXJpb2RTdGFydCI6IjIwMjYtMDktMTBUMDg6MDA6MDAuMDAwWiIsInJlc2V0c0F0IjoiMjAyNi0xMC0xMFQwODowMDowMC4wMDBaIiwiaXNzdWVkQXQiOjE3OTAwMDAwMDAsImV4cGlyZXNBdCI6MTc5MDI1OTIwMCwia2V5SWQiOiJ0ZXN0LXZlY3RvcnMtMSJ9.JM5k8bKsK8Cu8kNyPjsxjLFk7Aj_ZyriamrglxQFBSmAp_uMdk6c4mlECTMxARrFp9IOzAmy4XXN6D2gGboMDQ";

const PRODUCTION_SENTINELS: &[&str] = &[
    "kalcode.db",
    "kalcode.db-wal",
    "kalcode.db-shm",
    "kalcode.lock",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct E2eAccountFixtureError {
    pub code: &'static str,
    message: &'static str,
}

impl E2eAccountFixtureError {
    fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

impl std::fmt::Display for E2eAccountFixtureError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for E2eAccountFixtureError {}

/// Returns a deterministic account runtime only for the exact native E2E opt-in.
///
/// Call this before opening the native core. The exact marker and attestation prove the harness
/// supplied a dedicated directory; an unattested existing store and normal owner path are denied.
pub fn runtime_from_environment(
    data_dir: &Path,
) -> Result<Option<Arc<AccountRuntime>>, E2eAccountFixtureError> {
    let Some(mode) = fixture_mode_from_environment(data_dir)? else {
        return Ok(None);
    };
    Ok(Some(build_runtime(mode)))
}

/// Re-attests the exact native E2E directory before another synthetic authority mutates it.
///
/// Provider fixtures call this only after the core has opened. Reusing the account fixture's
/// opt-in and initialized marker prevents a test-only provider identity from ever reaching a
/// normal KalCode data directory.
pub(crate) fn provider_fixture_is_attested(
    data_dir: &Path,
) -> Result<bool, E2eAccountFixtureError> {
    fixture_mode_from_environment(data_dir).map(|mode| mode.is_some())
}

fn fixture_mode_from_environment(
    data_dir: &Path,
) -> Result<Option<FixtureMode>, E2eAccountFixtureError> {
    let Some(mode) = std::env::var_os(FIXTURE_OPT_IN_ENV) else {
        return Ok(None);
    };
    let mode = if mode == OsStr::new(FIXTURE_ONBOARDING_VALUE) {
        FixtureMode::Onboarding
    } else if mode == OsStr::new(FIXTURE_READY_VALUE) {
        FixtureMode::Ready
    } else {
        return Err(error(
            "fixture_opt_in_invalid",
            "The account E2E fixture opt-in is invalid.",
        ));
    };
    let configured = std::env::var_os("KALCODE_DATA_DIR")
        .map(PathBuf::from)
        .ok_or_else(|| {
            error(
                "fixture_data_dir_missing",
                "The account E2E fixture requires an isolated data directory.",
            )
        })?;
    validate_fixture_directory(&configured, data_dir)?;
    Ok(Some(mode))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FixtureMode {
    Onboarding,
    Ready,
}

fn validate_fixture_directory(
    configured: &Path,
    expected: &Path,
) -> Result<(), E2eAccountFixtureError> {
    if !configured.is_absolute() || !expected.is_absolute() {
        return Err(error(
            "fixture_data_dir_unsafe",
            "The account E2E fixture data directory is unsafe.",
        ));
    }
    let configured_metadata = std::fs::symlink_metadata(configured).map_err(|_| {
        error(
            "fixture_data_dir_unsafe",
            "The account E2E fixture data directory is unsafe.",
        )
    })?;
    let expected_metadata = std::fs::symlink_metadata(expected).map_err(|_| {
        error(
            "fixture_data_dir_unsafe",
            "The account E2E fixture data directory is unsafe.",
        )
    })?;
    if configured_metadata.file_type().is_symlink() || expected_metadata.file_type().is_symlink() {
        return Err(error(
            "fixture_data_dir_unsafe",
            "The account E2E fixture data directory is unsafe.",
        ));
    }
    let configured = configured.canonicalize().map_err(|_| {
        error(
            "fixture_data_dir_unsafe",
            "The account E2E fixture data directory is unsafe.",
        )
    })?;
    let expected = expected.canonicalize().map_err(|_| {
        error(
            "fixture_data_dir_unsafe",
            "The account E2E fixture data directory is unsafe.",
        )
    })?;
    if configured != expected || !configured.is_dir() {
        return Err(error(
            "fixture_data_dir_unsafe",
            "The account E2E fixture data directory is unsafe.",
        ));
    }
    if !configured
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.starts_with(FIXTURE_DIRECTORY_PREFIX))
        || configured.components().any(|component| {
            component
                .as_os_str()
                .to_str()
                .is_some_and(|value| value.eq_ignore_ascii_case("com.kalcode.desktop"))
        })
    {
        return Err(error(
            "fixture_data_dir_unsafe",
            "The account E2E fixture data directory is unsafe.",
        ));
    }
    let has_store = PRODUCTION_SENTINELS
        .iter()
        .any(|name| configured.join(name).exists());
    let marker = configured.join(FIXTURE_MARKER_FILENAME);
    let marker_metadata = std::fs::symlink_metadata(&marker).map_err(|_| {
        error(
            "fixture_marker_missing",
            "The account E2E fixture directory marker is missing.",
        )
    })?;
    if marker_metadata.file_type().is_symlink()
        || !marker_metadata.is_file()
        || std::fs::read_to_string(marker).ok().as_deref() != Some(FIXTURE_MARKER_CONTENT)
    {
        return Err(error(
            "fixture_marker_missing",
            "The account E2E fixture directory marker is missing.",
        ));
    }
    let initialized = configured.join(FIXTURE_INITIALIZED_FILENAME);
    if initialized.exists() {
        let initialized_metadata = std::fs::symlink_metadata(&initialized).map_err(|_| {
            error(
                "fixture_existing_store",
                "The account E2E fixture refuses an unattested existing KalCode data store.",
            )
        })?;
        if initialized_metadata.file_type().is_symlink()
            || !initialized_metadata.is_file()
            || std::fs::read_to_string(&initialized).ok().as_deref()
                != Some(FIXTURE_INITIALIZED_CONTENT)
        {
            return Err(error(
                "fixture_existing_store",
                "The account E2E fixture refuses an unattested existing KalCode data store.",
            ));
        }
    } else if has_store {
        return Err(error(
            "fixture_existing_store",
            "The account E2E fixture refuses an unattested existing KalCode data store.",
        ));
    } else {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&initialized)
            .map_err(|_| {
                error(
                    "fixture_data_dir_unsafe",
                    "The account E2E fixture could not attest its isolated data directory.",
                )
            })?;
        file.write_all(FIXTURE_INITIALIZED_CONTENT.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| {
                error(
                    "fixture_data_dir_unsafe",
                    "The account E2E fixture could not attest its isolated data directory.",
                )
            })?;
    }
    Ok(())
}

fn error(code: &'static str, message: &'static str) -> E2eAccountFixtureError {
    E2eAccountFixtureError::new(code, message)
}

fn build_runtime(mode: FixtureMode) -> Arc<AccountRuntime> {
    let verifier = Verifier::from_keys([("test-vectors-1", TEST_PUBLIC_KEY)])
        .expect("checked-in test-vector public key must remain valid");
    let api = Arc::new(E2eAccountApi::default());
    let store = Arc::new(MemorySecretStore::default());
    if mode == FixtureMode::Ready {
        api.activated.store(true, Ordering::SeqCst);
        let session = SessionSecret::new(SESSION_TOKEN.into(), 1_893_456_000)
            .expect("synthetic E2E session must remain structurally valid");
        AccountSessionStore::new(store.as_ref())
            .and_then(|session_store| session_store.save(Some(&session), None))
            .expect("in-memory E2E session seed must succeed");
    }
    Arc::new(AccountRuntime::with_dependencies(
        api,
        store,
        verifier,
        Arc::new(FixedClock),
    ))
}

#[derive(Default)]
struct MemorySecretStore {
    values: Mutex<HashMap<String, SecretString>>,
}

impl SecretStore for MemorySecretStore {
    fn backend(&self) -> &'static str {
        "account-e2e-memory"
    }

    fn set(&self, key: &SecretKey, value: &SecretString) -> Result<(), SecretStoreError> {
        self.values
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(key.account().to_owned(), value.clone());
        Ok(())
    }

    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>, SecretStoreError> {
        Ok(self
            .values
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(key.account())
            .cloned())
    }

    fn delete(&self, key: &SecretKey) -> Result<bool, SecretStoreError> {
        Ok(self
            .values
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(key.account())
            .is_some())
    }
}

struct FixedClock;

impl Clock for FixedClock {
    fn now_unix(&self) -> i64 {
        NOW
    }

    fn sleep(&self, _: Duration) {}
}

#[derive(Default)]
struct E2eAccountApi {
    state: Mutex<E2eServerState>,
    activated: AtomicBool,
    starts: AtomicUsize,
    polls: AtomicUsize,
    activations: AtomicUsize,
    logouts: AtomicUsize,
}

#[derive(Default)]
struct E2eServerState {
    email: Option<String>,
    code_challenge: Option<String>,
}

impl E2eAccountApi {
    fn authorize(bearer: &str) -> Result<(), ApiError> {
        if bearer == SESSION_TOKEN {
            Ok(())
        } else {
            Err(ApiError::Http {
                status: 401,
                code: "authentication_required".into(),
                retry_after_seconds: None,
            })
        }
    }

    fn account_snapshot(&self) -> ApiAccount {
        let email = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .email
            .clone()
            .unwrap_or_else(|| "owner@example.com".into());
        ApiAccount {
            id: ACCOUNT_ID.into(),
            email,
            activated_at: self
                .activated
                .load(Ordering::SeqCst)
                .then(|| "2026-09-25T12:00:00.000Z".into()),
        }
    }
}

impl AccountApi for E2eAccountApi {
    fn record_kalvoice(
        &self,
        _: &str,
        _: &str,
        _: bool,
    ) -> Result<super::api::RequestUsageResponse, ApiError> {
        // This attested test-only account has no live metering service. Exercise the verified
        // offline allowance and durable outbox rather than fabricate signed server receipts.
        Err(ApiError::Transport)
    }
    fn start_email(
        &self,
        email: &str,
        code_challenge: &str,
    ) -> Result<EmailStartResponse, ApiError> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.email = Some(email.to_owned());
        state.code_challenge = Some(code_challenge.to_owned());
        Ok(EmailStartResponse {
            expires_at: "2030-01-01T00:15:00.000Z".into(),
            poll_token: POLL_TOKEN.into(),
        })
    }

    fn poll_email(&self, poll_token: &str, code_verifier: &str) -> Result<PollResponse, ApiError> {
        self.polls.fetch_add(1, Ordering::SeqCst);
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let verifier = PkcePair::from_verifier(code_verifier.to_owned())?;
        if poll_token != POLL_TOKEN || state.code_challenge.as_deref() != Some(verifier.challenge())
        {
            return Err(ApiError::Http {
                status: 400,
                code: "invalid_poll".into(),
                retry_after_seconds: None,
            });
        }
        state.code_challenge = None;
        Ok(PollResponse::SignedIn(SignedInResponse {
            token: SESSION_TOKEN.into(),
            expires_at: "2030-01-01T00:00:00.000Z".into(),
        }))
    }

    fn refresh_session(&self, bearer: &str) -> Result<SignedInResponse, ApiError> {
        Self::authorize(bearer)?;
        Ok(SignedInResponse {
            token: SESSION_TOKEN.into(),
            expires_at: "2030-01-01T00:00:00.000Z".into(),
        })
    }

    fn logout(&self, bearer: &str) -> Result<(), ApiError> {
        Self::authorize(bearer)?;
        self.logouts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn account(&self, bearer: &str) -> Result<ApiAccount, ApiError> {
        Self::authorize(bearer)?;
        Ok(self.account_snapshot())
    }

    fn activate_free(&self, bearer: &str) -> Result<(), ApiError> {
        Self::authorize(bearer)?;
        self.activations.fetch_add(1, Ordering::SeqCst);
        self.activated.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn checkout(&self, _: &str, _: PaidTier, _: &str) -> Result<BrowserUrlResponse, ApiError> {
        Err(ApiError::Local("e2e_paid_effect_disabled"))
    }

    fn portal(&self, _: &str, _: &str) -> Result<BrowserUrlResponse, ApiError> {
        Err(ApiError::Local("e2e_browser_effect_disabled"))
    }

    fn entitlement(&self, bearer: &str) -> Result<EntitlementResponse, ApiError> {
        Self::authorize(bearer)?;
        if !self.activated.load(Ordering::SeqCst) {
            return Err(ApiError::Local("e2e_account_not_activated"));
        }
        Ok(EntitlementResponse {
            token: FREE_TOKEN.into(),
        })
    }

    fn usage(&self, bearer: &str) -> Result<UsageResponse, ApiError> {
        Self::authorize(bearer)?;
        Ok(UsageResponse {
            usage: AccountUsageSnapshot {
                used: 75,
                allowance: Some(75),
                period_start: "2026-09-10T08:00:00.000Z".into(),
                resets_at: "2026-10-10T08:00:00.000Z".into(),
            },
            receipt: FREE_USAGE_RECEIPT.into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::account::model::{AccountAuthority, AccountPhase, AccountTier};

    fn lifecycle_fixture() -> (
        Arc<AccountRuntime>,
        Arc<E2eAccountApi>,
        Arc<MemorySecretStore>,
    ) {
        let verifier =
            Verifier::from_keys([("test-vectors-1", TEST_PUBLIC_KEY)]).expect("verifier");
        let api = Arc::new(E2eAccountApi::default());
        let store = Arc::new(MemorySecretStore::default());
        let runtime = Arc::new(AccountRuntime::with_dependencies(
            api.clone(),
            store.clone(),
            verifier,
            Arc::new(FixedClock),
        ));
        (runtime, api, store)
    }

    fn sign_in(runtime: &AccountRuntime) -> AccountPhase {
        assert_eq!(
            runtime
                .start_email("owner@example.com")
                .expect("email start")
                .phase,
            AccountPhase::EmailPending
        );
        runtime.poll_email().expect("email poll").phase
    }

    #[test]
    fn fixture_proves_onboarding_logout_and_clean_relogin_generations() {
        let (runtime, api, store) = lifecycle_fixture();
        assert_eq!(
            runtime.bootstrap().expect("bootstrap").phase,
            AccountPhase::SignedOut
        );
        assert_eq!(sign_in(&runtime), AccountPhase::AuthenticatedUnactivated);

        let active = runtime.activate_free().expect("activate free");
        assert_eq!(active.phase, AccountPhase::Ready);
        assert_eq!(active.tier, Some(AccountTier::Free));
        let old_lease = runtime.acquire_active_lease().expect("active lease");
        assert_eq!(runtime.usage().expect("signed usage").used, 75);

        assert_eq!(
            runtime.logout().expect("logout").phase,
            AccountPhase::SignedOut
        );
        assert_eq!(runtime.authority(), AccountAuthority::SignedOut);
        assert!(!runtime.validate_active_lease(&old_lease));
        assert!(
            store
                .values
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .is_empty()
        );

        assert_eq!(sign_in(&runtime), AccountPhase::Ready);
        let new_lease = runtime.acquire_active_lease().expect("relogin lease");
        assert!(new_lease.generation() > old_lease.generation());
        assert_eq!(api.starts.load(Ordering::SeqCst), 2);
        assert_eq!(api.polls.load(Ordering::SeqCst), 2);
        assert_eq!(api.activations.load(Ordering::SeqCst), 1);
        assert_eq!(api.logouts.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn fixture_refuses_paid_and_browser_effects() {
        let (runtime, _, _) = lifecycle_fixture();
        runtime.bootstrap().expect("bootstrap");
        assert_eq!(sign_in(&runtime), AccountPhase::AuthenticatedUnactivated);
        let error = runtime
            .start_checkout(PaidTier::Pro)
            .expect_err("paid effect disabled");
        assert_eq!(error.code, "invalid_account_response");
    }

    #[test]
    fn fixture_directory_requires_marker_prefix_and_no_existing_store() {
        let root = tempfile::tempdir().expect("temp root");
        let directory = root.path().join(format!("{FIXTURE_DIRECTORY_PREFIX}safe"));
        std::fs::create_dir(&directory).expect("fixture directory");
        std::fs::write(
            directory.join(FIXTURE_MARKER_FILENAME),
            FIXTURE_MARKER_CONTENT,
        )
        .expect("fixture marker");
        validate_fixture_directory(&directory, &directory).expect("fresh marked directory");

        std::fs::write(directory.join("kalcode.db"), b"production-shaped").expect("sentinel");
        validate_fixture_directory(&directory, &directory)
            .expect("attested fixture directory supports a native restart");

        std::fs::remove_file(directory.join(FIXTURE_INITIALIZED_FILENAME))
            .expect("remove attestation");
        assert_eq!(
            validate_fixture_directory(&directory, &directory)
                .expect_err("unattested existing store must be refused")
                .code,
            "fixture_existing_store"
        );
    }

    #[test]
    fn fixture_directory_rejects_normal_or_unmarked_paths() {
        let root = tempfile::tempdir().expect("temp root");
        let unmarked = root
            .path()
            .join(format!("{FIXTURE_DIRECTORY_PREFIX}unmarked"));
        std::fs::create_dir(&unmarked).expect("unmarked directory");
        assert_eq!(
            validate_fixture_directory(&unmarked, &unmarked)
                .expect_err("marker required")
                .code,
            "fixture_marker_missing"
        );

        let standard = root.path().join("com.kalcode.desktop");
        std::fs::create_dir(&standard).expect("standard directory");
        std::fs::write(
            standard.join(FIXTURE_MARKER_FILENAME),
            FIXTURE_MARKER_CONTENT,
        )
        .expect("marker");
        assert_eq!(
            validate_fixture_directory(&standard, &standard)
                .expect_err("normal app path refused")
                .code,
            "fixture_data_dir_unsafe"
        );
    }

    #[test]
    fn ready_fixture_bootstraps_signed_authority_without_external_credentials() {
        let runtime = build_runtime(FixtureMode::Ready);
        let snapshot = runtime.bootstrap().expect("ready fixture bootstrap");
        assert_eq!(snapshot.phase, AccountPhase::Ready);
        assert_eq!(snapshot.tier, Some(AccountTier::Free));
        assert!(runtime.acquire_active_lease().is_ok());
    }
}
