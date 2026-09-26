#![allow(dead_code)]

use crate::account;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};

use account::api::{
    AccountApi, ApiAccount, ApiError, BrowserUrlResponse, EmailStartResponse, EntitlementResponse,
    PaidTier, PollResponse, SignedInResponse, SocialCompleteResponse, SocialStartResponse,
    UsageResponse,
};
use account::model::{AccountAuthority, AccountPhase, AccountTier, PublicAccount, SessionSecret};
use account::runtime::{AccountRuntime, Clock};
use account::session_store::{AccountSessionStore, CachedAccountSecret};
use account::social::SocialProvider;
use kalcode_entitlements::Verifier;
use kalcode_secure_store::{SecretKey, SecretStore, SecretStoreError, SecretString};

const NOW: i64 = 1_790_000_060;
const ACCOUNT_ID: &str = "0b6f1c1e-5a39-4d0c-9a0f-2b1f7d9e4c11";
const TEST_KEY: &str = "qcP_oTajE0Eubrj1mKtnsYQWs9tx7_aSG-4F49undqE";
const FREE_TOKEN: &str = "eyJhbGciOiJFZERTQSIsImtpZCI6InRlc3QtdmVjdG9ycy0xIiwidHlwIjoia2FsY29kZS1lbnRpdGxlbWVudC52MSJ9.eyJ2ZXJzaW9uIjoxLCJhY2NvdW50SWQiOiIwYjZmMWMxZS01YTM5LTRkMGMtOWEwZi0yYjFmN2Q5ZTRjMTEiLCJ0aWVyIjoiZnJlZSIsInVucmVzdHJpY3RlZCI6ZmFsc2UsImZlYXR1cmVzIjpbXSwibGltaXRzIjp7ImNvbmN1cnJlbnRUaHJlYWRzIjoyLCJrYWx2b2ljZVJlcXVlc3RzUGVyTW9udGgiOjc1fSwiaXNzdWVkQXQiOjE3OTAwMDAwMDAsImV4cGlyZXNBdCI6MTc5MDYwNDgwMCwia2V5SWQiOiJ0ZXN0LXZlY3RvcnMtMSJ9.JPD0pSzGnCY4FEO0wpcQOQRHEsNtpVGwmYVQSR2vwVdgF52ldGAy9Yhbz8M9phFb98HFZXYXpqFBrFNPmRQ3CQ";

#[derive(Default)]
struct TestStore {
    values: Mutex<HashMap<String, SecretString>>,
    set_gate: Mutex<Option<Arc<PollGate>>>,
    delete_gate: Mutex<Option<Arc<PollGate>>>,
}

impl SecretStore for TestStore {
    fn backend(&self) -> &'static str {
        "account-runtime-test"
    }

    fn set(&self, key: &SecretKey, value: &SecretString) -> Result<(), SecretStoreError> {
        if let Some(gate) = self.set_gate.lock().expect("set gate").clone() {
            gate.block_call();
        }
        self.values
            .lock()
            .expect("store lock")
            .insert(key.account().to_owned(), value.clone());
        Ok(())
    }

    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>, SecretStoreError> {
        Ok(self
            .values
            .lock()
            .expect("store lock")
            .get(key.account())
            .cloned())
    }

    fn delete(&self, key: &SecretKey) -> Result<bool, SecretStoreError> {
        if let Some(gate) = self.delete_gate.lock().expect("delete gate").clone() {
            gate.block_call();
        }
        Ok(self
            .values
            .lock()
            .expect("store lock")
            .remove(key.account())
            .is_some())
    }
}

struct FixedClock;

impl Clock for FixedClock {
    fn now_unix(&self) -> i64 {
        NOW
    }

    fn sleep(&self, _: std::time::Duration) {}
}

struct MutableClock(AtomicI64);

impl Clock for MutableClock {
    fn now_unix(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }

    fn sleep(&self, _: std::time::Duration) {}
}

#[derive(Default)]
struct FakeApi {
    request_usage: Mutex<VecDeque<Result<account::api::RequestUsageResponse, ApiError>>>,
    request_calls: Mutex<Vec<(String, bool)>>,
    starts: Mutex<VecDeque<Result<EmailStartResponse, ApiError>>>,
    polls: Mutex<VecDeque<Result<PollResponse, ApiError>>>,
    refreshes: Mutex<VecDeque<Result<SignedInResponse, ApiError>>>,
    social_completes: Mutex<VecDeque<Result<SocialCompleteResponse, ApiError>>>,
    accounts: Mutex<VecDeque<Result<ApiAccount, ApiError>>>,
    entitlements: Mutex<VecDeque<Result<EntitlementResponse, ApiError>>>,
    checkouts: Mutex<VecDeque<Result<BrowserUrlResponse, ApiError>>>,
    poll_gate: Mutex<Option<Arc<PollGate>>>,
    refresh_gate: Mutex<Option<Arc<PollGate>>>,
    activate_calls: AtomicUsize,
    checkout_calls: AtomicUsize,
    checkout_request_ids: Mutex<Vec<String>>,
    account_calls: AtomicUsize,
}

#[derive(Default)]
struct PollGate {
    state: Mutex<(bool, bool)>,
    changed: Condvar,
}

impl PollGate {
    fn wait_until_entered(&self) {
        let mut state = self.state.lock().expect("gate lock");
        while !state.0 {
            state = self.changed.wait(state).expect("gate wait");
        }
    }

    fn release(&self) {
        let mut state = self.state.lock().expect("gate lock");
        state.1 = true;
        self.changed.notify_all();
    }

    fn block_call(&self) {
        let mut state = self.state.lock().expect("gate lock");
        state.0 = true;
        self.changed.notify_all();
        while !state.1 {
            state = self.changed.wait(state).expect("gate wait");
        }
    }
}

fn pop<T>(queue: &Mutex<VecDeque<Result<T, ApiError>>>) -> Result<T, ApiError> {
    queue
        .lock()
        .expect("API queue")
        .pop_front()
        .unwrap_or(Err(ApiError::Local("unexpected_test_call")))
}

impl AccountApi for FakeApi {
    fn start_email(&self, _: &str, _: &str) -> Result<EmailStartResponse, ApiError> {
        pop(&self.starts)
    }

    fn poll_email(&self, _: &str, _: &str) -> Result<PollResponse, ApiError> {
        if let Some(gate) = self.poll_gate.lock().expect("poll gate").clone() {
            gate.block_call();
        }
        pop(&self.polls)
    }

    fn start_social(
        &self,
        provider: SocialProvider,
        code_challenge: &str,
    ) -> Result<SocialStartResponse, ApiError> {
        let state = "s".repeat(43);
        let nonce = "n".repeat(43);
        let (base, response_mode) = match provider {
            SocialProvider::Google => ("https://accounts.google.com/o/oauth2/v2/auth", ""),
            SocialProvider::Microsoft => (
                "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
                "&response_mode=query",
            ),
        };
        let redirect: String =
            url::form_urlencoded::byte_serialize(provider.callback_url().as_bytes()).collect();
        Ok(SocialStartResponse {
            authorize_url: format!(
                "{base}?client_id=test-client&redirect_uri={redirect}&response_type=code&scope=openid%20email&state={state}&nonce={nonce}&code_challenge={code_challenge}&code_challenge_method=S256{response_mode}"
            ),
            nonce,
            expires_at: "2026-09-21T14:24:20.000Z".into(),
        })
    }

    fn complete_social(
        &self,
        _: SocialProvider,
        _: &str,
        _: &str,
        _: &str,
        _: &str,
    ) -> Result<SocialCompleteResponse, ApiError> {
        if let Some(gate) = self.poll_gate.lock().expect("poll gate").clone() {
            gate.block_call();
        }
        pop(&self.social_completes)
    }

    fn refresh_session(&self, _: &str) -> Result<SignedInResponse, ApiError> {
        if let Some(gate) = self.refresh_gate.lock().expect("refresh gate").clone() {
            gate.block_call();
        }
        pop(&self.refreshes)
    }

    fn logout(&self, _: &str) -> Result<(), ApiError> {
        Ok(())
    }

    fn account(&self, _: &str) -> Result<ApiAccount, ApiError> {
        self.account_calls.fetch_add(1, Ordering::SeqCst);
        pop(&self.accounts)
    }

    fn activate_free(&self, _: &str) -> Result<(), ApiError> {
        self.activate_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn checkout(
        &self,
        _: &str,
        _: PaidTier,
        request_id: &str,
    ) -> Result<BrowserUrlResponse, ApiError> {
        self.checkout_calls.fetch_add(1, Ordering::SeqCst);
        self.checkout_request_ids
            .lock()
            .expect("checkout ids")
            .push(request_id.to_owned());
        pop(&self.checkouts)
    }

    fn portal(&self, _: &str, _: &str) -> Result<BrowserUrlResponse, ApiError> {
        Err(ApiError::Local("unexpected_test_call"))
    }

    fn entitlement(&self, _: &str) -> Result<EntitlementResponse, ApiError> {
        pop(&self.entitlements)
    }

    fn usage(&self, _: &str) -> Result<UsageResponse, ApiError> {
        Err(ApiError::Local("unexpected_test_call"))
    }

    fn record_kalvoice(
        &self,
        _: &str,
        request: &str,
        offline: bool,
    ) -> Result<account::api::RequestUsageResponse, ApiError> {
        self.request_calls
            .lock()
            .expect("calls")
            .push((request.into(), offline));
        pop(&self.request_usage)
    }
}

fn vector_token(section: &str, name: &str) -> String {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../crates/entitlements/testdata/vectors.json"
    ))
    .expect("vectors");
    vectors[section]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["name"] == name)
        .expect("case")["token"]
        .as_str()
        .expect("token")
        .into()
}

fn metering_account(
    api: Arc<FakeApi>,
    tier: &str,
    receipt: Option<&str>,
    offline: bool,
) -> Arc<AccountRuntime> {
    let store = Arc::new(TestStore::default());
    let session = SessionSecret::new(signed_in().token, 1_900_000_000).expect("session");
    let token = vector_token("cases", tier);
    let cached = CachedAccountSecret::new(
        token.clone(),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "ordinary@example.com".into(),
            activated_at: Some("2026-09-01T12:00:00.000Z".into()),
        },
    )
    .expect("cache");
    let receipt = receipt.map(|name| {
        account::session_store::SignedUsageReceipt::new(vector_token("receiptCases", name))
            .expect("receipt")
    });
    AccountSessionStore::new(store.as_ref())
        .expect("store")
        .save_full(Some(&session), None, Some(&cached), receipt.as_ref())
        .expect("seed");
    if offline {
        api.accounts.lock().expect("queue").extend([
            Err(ApiError::Transport),
            Err(ApiError::Transport),
            Err(ApiError::Transport),
        ]);
    } else {
        api.accounts
            .lock()
            .expect("queue")
            .push_back(Ok(api_account(true)));
        api.entitlements
            .lock()
            .expect("queue")
            .push_back(Ok(EntitlementResponse { token }));
    }
    let runtime = Arc::new(runtime(api, store));
    assert_eq!(
        runtime.bootstrap().expect("bootstrap").phase,
        if offline {
            AccountPhase::OfflineGrace
        } else {
            AccountPhase::Ready
        }
    );
    runtime
}

fn metering_core() -> (tempfile::TempDir, Arc<kalcode_core::Core>) {
    let directory = tempfile::tempdir().expect("directory");
    let core = Arc::new(
        kalcode_core::Core::open(kalcode_core::CoreConfig {
            paths: kalcode_core::Paths::new(directory.path()),
            app_version: "test".into(),
            channel: kalcode_core::flags::BuildChannel::Development,
        })
        .expect("core"),
    );
    (directory, core)
}

fn request_receipt(name: &str, allowed: bool) -> account::api::RequestUsageResponse {
    let token = vector_token("receiptCases", name);
    let receipt = Verifier::from_keys([("test-vectors-1", TEST_KEY)])
        .expect("verifier")
        .verify_usage_receipt(&token, NOW)
        .expect("verified");
    account::api::RequestUsageResponse {
        allowed,
        usage: UsageResponse {
            receipt: token,
            usage: account::model::AccountUsageSnapshot {
                used: receipt.used,
                allowance: receipt.allowance,
                period_start: receipt.period_start,
                resets_at: receipt.resets_at,
            },
        },
    }
}

#[test]
fn kalvoice_paid_owner_and_empty_offline_authority_use_signed_limits_and_exact_cycle() {
    use kalcode_kalvoice::accounting::RequestAccounting;
    for (tier, receipt, allowance, used) in [
        ("pro", Some("pro-receipt"), Some(1500), 412),
        ("owner", Some("owner-receipt"), None, 12345),
        ("free", Some("free-receipt-exhausted"), Some(75), 75),
    ] {
        let api = Arc::new(FakeApi::default());
        let account = metering_account(api.clone(), tier, receipt, true);
        let (_directory, core) = metering_core();
        let meter = crate::kalvoice_accounting::AccountKalVoice::new(core, account).expect("meter");
        let before = meter.usage().expect("usage");
        assert_eq!(before.allowance, allowance);
        assert_eq!(before.used, used);
        assert_eq!(before.period_start, "2026-09-10T08:00:00.000Z");
        assert_eq!(before.resets_at, "2026-10-10T08:00:00.000Z");
        let decision = meter
            .authorize(&kalcode_contracts::ids::new_id())
            .expect("offline decision");
        assert_eq!(decision.allowed, tier != "free");
        assert_eq!(decision.usage.used, used + u32::from(tier != "free"));
        assert!(api.request_calls.lock().expect("calls").is_empty());
    }
}

#[test]
fn kalvoice_unknown_transport_persists_across_restart_and_replays_same_id_once() {
    use kalcode_kalvoice::accounting::{self, RequestAccounting};
    let api = Arc::new(FakeApi::default());
    let account = metering_account(api.clone(), "pro", Some("pro-receipt"), false);
    let (_directory, core) = metering_core();
    let meter = crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), account.clone())
        .expect("meter");
    api.request_usage
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    let id = kalcode_contracts::ids::new_id();
    let decision = meter.authorize(&id).expect("verified offline fallback");
    assert!(decision.allowed);
    assert_eq!(decision.usage.used, 413);
    assert_eq!(
        core.read(|conn| accounting::next_pending(conn, ACCOUNT_ID))
            .expect("durable"),
        Some((id.clone(), true))
    );
    drop(meter);
    let restarted =
        crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), account).expect("restart");
    api.request_usage
        .lock()
        .expect("queue")
        .push_back(Ok(request_receipt("pro-receipt", true)));
    restarted.synchronize();
    restarted.synchronize();
    assert_eq!(
        *api.request_calls.lock().expect("calls"),
        vec![(id.clone(), false), (id, true)]
    );
    assert!(
        core.read(|conn| accounting::next_pending(conn, ACCOUNT_ID))
            .expect("acked")
            .is_none()
    );
    assert_eq!(restarted.usage().expect("usage").used, 412);
}

#[test]
fn kalvoice_invalid_receipt_never_admits_execution_and_unknown_claim_stays_online() {
    use kalcode_kalvoice::accounting::{self, RequestAccounting};
    let api = Arc::new(FakeApi::default());
    let account = metering_account(api.clone(), "pro", Some("pro-receipt"), false);
    let (_directory, core) = metering_core();
    let meter = crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), account.clone())
        .expect("meter");
    let mut forged = request_receipt("pro-receipt", true);
    forged.usage.usage.used = 0;
    api.request_usage
        .lock()
        .expect("queue")
        .push_back(Ok(forged));
    let id = kalcode_contracts::ids::new_id();
    assert!(meter.authorize(&id).is_err());
    assert_eq!(
        core.read(|conn| accounting::next_pending(conn, ACCOUNT_ID))
            .expect("durable"),
        Some((id.clone(), false))
    );
    account.logout().expect("logout");
    assert!(meter.usage().is_err());
    assert!(meter.authorize(&kalcode_contracts::ids::new_id()).is_err());
    meter.synchronize();
    assert_eq!(api.request_calls.lock().expect("calls").len(), 1);
    // Returning to the same account cannot revive the old runtime's metering authority.
    sign_in_unactivated(&account, &api);
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(api_account(true)));
    api.entitlements
        .lock()
        .expect("queue")
        .push_back(Ok(EntitlementResponse {
            token: FREE_TOKEN.into(),
        }));
    account.activate_free().expect("reactivate");
    assert_eq!(
        meter.usage().expect_err("old generation").code,
        "runtime_not_ready"
    );
    let current = crate::kalvoice_accounting::AccountKalVoice::new(core, account)
        .expect("current generation");
    assert!(current.usage().is_ok());
    current.stop();
    assert_eq!(
        current
            .authorize(&kalcode_contracts::ids::new_id())
            .expect_err("sealed")
            .code,
        "runtime_not_ready"
    );
}

#[test]
fn kalvoice_last_offline_unit_is_atomic_and_unscoped_ledger_is_ignored() {
    use kalcode_kalvoice::accounting::{self, RequestAccounting};
    let api = Arc::new(FakeApi::default());
    let account = metering_account(api.clone(), "free", None, true);
    let (_directory, core) = metering_core();
    core.transact(|conn| {
        kalcode_kalvoice::ledger::consume(
            conn,
            kalcode_kalvoice::ledger::RequestClaim {
                request_id: &kalcode_contracts::ids::new_id(),
                input: kalcode_contracts::kalvoice::KalVoiceInput::Text,
                intent_kind: "navigate",
                execution_owner: &kalcode_contracts::ids::new_id(),
            },
            kalcode_kalvoice::ledger::ConsumptionContext {
                now: time::OffsetDateTime::from_unix_timestamp(NOW).expect("clock"),
                anchor_day: 1,
                allowance: None,
            },
        )?;
        for _ in 0..74 {
            accounting::reserve(
                conn,
                ACCOUNT_ID,
                &kalcode_contracts::ids::new_id(),
                NOW,
                true,
            )?;
        }
        Ok(((), Vec::new()))
    })
    .expect("seed");
    let meter = crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), account.clone())
        .expect("meter");
    assert_eq!(meter.usage().expect("legacy count excluded").used, 74);
    let other =
        crate::kalvoice_accounting::AccountKalVoice::new(core, account).expect("independent lane");
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let handles = [meter.clone(), other]
        .into_iter()
        .map(|meter| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                meter
                    .authorize(&kalcode_contracts::ids::new_id())
                    .expect("admit")
                    .allowed
            })
        })
        .collect::<Vec<_>>();
    barrier.wait();
    assert_eq!(
        handles
            .into_iter()
            .map(|handle| u32::from(handle.join().expect("join")))
            .sum::<u32>(),
        1
    );
    assert_eq!(meter.usage().expect("usage").used, 75);
    assert!(api.request_calls.lock().expect("calls").is_empty());
}

#[test]
fn kalvoice_server_receipt_replaces_provisional_count_for_allow_and_deny() {
    use kalcode_kalvoice::accounting::{self, RequestAccounting};
    for (tier, receipt, allowed, used) in [
        ("pro", "pro-receipt", true, 412),
        ("free", "free-receipt-exhausted", false, 75),
    ] {
        let api = Arc::new(FakeApi::default());
        let account = metering_account(api.clone(), tier, None, false);
        let (_directory, core) = metering_core();
        let meter =
            crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), account).expect("meter");
        assert_eq!(meter.usage().expect("provisional").used, 0);
        api.request_usage
            .lock()
            .expect("queue")
            .push_back(Ok(request_receipt(receipt, allowed)));
        let decision = meter
            .authorize(&kalcode_contracts::ids::new_id())
            .expect("server decision");
        assert_eq!(decision.allowed, allowed);
        assert_eq!(decision.usage.used, used);
        assert_eq!(decision.usage.period_start, "2026-09-10T08:00:00.000Z");
        assert!(
            core.read(|conn| accounting::next_pending(conn, ACCOUNT_ID))
                .expect("settled")
                .is_none()
        );
    }
}

fn api_account(activated: bool) -> ApiAccount {
    ApiAccount {
        id: ACCOUNT_ID.into(),
        email: "owner@example.com".into(),
        activated_at: activated.then(|| "2026-09-25T12:00:00.000Z".into()),
    }
}

fn signed_in() -> SignedInResponse {
    SignedInResponse {
        token: format!("kcs_{}", "a".repeat(43)),
        expires_at: "2030-01-01T00:00:00.000Z".into(),
    }
}

fn runtime(api: Arc<FakeApi>, store: Arc<TestStore>) -> AccountRuntime {
    let verifier = Verifier::from_keys([("test-vectors-1", TEST_KEY)]).expect("test verifier");
    AccountRuntime::with_dependencies(api, store, verifier, Arc::new(FixedClock))
}

fn sign_in_unactivated(runtime: &AccountRuntime, api: &FakeApi) {
    api.starts
        .lock()
        .expect("queue")
        .push_back(Ok(EmailStartResponse {
            expires_at: "2030-01-01T00:15:00.000Z".into(),
            poll_token: "p".repeat(43),
        }));
    api.polls
        .lock()
        .expect("queue")
        .push_back(Ok(PollResponse::SignedIn(signed_in())));
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(api_account(false)));
    assert_eq!(
        runtime
            .start_email("owner@example.com")
            .expect("start")
            .phase,
        AccountPhase::EmailPending
    );
    assert_eq!(
        runtime.poll_email().expect("poll").phase,
        AccountPhase::AuthenticatedUnactivated
    );
}

#[test]
fn free_activation_uses_server_entitlement_and_never_checkout() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore::default());
    let runtime = runtime(api.clone(), store);
    sign_in_unactivated(&runtime, &api);
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(api_account(true)));
    api.entitlements
        .lock()
        .expect("queue")
        .push_back(Ok(EntitlementResponse {
            token: FREE_TOKEN.into(),
        }));

    let snapshot = runtime.activate_free().expect("activate");
    assert_eq!(snapshot.phase, AccountPhase::Ready);
    assert_eq!(snapshot.tier, Some(AccountTier::Free));
    assert_eq!(runtime.authority(), AccountAuthority::Active);
    assert_eq!(api.activate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(api.checkout_calls.load(Ordering::SeqCst), 0);
    let quota = runtime
        .kalvoice_authority(ACCOUNT_ID)
        .expect("verified native quota");
    assert_eq!(quota.entitlement.tier, kalcode_entitlements::Tier::Free);
    assert_eq!(quota.entitlement.account_id, ACCOUNT_ID);
    assert!(quota.receipt.is_none());
    assert!(runtime.kalvoice_authority("different-account").is_err());
    runtime.logout().expect("logout");
    assert!(runtime.kalvoice_authority(ACCOUNT_ID).is_err());
}

#[test]
fn checkout_redirect_never_unlocks_before_live_server_confirmation() {
    let api = Arc::new(FakeApi::default());
    let runtime = runtime(api.clone(), Arc::new(TestStore::default()));
    sign_in_unactivated(&runtime, &api);
    api.checkouts.lock().expect("queue").extend([
        Err(ApiError::Http {
            status: 503,
            code: "temporarily_unavailable".into(),
            retry_after_seconds: Some(1),
        }),
        Err(ApiError::Http {
            status: 429,
            code: "rate_limited".into(),
            retry_after_seconds: Some(2),
        }),
        Ok(BrowserUrlResponse {
            url: "https://checkout.stripe.com/c/pay/test".into(),
        }),
    ]);

    let launch = runtime.start_checkout(PaidTier::Max2x).expect("checkout");
    assert_eq!(launch.snapshot.phase, AccountPhase::ConfirmingPlan);
    assert_eq!(launch.snapshot.tier, None);
    assert_eq!(
        runtime.authority(),
        AccountAuthority::AuthenticatedUnactivated
    );
    let request_ids = api.checkout_request_ids.lock().expect("checkout ids");
    assert_eq!(request_ids.len(), 3);
    assert!(
        request_ids
            .iter()
            .all(|request_id| request_id == &request_ids[0])
    );
    drop(request_ids);

    api.refreshes
        .lock()
        .expect("queue")
        .push_back(Ok(signed_in()));
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(api_account(false)));
    let still_waiting = runtime.refresh().expect("refresh");
    assert_eq!(still_waiting.phase, AccountPhase::ConfirmingPlan);
    assert_eq!(still_waiting.tier, None);
}

#[test]
fn first_launch_offline_stays_gated_but_matching_signed_cache_gets_bounded_grace() {
    let empty_api = Arc::new(FakeApi::default());
    empty_api
        .accounts
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    let empty_runtime = runtime(empty_api, Arc::new(TestStore::default()));
    let first = empty_runtime.bootstrap().expect("bootstrap");
    assert_ne!(first.phase, AccountPhase::OfflineGrace);
    assert_ne!(empty_runtime.authority(), AccountAuthority::Active);

    let store = Arc::new(TestStore::default());
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let cached = CachedAccountSecret::new(
        FREE_TOKEN.into(),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
        },
    )
    .expect("cache");
    AccountSessionStore::new(store.as_ref())
        .expect("store")
        .save_full(Some(&session), None, Some(&cached), None)
        .expect("seed");
    let cached_api = Arc::new(FakeApi::default());
    cached_api
        .accounts
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    let cached_runtime = runtime(cached_api, store);
    let offline = cached_runtime.bootstrap().expect("offline bootstrap");
    assert_eq!(offline.phase, AccountPhase::OfflineGrace);
    assert_eq!(offline.tier, Some(AccountTier::Free));
    assert_eq!(offline.offline_grace_until, Some(1_790_604_800));
    let quota = cached_runtime
        .kalvoice_authority(ACCOUNT_ID)
        .expect("verified offline quota");
    assert!(quota.offline);
    assert_eq!(quota.entitlement.tier, kalcode_entitlements::Tier::Free);
}

#[test]
fn unauthorized_refresh_deletes_durable_session_and_returns_the_gate() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore::default());
    let runtime = runtime(api.clone(), store.clone());
    sign_in_unactivated(&runtime, &api);
    api.refreshes
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Http {
            status: 401,
            code: "invalid_session".into(),
            retry_after_seconds: None,
        }));

    let snapshot = runtime.refresh().expect("401 becomes gate state");
    assert_eq!(snapshot.phase, AccountPhase::SignedOut);
    assert_eq!(runtime.authority(), AccountAuthority::SignedOut);
    assert!(
        AccountSessionStore::new(store.as_ref())
            .expect("store")
            .load()
            .expect("load")
            .is_none()
    );
}

#[test]
fn cancel_generation_fence_prevents_a_late_successful_poll_from_restoring_authority() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore::default());
    let runtime = Arc::new(runtime(api.clone(), store.clone()));
    api.starts
        .lock()
        .expect("queue")
        .push_back(Ok(EmailStartResponse {
            expires_at: "2030-01-01T00:15:00.000Z".into(),
            poll_token: "p".repeat(43),
        }));
    runtime.start_email("owner@example.com").expect("start");
    api.polls
        .lock()
        .expect("queue")
        .push_back(Ok(PollResponse::SignedIn(signed_in())));
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(api_account(false)));
    let gate = Arc::new(PollGate::default());
    *api.poll_gate.lock().expect("poll gate") = Some(gate.clone());

    let polling = {
        let runtime = runtime.clone();
        std::thread::spawn(move || runtime.poll_email().expect("fenced poll"))
    };
    gate.wait_until_entered();
    let cancelled = runtime.cancel_auth().expect("cancel");
    assert_eq!(cancelled.phase, AccountPhase::SignedOut);
    gate.release();
    assert_eq!(
        polling.join().expect("poll thread").phase,
        AccountPhase::SignedOut
    );
    assert_eq!(runtime.authority(), AccountAuthority::SignedOut);
    assert!(
        AccountSessionStore::new(store.as_ref())
            .expect("store")
            .load()
            .expect("load")
            .is_none()
    );
}

#[test]
fn social_callback_is_exact_attempt_bound_and_success_clears_pending_into_keychain_session() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore::default());
    let runtime = runtime(api.clone(), store.clone());
    let launch = runtime
        .start_social(SocialProvider::Google)
        .expect("start social");
    assert_eq!(launch.snapshot.phase, AccountPhase::SocialPending);
    runtime
        .commit_social_browser_launch(&launch, |_| Ok(()))
        .expect("open validated URL");

    let wrong = runtime
        .handle_social_callback_url(&format!(
            "kalcode://auth/microsoft?code=oauth-code&state={}",
            "s".repeat(43)
        ))
        .expect_err("provider mismatch");
    assert_eq!(wrong.code, "invalid_auth_callback");
    assert_eq!(runtime.snapshot().phase, AccountPhase::SocialPending);
    let stale = runtime
        .handle_social_callback_url(&format!(
            "kalcode://auth/google?code=oauth-code&state={}",
            "x".repeat(43)
        ))
        .expect_err("state mismatch");
    assert_eq!(stale.code, "invalid_auth_callback");
    assert_eq!(runtime.snapshot().phase, AccountPhase::SocialPending);

    api.social_completes
        .lock()
        .expect("queue")
        .push_back(Ok(SocialCompleteResponse {
            token: format!("kcs_{}", "a".repeat(43)),
            account_id: format!("acct_{}", "g".repeat(43)),
            expires_at: "2030-01-01T00:00:00.000Z".into(),
        }));
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(ApiAccount {
            id: format!("acct_{}", "g".repeat(43)),
            email: "owner@example.com".into(),
            activated_at: None,
        }));
    let signed_in = runtime
        .handle_social_callback_url(&format!(
            "kalcode://auth/google?code=oauth-code&state={}",
            "s".repeat(43)
        ))
        .expect("complete social");
    assert_eq!(signed_in.phase, AccountPhase::AuthenticatedUnactivated);
    let stored = AccountSessionStore::new(store.as_ref())
        .expect("store")
        .load()
        .expect("load")
        .expect("session");
    assert!(stored.session().is_some());
    assert!(stored.pending().is_none());

    let replay = runtime
        .handle_social_callback_url(&format!(
            "kalcode://auth/google?code=oauth-code&state={}",
            "s".repeat(43)
        ))
        .expect_err("replay is rejected");
    assert_eq!(replay.code, "auth_callback_not_expected");
    assert_eq!(
        runtime.snapshot().phase,
        AccountPhase::AuthenticatedUnactivated
    );
}

#[test]
fn social_cancel_clears_pending_and_wrong_account_response_fails_closed() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore::default());
    let runtime = runtime(api.clone(), store.clone());
    runtime
        .start_social(SocialProvider::Microsoft)
        .expect("start microsoft");
    let canceled = runtime
        .handle_social_callback_url(&format!(
            "kalcode://auth/microsoft?error=sign_in_canceled&state={}",
            "s".repeat(43)
        ))
        .expect("cancel callback");
    assert_eq!(canceled.phase, AccountPhase::SignedOut);
    assert!(
        AccountSessionStore::new(store.as_ref())
            .expect("store")
            .load()
            .expect("load")
            .is_none()
    );

    runtime
        .start_social(SocialProvider::Google)
        .expect("restart social");
    api.social_completes
        .lock()
        .expect("queue")
        .push_back(Ok(SocialCompleteResponse {
            token: format!("kcs_{}", "b".repeat(43)),
            account_id: format!("acct_{}", "x".repeat(43)),
            expires_at: "2030-01-01T00:00:00.000Z".into(),
        }));
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(api_account(false)));
    let mismatch = runtime
        .handle_social_callback_url(&format!(
            "kalcode://auth/google?code=oauth-code&state={}",
            "s".repeat(43)
        ))
        .expect_err("wrong account");
    assert_eq!(mismatch.code, "account_identity_mismatch");
    assert_eq!(runtime.snapshot().phase, AccountPhase::SignedOut);
    assert_eq!(runtime.authority(), AccountAuthority::SignedOut);
    assert!(
        AccountSessionStore::new(store.as_ref())
            .expect("store")
            .load()
            .expect("load")
            .is_none()
    );
}

#[test]
fn cancel_generation_fence_rejects_late_social_completion_without_restoring_session() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore::default());
    let runtime = Arc::new(runtime(api.clone(), store.clone()));
    runtime
        .start_social(SocialProvider::Google)
        .expect("start social");
    api.social_completes
        .lock()
        .expect("queue")
        .push_back(Ok(SocialCompleteResponse {
            token: format!("kcs_{}", "a".repeat(43)),
            account_id: format!("acct_{}", "g".repeat(43)),
            expires_at: "2030-01-01T00:00:00.000Z".into(),
        }));
    let gate = Arc::new(PollGate::default());
    *api.poll_gate.lock().expect("poll gate") = Some(gate.clone());
    let callback = {
        let runtime = runtime.clone();
        std::thread::spawn(move || {
            runtime.handle_social_callback_url(&format!(
                "kalcode://auth/google?code=oauth-code&state={}",
                "s".repeat(43)
            ))
        })
    };
    gate.wait_until_entered();
    assert_eq!(
        runtime.cancel_auth().expect("cancel").phase,
        AccountPhase::SignedOut
    );
    gate.release();
    assert_eq!(
        callback
            .join()
            .expect("callback thread")
            .expect("stale callback")
            .phase,
        AccountPhase::SignedOut
    );
    assert_eq!(runtime.authority(), AccountAuthority::SignedOut);
    assert!(
        AccountSessionStore::new(store.as_ref())
            .expect("store")
            .load()
            .expect("load")
            .is_none()
    );
}

#[test]
fn signed_entitlement_for_another_account_never_unlocks() {
    let api = Arc::new(FakeApi::default());
    let runtime = runtime(api.clone(), Arc::new(TestStore::default()));
    sign_in_unactivated(&runtime, &api);
    api.refreshes
        .lock()
        .expect("queue")
        .push_back(Ok(signed_in()));
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(ApiAccount {
            id: "different-account".into(),
            email: "other@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
        }));
    api.entitlements
        .lock()
        .expect("queue")
        .push_back(Ok(EntitlementResponse {
            token: FREE_TOKEN.into(),
        }));

    let error = runtime
        .refresh()
        .expect_err("wrong account must fail closed");
    assert_eq!(error.code, "invalid_entitlement");
    assert_ne!(runtime.authority(), AccountAuthority::Active);
}

#[test]
fn bounded_redacted_authority_watch_reports_start_and_stop_transitions() {
    let api = Arc::new(FakeApi::default());
    let runtime = runtime(api.clone(), Arc::new(TestStore::default()));
    let mut subscription = runtime.subscribe_authority();
    let initial = subscription.current();
    assert_eq!(initial.authority, AccountAuthority::Bootstrapping);
    api.starts
        .lock()
        .expect("queue")
        .push_back(Ok(EmailStartResponse {
            expires_at: "2030-01-01T00:15:00.000Z".into(),
            poll_token: "p".repeat(43),
        }));

    runtime.start_email("owner@example.com").expect("start");
    let pending = subscription
        .wait_for_change(std::time::Duration::from_millis(1))
        .expect("pending update");
    assert_eq!(pending.phase, AccountPhase::EmailPending);
    assert_eq!(pending.authority, AccountAuthority::SignedOut);
    assert!(pending.revision > initial.revision);

    runtime.cancel_auth().expect("cancel");
    let stopped = subscription
        .wait_for_change(std::time::Duration::from_millis(1))
        .expect("stop update");
    assert_eq!(stopped.phase, AccountPhase::SignedOut);
    assert_eq!(stopped.authority, AccountAuthority::SignedOut);
    assert!(stopped.revision > pending.revision);
    assert!(stopped.generation > pending.generation);
}

#[test]
fn active_lease_rechecks_signed_expiry_and_refresh_never_transiently_stops_valid_cache() {
    let store = Arc::new(TestStore::default());
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let cached = CachedAccountSecret::new(
        FREE_TOKEN.into(),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
        },
    )
    .expect("cache");
    AccountSessionStore::new(store.as_ref())
        .expect("store")
        .save_full(Some(&session), None, Some(&cached), None)
        .expect("seed");
    let api = Arc::new(FakeApi::default());
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    let clock = Arc::new(MutableClock(AtomicI64::new(NOW)));
    let verifier = Verifier::from_keys([("test-vectors-1", TEST_KEY)]).expect("test verifier");
    let runtime = AccountRuntime::with_dependencies(api.clone(), store, verifier, clock.clone());
    assert_eq!(
        runtime.bootstrap().expect("bootstrap").phase,
        AccountPhase::OfflineGrace
    );
    let initial_lease = runtime.acquire_active_lease().expect("active lease");
    let mut subscription = runtime.subscribe_authority();
    let active = subscription.current();

    api.refreshes.lock().expect("queue").extend((0..3).map(|_| {
        Err(ApiError::Http {
            status: 503,
            code: "temporarily_unavailable".into(),
            retry_after_seconds: Some(1),
        })
    }));
    let refreshed = runtime.refresh().expect("offline refresh");
    assert_eq!(refreshed.phase, AccountPhase::OfflineGrace);
    let still_active = subscription
        .wait_for_change(std::time::Duration::from_millis(1))
        .expect("active refresh update");
    assert_eq!(still_active.authority, AccountAuthority::Active);
    assert!(still_active.revision > active.revision);
    assert!(!runtime.validate_active_lease(&initial_lease));
    let refreshed_lease = runtime
        .acquire_active_lease()
        .expect("refreshed active lease");

    clock.0.store(1_790_604_800, Ordering::SeqCst);
    assert!(!runtime.validate_active_lease(&refreshed_lease));
    assert!(runtime.acquire_active_lease().is_err());
    let gated = runtime.refresh().expect("expired cache gates");
    assert_eq!(gated.authority(), AccountAuthority::SignedOut);
}

#[test]
fn unpublished_logout_generation_invalidates_admission_before_observer_snapshot_changes() {
    let store = Arc::new(TestStore::default());
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let cached = CachedAccountSecret::new(
        FREE_TOKEN.into(),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
        },
    )
    .expect("cache");
    AccountSessionStore::new(store.as_ref())
        .expect("store")
        .save_full(Some(&session), None, Some(&cached), None)
        .expect("seed");
    let api = Arc::new(FakeApi::default());
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    let runtime = Arc::new(runtime(api, store.clone()));
    runtime.bootstrap().expect("offline bootstrap");
    let lease = runtime.acquire_active_lease().expect("lease");
    let published_active = runtime.current_authority_update();
    assert_eq!(published_active.authority, AccountAuthority::Active);
    let gate = Arc::new(PollGate::default());
    *store.delete_gate.lock().expect("delete gate") = Some(gate.clone());

    let logout = {
        let runtime = runtime.clone();
        std::thread::spawn(move || runtime.logout().expect("logout"))
    };
    gate.wait_until_entered();
    assert_eq!(runtime.current_authority_update(), published_active);
    assert!(!runtime.validate_active_lease(&lease));
    assert!(runtime.acquire_active_lease().is_err());
    gate.release();
    assert_eq!(
        logout.join().expect("logout thread").phase,
        AccountPhase::SignedOut
    );
}

#[test]
fn active_lease_exposes_only_its_generation_and_cancel_without_auth_work_preserves_it() {
    let store = Arc::new(TestStore::default());
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let cached = CachedAccountSecret::new(
        FREE_TOKEN.into(),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
        },
    )
    .expect("cache");
    AccountSessionStore::new(store.as_ref())
        .expect("store")
        .save_full(Some(&session), None, Some(&cached), None)
        .expect("seed");
    let api = Arc::new(FakeApi::default());
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    let runtime = runtime(api, store);
    runtime.bootstrap().expect("offline bootstrap");
    let lease = runtime.acquire_active_lease().expect("lease");
    let generation = runtime.current_authority_update().generation;

    assert_eq!(lease.generation(), generation);
    assert_eq!(
        runtime.cancel_auth().expect("no-op cancel").phase,
        AccountPhase::OfflineGrace
    );
    assert!(runtime.validate_active_lease(&lease));
}

#[test]
fn cancellation_during_pending_secret_write_cannot_restore_obsolete_authentication() {
    let api = Arc::new(FakeApi::default());
    api.starts
        .lock()
        .expect("queue")
        .push_back(Ok(EmailStartResponse {
            expires_at: "2030-01-01T00:15:00.000Z".into(),
            poll_token: "p".repeat(43),
        }));
    let store = Arc::new(TestStore::default());
    let gate = Arc::new(PollGate::default());
    *store.set_gate.lock().expect("set gate") = Some(gate.clone());
    let runtime = Arc::new(runtime(api, store.clone()));

    let starting = {
        let runtime = runtime.clone();
        std::thread::spawn(move || runtime.start_email("owner@example.com").expect("start"))
    };
    gate.wait_until_entered();
    assert_eq!(
        runtime.cancel_auth().expect("cancel").phase,
        AccountPhase::SignedOut
    );
    gate.release();

    assert_eq!(
        starting.join().expect("start thread").phase,
        AccountPhase::SignedOut
    );
    assert_eq!(runtime.authority(), AccountAuthority::SignedOut);
    assert!(
        AccountSessionStore::new(store.as_ref())
            .expect("store")
            .load()
            .expect("load")
            .is_none()
    );
}

#[test]
fn duplicate_bootstrap_is_idempotent_and_does_not_repeat_remote_verification() {
    let store = Arc::new(TestStore::default());
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let cached = CachedAccountSecret::new(
        FREE_TOKEN.into(),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
        },
    )
    .expect("cache");
    AccountSessionStore::new(store.as_ref())
        .expect("store")
        .save_full(Some(&session), None, Some(&cached), None)
        .expect("seed");
    let api = Arc::new(FakeApi::default());
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    let runtime = runtime(api.clone(), store);

    let first = runtime.bootstrap().expect("first bootstrap");
    let duplicate = runtime.bootstrap().expect("duplicate bootstrap");

    assert_eq!(first, duplicate);
    assert_eq!(api.account_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn logout_revokes_first_and_waits_for_an_inflight_account_operation() {
    let store = Arc::new(TestStore::default());
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let cached = CachedAccountSecret::new(
        FREE_TOKEN.into(),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
        },
    )
    .expect("cache");
    AccountSessionStore::new(store.as_ref())
        .expect("store")
        .save_full(Some(&session), None, Some(&cached), None)
        .expect("seed");
    let api = Arc::new(FakeApi::default());
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    api.refreshes
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    let runtime = Arc::new(runtime(api.clone(), store));
    runtime.bootstrap().expect("bootstrap");
    let lease = runtime.acquire_active_lease().expect("lease");
    let gate = Arc::new(PollGate::default());
    *api.refresh_gate.lock().expect("refresh gate") = Some(gate.clone());

    let refreshing = {
        let runtime = runtime.clone();
        std::thread::spawn(move || runtime.refresh().expect("stale refresh"))
    };
    gate.wait_until_entered();
    let (logout_complete_tx, logout_complete_rx) = std::sync::mpsc::channel();
    let logging_out = {
        let runtime = runtime.clone();
        std::thread::spawn(move || {
            let result = runtime.logout();
            logout_complete_tx.send(()).expect("logout completion");
            result
        })
    };

    for _ in 0..10_000 {
        if !runtime.validate_active_lease(&lease) {
            break;
        }
        std::thread::yield_now();
    }
    assert!(!runtime.validate_active_lease(&lease));
    assert!(logout_complete_rx.try_recv().is_err());
    gate.release();

    assert_eq!(
        refreshing.join().expect("refresh thread").phase,
        AccountPhase::OfflineGrace
    );
    assert_eq!(
        logging_out
            .join()
            .expect("logout thread")
            .expect("logout")
            .phase,
        AccountPhase::SignedOut
    );
    logout_complete_rx.recv().expect("logout completion");
}

#[test]
fn browser_launch_is_revalidated_at_the_effect_boundary() {
    let api = Arc::new(FakeApi::default());
    let runtime = runtime(api.clone(), Arc::new(TestStore::default()));
    sign_in_unactivated(&runtime, &api);
    api.checkouts
        .lock()
        .expect("queue")
        .push_back(Ok(BrowserUrlResponse {
            url: "https://checkout.stripe.com/c/pay/test".into(),
        }));
    let launch = runtime
        .start_checkout(PaidTier::Pro)
        .expect("checkout launch");
    runtime.logout().expect("logout");
    let opened = AtomicUsize::new(0);

    let error = runtime
        .commit_browser_launch(&launch, |_| {
            opened.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .expect_err("revoked launch must not open");

    assert_eq!(error.code, "account_request_cancelled");
    assert_eq!(opened.load(Ordering::SeqCst), 0);
}
