#![allow(dead_code)]

use kalcode_contracts::identity::URL_SCHEME as SCHEME;

use crate::account;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};

use account::api::{
    AccountApi, ApiAccount, ApiError, BillingInterval, BrowserUrlResponse, EmailStartResponse,
    EntitlementResponse, PaidTier, PollResponse, SignedInResponse, SocialCompleteResponse,
    SocialStartResponse, UsageResponse,
};
use account::model::{
    AccountAuthority, AccountPhase, AccountTier, PendingAuthSecret, PublicAccount,
    SESSION_EXPIRED_REASON, SessionSecret,
};
use account::runtime::{AccountRuntime, Clock};
use account::session_store::{ACCOUNT_USAGE_RECEIPT_KEY, AccountSessionStore, CachedAccountSecret};
use account::social::SocialProvider;
use kalcode_entitlements::Verifier;
use kalcode_secure_store::{SecretKey, SecretStore, SecretStoreError, SecretString};

const NOW: i64 = 1_790_000_060;
const ACCOUNT_ID: &str = "0b6f1c1e-5a39-4d0c-9a0f-2b1f7d9e4c11";
fn test_key() -> String {
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../crates/entitlements/testdata/vectors.json"
    ))
    .expect("vectors");
    vectors["keys"][0]["x"].as_str().expect("key").into()
}

#[derive(Default)]
struct TestStore {
    values: Mutex<HashMap<String, SecretString>>,
    max_utf16_bytes: Option<usize>,
    reject_set_key: Mutex<Option<String>>,
    set_gate: Mutex<Option<Arc<PollGate>>>,
    delete_gate: Mutex<Option<Arc<PollGate>>>,
}

impl SecretStore for TestStore {
    fn backend(&self) -> &'static str {
        "account-runtime-test"
    }

    fn set(&self, key: &SecretKey, value: &SecretString) -> Result<(), SecretStoreError> {
        if self.reject_set_key.lock().expect("reject set").as_deref() == Some(key.account()) {
            return Err(SecretStoreError::Access("credential write refused".into()));
        }
        if self
            .max_utf16_bytes
            .is_some_and(|limit| value.expose_secret().encode_utf16().count() * 2 > limit)
        {
            return Err(SecretStoreError::Access(
                "Windows credential blob exceeds capacity".into(),
            ));
        }
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
    billing_intervals: Mutex<VecDeque<Result<Option<BillingInterval>, ApiError>>>,
    usage_reads: Mutex<VecDeque<Result<UsageResponse, ApiError>>>,
    request_usage: Mutex<VecDeque<Result<account::api::RequestUsageResponse, ApiError>>>,
    request_calls: Mutex<Vec<(String, bool)>>,
    starts: Mutex<VecDeque<Result<EmailStartResponse, ApiError>>>,
    polls: Mutex<VecDeque<Result<PollResponse, ApiError>>>,
    refreshes: Mutex<VecDeque<Result<SignedInResponse, ApiError>>>,
    social_completes: Mutex<VecDeque<Result<SocialCompleteResponse, ApiError>>>,
    social_complete_calls: Mutex<Vec<SocialCompleteCall>>,
    accounts: Mutex<VecDeque<Result<ApiAccount, ApiError>>>,
    entitlements: Mutex<VecDeque<Result<EntitlementResponse, ApiError>>>,
    checkouts: Mutex<VecDeque<Result<BrowserUrlResponse, ApiError>>>,
    poll_gate: Mutex<Option<Arc<PollGate>>>,
    refresh_gate: Mutex<Option<Arc<PollGate>>>,
    activate_calls: AtomicUsize,
    checkout_calls: AtomicUsize,
    checkout_request_ids: Mutex<Vec<String>>,
    checkout_intervals: Mutex<Vec<BillingInterval>>,
    account_calls: AtomicUsize,
    display_names: Mutex<VecDeque<Result<ApiAccount, ApiError>>>,
    display_name_calls: Mutex<Vec<Option<String>>>,
}

type SocialCompleteCall = (SocialProvider, String, String, String, String);

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
                "{base}?client_id=test-client&redirect_uri={redirect}&response_type=code&scope=openid%20email&state={state}&nonce={nonce}&code_challenge={code_challenge}&code_challenge_method=S256&prompt=select_account{response_mode}"
            ),
            nonce,
            expires_at: "2026-09-21T14:24:20.000Z".into(),
        })
    }

    fn complete_social(
        &self,
        provider: SocialProvider,
        state: &str,
        code: &str,
        code_verifier: &str,
        nonce: &str,
    ) -> Result<SocialCompleteResponse, ApiError> {
        if let Some(gate) = self.poll_gate.lock().expect("poll gate").clone() {
            gate.block_call();
        }
        self.social_complete_calls
            .lock()
            .expect("social calls")
            .push((
                provider,
                state.to_owned(),
                code.to_owned(),
                code_verifier.to_owned(),
                nonce.to_owned(),
            ));
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

    fn billing_interval(&self, _: &str) -> Result<Option<BillingInterval>, ApiError> {
        self.billing_intervals
            .lock()
            .expect("billing")
            .pop_front()
            .unwrap_or(Ok(None))
    }

    fn set_display_name(
        &self,
        _: &str,
        display_name: Option<&str>,
    ) -> Result<ApiAccount, ApiError> {
        self.display_name_calls
            .lock()
            .expect("display name calls")
            .push(display_name.map(str::to_owned));
        pop(&self.display_names)
    }

    fn activate_free(&self, _: &str) -> Result<(), ApiError> {
        self.activate_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn checkout(
        &self,
        _: &str,
        _: PaidTier,
        interval: BillingInterval,
        request_id: &str,
    ) -> Result<BrowserUrlResponse, ApiError> {
        self.checkout_calls.fetch_add(1, Ordering::SeqCst);
        self.checkout_intervals
            .lock()
            .expect("checkout intervals")
            .push(interval);
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
        pop(&self.usage_reads)
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
            display_name: None,
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
    let receipt = Verifier::from_keys([("test-vectors-1", test_key().as_str())])
        .expect("verifier")
        .verify_usage_receipt(&token, NOW)
        .expect("verified");
    account::api::RequestUsageResponse {
        allowed,
        usage: UsageResponse {
            receipt: token,
            usage: account::model::AccountUsageSnapshot {
                billing_interval: None,
                used: receipt.used,
                allowance: receipt.allowance,
                period_start: receipt.period_start,
                resets_at: receipt.resets_at,
            },
        },
    }
}

#[test]
fn verified_owner_usage_survives_windows_storage_and_offline_restart() {
    let backend = Arc::new(TestStore {
        max_utf16_bytes: Some(2560),
        ..TestStore::default()
    });
    let session = SessionSecret::new(signed_in().token, 1_900_000_000).expect("session");
    let cached = CachedAccountSecret::new(
        vector_token("cases", "owner"),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: format!("{}@example.com", "a".repeat(58)),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
            display_name: None,
        },
    )
    .expect("cache");
    AccountSessionStore::new(backend.as_ref())
        .expect("store")
        .save_full(Some(&session), None, Some(&cached), None)
        .expect("login persists");
    let api = Arc::new(FakeApi::default());
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    api.usage_reads
        .lock()
        .expect("queue")
        .push_back(Ok(request_receipt("owner-receipt", true).usage));
    let account = runtime(api.clone(), backend.clone());
    assert_eq!(
        account.bootstrap().expect("bootstrap").tier,
        Some(AccountTier::Owner)
    );
    let usage = account
        .usage()
        .expect("verified server usage persists within Windows capacity");
    assert_eq!(usage.allowance, None);
    assert_eq!(usage.used, 12345);
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    api.usage_reads
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    let restored = runtime(api, backend.clone());
    assert_eq!(
        restored.bootstrap().expect("restart").tier,
        Some(AccountTier::Owner)
    );
    let restored_usage = restored.usage().expect("signed cached usage");
    assert_eq!(restored_usage, usage);
    restored.logout().expect("logout");
    assert!(backend.values.lock().expect("secrets").is_empty());
}

#[test]
fn kalvoice_paid_owner_and_empty_offline_authority_use_signed_limits_and_exact_cycle() {
    use kalcode_kalvoice::accounting::RequestAccounting;
    for (tier, receipt, allowance, used) in [
        ("pro", Some("pro-receipt"), Some(150), 41),
        ("owner", Some("owner-receipt"), None, 12345),
        ("free", Some("free-receipt-exhausted"), Some(25), 25),
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
    assert_eq!(decision.usage.used, 42);
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
    assert_eq!(restarted.usage().expect("usage").used, 41);
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
            token: vector_token("cases", "free"),
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

/// A request the service rejected outright (4xx other than 429) was never counted and its
/// action never ran, so it is not replayed (and counted) later.
#[test]
fn kalvoice_definitive_rejection_is_never_replayed() {
    use kalcode_kalvoice::accounting::{self, RequestAccounting};
    let api = Arc::new(FakeApi::default());
    let account = metering_account(api.clone(), "pro", Some("pro-receipt"), false);
    let (_directory, core) = metering_core();
    let meter =
        crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), account).expect("meter");
    api.request_usage
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Http {
            status: 403,
            code: "forbidden".into(),
            retry_after_seconds: None,
        }));
    let id = kalcode_contracts::ids::new_id();
    assert!(meter.authorize(&id).is_err());
    assert!(
        core.read(|conn| accounting::next_pending(conn, ACCOUNT_ID))
            .expect("settled")
            .is_none()
    );
    meter.synchronize();
    assert_eq!(*api.request_calls.lock().expect("calls"), vec![(id, false)]);
    assert_eq!(meter.usage().expect("usage").used, 41);
}

#[test]
fn kalvoice_last_offline_unit_is_atomic_and_unscoped_ledger_is_ignored() {
    use kalcode_kalvoice::accounting::{self, RequestAccounting};
    let api = Arc::new(FakeApi::default());
    let account = metering_account(api.clone(), "free", None, true);
    let (_directory, core) = metering_core();
    let meter = crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), account.clone())
        .expect("meter");
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
        for _ in 0..24 {
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

    assert_eq!(meter.usage().expect("legacy count excluded").used, 24);
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
    assert_eq!(meter.usage().expect("usage").used, 25);
    assert!(api.request_calls.lock().expect("calls").is_empty());
}

#[test]
fn kalvoice_server_receipt_replaces_provisional_count_for_allow_and_deny() {
    use kalcode_kalvoice::accounting::{self, RequestAccounting};
    for (tier, receipt, allowed, used) in [
        ("pro", "pro-receipt", true, 41),
        ("free", "free-receipt-exhausted", false, 25),
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

/// Without a current receipt the device estimate counts the calendar month, which can include
/// the previous server cycle (anchored to the billing date). Online, that estimate never refuses
/// on its own: the server decides. It still refuses when the server can't be reached.
#[test]
fn kalvoice_expired_receipt_lets_the_server_decide_after_a_billing_cycle_reset() {
    use kalcode_kalvoice::accounting::{self, RequestAccounting};
    let api = Arc::new(FakeApi::default());
    let account = metering_account(api.clone(), "pro", None, false);
    let (_directory, core) = metering_core();
    // 150 requests already synced earlier this calendar month, in the previous server cycle.
    core.transact(|conn| {
        for _ in 0..150 {
            let id = kalcode_contracts::ids::new_id();
            accounting::reserve(conn, ACCOUNT_ID, &id, NOW - 60, false)?;
            accounting::settle(conn, ACCOUNT_ID, &id, true)?;
        }
        Ok(((), Vec::new()))
    })
    .expect("seed");
    let meter =
        crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), account).expect("meter");
    assert!(meter.usage().expect("estimate").exhausted());

    api.request_usage
        .lock()
        .expect("queue")
        .push_back(Ok(request_receipt("pro-receipt", true)));
    let id = kalcode_contracts::ids::new_id();
    let decision = meter.authorize(&id).expect("server decision");
    assert!(decision.allowed, "the server's fresh cycle admits it");
    assert_eq!(decision.usage.used, 41);
    assert_eq!(*api.request_calls.lock().expect("calls"), vec![(id, false)]);

    // Still without a receipt, an unreachable server leaves the conservative estimate in charge:
    // it refuses, and the refused claim is never replayed.
    let fresh = metering_account(api.clone(), "pro", None, false);
    let meter =
        crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), fresh).expect("meter");
    api.request_usage
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    let refused = meter
        .authorize(&kalcode_contracts::ids::new_id())
        .expect("estimate decision");
    assert!(!refused.allowed);
    assert!(
        core.read(|conn| accounting::next_pending(conn, ACCOUNT_ID))
            .expect("nothing to replay")
            .is_none()
    );
}

fn api_account(activated: bool) -> ApiAccount {
    ApiAccount {
        id: ACCOUNT_ID.into(),
        email: "owner@example.com".into(),
        activated_at: activated.then(|| "2026-09-25T12:00:00.000Z".into()),
        display_name: None,
    }
}

fn signed_in() -> SignedInResponse {
    SignedInResponse {
        token: format!("kcs_{}", "a".repeat(43)),
        expires_at: "2030-01-01T00:00:00.000Z".into(),
    }
}

fn runtime(api: Arc<FakeApi>, store: Arc<TestStore>) -> AccountRuntime {
    let verifier =
        Verifier::from_keys([("test-vectors-1", test_key().as_str())]).expect("test verifier");
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
            token: vector_token("cases", "free"),
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

    let launch = runtime
        .start_checkout(PaidTier::Max2x, BillingInterval::Month)
        .expect("checkout");
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
        vector_token("cases", "free"),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
            display_name: None,
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
    // The gate says why: the session was rejected, not signed out by the person.
    assert_eq!(
        snapshot.degraded_reason.as_deref(),
        Some(SESSION_EXPIRED_REASON)
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
fn an_expired_stored_session_bootstraps_to_a_session_expired_gate() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore::default());
    let session = SessionSecret::new(format!("kcs_{}", "a".repeat(43)), NOW - 60).expect("session");
    AccountSessionStore::new(store.as_ref())
        .expect("store")
        .save_full(Some(&session), None, None, None)
        .expect("seed");
    let runtime = runtime(api, store.clone());

    let snapshot = runtime.bootstrap().expect("bootstrap");
    assert_eq!(snapshot.phase, AccountPhase::SignedOut);
    assert_eq!(
        snapshot.degraded_reason.as_deref(),
        Some(SESSION_EXPIRED_REASON)
    );
    assert_eq!(runtime.authority(), AccountAuthority::SignedOut);
    assert!(
        AccountSessionStore::new(store.as_ref())
            .expect("store")
            .load()
            .expect("load")
            .is_none()
    );

    // A fresh start with nothing stored is a plain first-run gate, with no expiry message.
    let fresh = runtime_with_empty_store()
        .bootstrap()
        .expect("fresh bootstrap");
    assert_eq!(fresh.phase, AccountPhase::SignedOut);
    assert_eq!(fresh.degraded_reason, None);
}

fn runtime_with_empty_store() -> AccountRuntime {
    runtime(Arc::new(FakeApi::default()), Arc::new(TestStore::default()))
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
            "{SCHEME}://auth/microsoft?code=oauth-code&state={}",
            "s".repeat(43)
        ))
        .expect_err("provider mismatch");
    assert_eq!(wrong.code, "invalid_auth_callback");
    assert_eq!(runtime.snapshot().phase, AccountPhase::SocialPending);
    let stale = runtime
        .handle_social_callback_url(&format!(
            "{SCHEME}://auth/google?code=oauth-code&state={}",
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
            display_name: None,
        }));
    let signed_in = runtime
        .handle_social_callback_url(&format!(
            "{SCHEME}://auth/google?code=oauth-code&state={}",
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
            "{SCHEME}://auth/google?code=oauth-code&state={}",
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
fn cold_start_restores_persisted_social_pkce_before_completing_the_callback() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore::default());
    let state = "s".repeat(43);
    let verifier = "v".repeat(64);
    let nonce = "n".repeat(43);
    let pending = PendingAuthSecret::social(
        SocialProvider::Google,
        state.clone(),
        verifier.clone(),
        nonce.clone(),
        NOW + 300,
    )
    .expect("valid pending social attempt");
    AccountSessionStore::new(store.as_ref())
        .expect("store")
        .save(None, Some(&pending))
        .expect("persist pending attempt");
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
            display_name: None,
        }));

    let runtime = Arc::new(runtime(api.clone(), store));
    let (bootstrap_tx, bootstrap_rx) = mpsc::sync_channel(1);
    let bootstrapping = {
        let runtime = runtime.clone();
        std::thread::spawn(move || {
            let _ = bootstrap_tx.send(runtime.bootstrap());
        })
    };
    let bootstrap = bootstrap_rx
        .recv_timeout(std::time::Duration::from_secs(2))
        .expect("persisted social bootstrap must not deadlock")
        .expect("bootstrap pending attempt");
    bootstrapping.join().expect("bootstrap thread");
    assert_eq!(bootstrap.phase, AccountPhase::SocialPending);
    assert_eq!(
        runtime
            .handle_social_callback_url(&format!(
                "{SCHEME}://auth/google?code=oauth-code&state={state}"
            ))
            .expect("complete restored attempt")
            .phase,
        AccountPhase::AuthenticatedUnactivated
    );
    assert_eq!(
        *api.social_complete_calls.lock().expect("social calls"),
        vec![(
            SocialProvider::Google,
            state,
            "oauth-code".into(),
            verifier,
            nonce,
        )]
    );
}

#[test]
fn provider_authorization_code_completes_to_owner_and_restores_the_session() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore {
        max_utf16_bytes: Some(2560),
        ..TestStore::default()
    });
    let mut public = api_account(true);
    public.email = format!("{}@example.com", "a".repeat(58));
    let account = runtime(api.clone(), store.clone());
    account
        .start_social(SocialProvider::Google)
        .expect("start Google");
    let pending = AccountSessionStore::new(store.as_ref())
        .expect("store")
        .load()
        .expect("load pending")
        .expect("pending record")
        .pending()
        .cloned()
        .expect("pending social attempt");

    api.social_completes
        .lock()
        .expect("queue")
        .push_back(Ok(SocialCompleteResponse {
            token: signed_in().token,
            account_id: ACCOUNT_ID.into(),
            expires_at: "2030-01-01T00:00:00.000Z".into(),
        }));
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(public.clone()));
    api.entitlements
        .lock()
        .expect("queue")
        .push_back(Ok(EntitlementResponse {
            token: vector_token("cases", "owner"),
        }));

    let code = "4/0AcvDMr-synthetic+provider-code";
    let mut callback = url::Url::parse(&format!("{SCHEME}://auth/google")).expect("callback base");
    callback
        .query_pairs_mut()
        .append_pair("code", code)
        .append_pair("state", pending.expose_state().expect("state"));
    let signed_in = account
        .handle_social_callback_url(callback.as_str())
        .expect("complete provider authorization code");
    assert_eq!(signed_in.phase, AccountPhase::Ready);
    assert_eq!(signed_in.tier, Some(AccountTier::Owner));
    assert_eq!(account.authority(), AccountAuthority::Active);
    api.usage_reads
        .lock()
        .expect("queue")
        .push_back(Ok(request_receipt("owner-receipt", true).usage));
    let usage = account.usage().expect("Google owner usage persists");
    assert_eq!(usage.allowance, None);
    assert_eq!(usage.used, 12345);

    assert_eq!(
        *api.social_complete_calls.lock().expect("social calls"),
        vec![(
            SocialProvider::Google,
            pending.expose_state().expect("state").into(),
            code.into(),
            pending.expose_code_verifier().into(),
            pending.expose_nonce().expect("nonce").into(),
        )]
    );
    let stored = AccountSessionStore::new(store.as_ref())
        .expect("store")
        .load()
        .expect("load session")
        .expect("stored session");
    assert!(stored.session().is_some());
    assert!(stored.pending().is_none());
    assert!(stored.cached().is_some());

    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(public.clone()));
    api.entitlements
        .lock()
        .expect("queue")
        .push_back(Ok(EntitlementResponse {
            token: vector_token("cases", "owner"),
        }));
    let restored_account = Arc::new(runtime(api.clone(), store));
    let restored = restored_account.bootstrap().expect("restore session");
    assert_eq!(restored.phase, AccountPhase::Ready);
    assert_eq!(restored.tier, Some(AccountTier::Owner));
    api.usage_reads
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    assert_eq!(
        restored_account.usage().expect("restored owner usage"),
        usage
    );
    use kalcode_kalvoice::accounting::RequestAccounting;
    let (_directory, core) = metering_core();
    let meter =
        crate::kalvoice_accounting::AccountKalVoice::new(core, restored_account).expect("meter");
    api.request_usage
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    assert!(
        meter
            .authorize(&kalcode_contracts::ids::new_id())
            .expect("owner request")
            .allowed
    );
}

#[test]
fn metered_receipt_write_failure_keeps_last_unit_reserved_after_cold_offline_restore() {
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    use ed25519_dalek::{Signer as _, SigningKey};
    use kalcode_kalvoice::accounting::{self, RequestAccounting};

    // Test-only signing authority lets both metered tiers exercise their exact last unit.
    let key = SigningKey::from_bytes(&[59; 32]);
    let public_key = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
    let sign = |token: String, used: Option<u64>| {
        let parts: Vec<_> = token.split('.').collect();
        let mut payload: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).expect("test payload"))
                .expect("test JSON");
        if let Some(used) = used {
            payload["used"] = used.into();
        }
        let message = format!(
            "{}.{}",
            parts[0],
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("payload"))
        );
        format!(
            "{message}.{}",
            URL_SAFE_NO_PAD.encode(key.sign(message.as_bytes()).to_bytes())
        )
    };
    for (tier, receipt_name, allowance) in [
        ("free", "free-receipt-exhausted", 25_u64),
        ("pro", "pro-receipt", 150_u64),
    ] {
        let api = Arc::new(FakeApi::default());
        let store = Arc::new(TestStore::default());
        let entitlement = sign(vector_token("cases", tier), None);
        let old_receipt = sign(
            vector_token("receiptCases", receipt_name),
            Some(allowance - 1),
        );
        let session = SessionSecret::new(signed_in().token, 1_900_000_000).expect("session");
        let cached = CachedAccountSecret::new(
            entitlement.clone(),
            PublicAccount {
                id: ACCOUNT_ID.into(),
                email: "metered@example.com".into(),
                activated_at: Some("2026-09-01T12:00:00.000Z".into()),
                display_name: None,
            },
        )
        .expect("cache");
        let receipt =
            account::session_store::SignedUsageReceipt::new(old_receipt.clone()).expect("receipt");
        AccountSessionStore::new(store.as_ref())
            .expect("store")
            .save_full(Some(&session), None, Some(&cached), Some(&receipt))
            .expect("seed");
        let new_runtime = || {
            Arc::new(AccountRuntime::with_dependencies(
                api.clone(),
                store.clone(),
                Verifier::from_keys([("test-vectors-1", public_key.as_str())])
                    .expect("test verifier"),
                Arc::new(FixedClock),
            ))
        };
        api.accounts
            .lock()
            .expect("queue")
            .push_back(Ok(api_account(true)));
        api.entitlements
            .lock()
            .expect("queue")
            .push_back(Ok(EntitlementResponse { token: entitlement }));
        let account = new_runtime();
        assert_eq!(
            account.bootstrap().expect("online bootstrap").phase,
            AccountPhase::Ready
        );
        let (directory, core) = metering_core();
        let meter = crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), account.clone())
            .expect("meter");
        assert_eq!(
            u64::from(meter.usage().expect("before").used),
            allowance - 1
        );
        let mut confirmed = request_receipt(receipt_name, true);
        confirmed.usage.receipt = sign(vector_token("receiptCases", receipt_name), Some(allowance));
        confirmed.usage.usage.used = allowance;
        api.request_usage
            .lock()
            .expect("queue")
            .push_back(Ok(confirmed));
        *store.reject_set_key.lock().expect("reject set") = Some(ACCOUNT_USAGE_RECEIPT_KEY.into());
        let request = kalcode_contracts::ids::new_id();
        let result = meter.authorize(&request);
        // Close every in-memory account/meter/database object before checking restored authority.
        drop(meter);
        drop(account);
        drop(core);
        api.accounts.lock().expect("queue").extend([
            Err(ApiError::Transport),
            Err(ApiError::Transport),
            Err(ApiError::Transport),
        ]);
        let restored = new_runtime();
        assert_eq!(
            restored.bootstrap().expect("offline restore").phase,
            AccountPhase::OfflineGrace
        );
        let core = Arc::new(
            kalcode_core::Core::open(kalcode_core::CoreConfig {
                paths: kalcode_core::Paths::new(directory.path()),
                app_version: "test".into(),
                channel: kalcode_core::flags::BuildChannel::Development,
            })
            .expect("reopen durable core"),
        );
        let meter = crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), restored)
            .expect("restored meter");
        let next = meter
            .authorize(&kalcode_contracts::ids::new_id())
            .expect("offline admission decision");
        assert!(
            !next.allowed,
            "{tier} must not replenish the last unit after a failed receipt write"
        );
        assert_eq!(u64::from(next.usage.used), allowance);
        assert_eq!(
            result
                .expect_err("metered persistence must be mandatory")
                .code,
            "secure_store_unavailable"
        );
        assert_eq!(
            core.read(|conn| accounting::next_pending(conn, ACCOUNT_ID))
                .expect("pending claim"),
            Some((request, false))
        );
        let stored = AccountSessionStore::new(store.as_ref())
            .expect("store")
            .load()
            .expect("load")
            .expect("session remains");
        assert_eq!(
            stored
                .usage_receipt()
                .expect("old durable receipt")
                .expose_receipt(),
            old_receipt
        );
    }
}

#[test]
fn microsoft_owner_usage_stays_unlimited_when_the_receipt_cache_write_fails() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore {
        max_utf16_bytes: Some(2560),
        ..TestStore::default()
    });
    let account = runtime(api.clone(), store.clone());
    account
        .start_social(SocialProvider::Microsoft)
        .expect("start Microsoft");
    let pending = AccountSessionStore::new(store.as_ref())
        .expect("store")
        .load()
        .expect("load pending")
        .expect("pending record")
        .pending()
        .cloned()
        .expect("pending social attempt");
    api.social_completes
        .lock()
        .expect("queue")
        .push_back(Ok(SocialCompleteResponse {
            token: signed_in().token,
            account_id: ACCOUNT_ID.into(),
            expires_at: "2030-01-01T00:00:00.000Z".into(),
        }));
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(api_account(true)));
    api.entitlements
        .lock()
        .expect("queue")
        .push_back(Ok(EntitlementResponse {
            token: vector_token("cases", "owner"),
        }));
    // Entra authorization codes are long dotted visible-ASCII values.
    let code = format!("1.AXYA{}.synthetic-entra_code~", "x".repeat(1_400));
    let mut callback =
        url::Url::parse(&format!("{SCHEME}://auth/microsoft")).expect("callback base");
    callback
        .query_pairs_mut()
        .append_pair("code", &code)
        .append_pair("state", pending.expose_state().expect("state"));
    let signed_in = account
        .handle_social_callback_url(callback.as_str())
        .expect("complete Microsoft authorization code");
    assert_eq!(signed_in.phase, AccountPhase::Ready);
    assert_eq!(signed_in.tier, Some(AccountTier::Owner));

    // The receipt credential is only a cache. A refused OS write must not turn a verified
    // server-authoritative OWNER receipt into "Usage unavailable".
    *store.reject_set_key.lock().expect("reject set") = Some(ACCOUNT_USAGE_RECEIPT_KEY.into());
    api.usage_reads
        .lock()
        .expect("queue")
        .push_back(Ok(request_receipt("owner-receipt", true).usage));
    let usage = account
        .usage()
        .expect("verified OWNER usage despite receipt cache write failure");
    assert_eq!(usage.allowance, None);
    assert_eq!(usage.used, 12345);

    // The saved session remains authoritative and restores on a cold start.
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(api_account(true)));
    api.entitlements
        .lock()
        .expect("queue")
        .push_back(Ok(EntitlementResponse {
            token: vector_token("cases", "owner"),
        }));
    let restored_account = runtime(api.clone(), store.clone());
    let restored = restored_account.bootstrap().expect("restore session");
    assert_eq!(restored.phase, AccountPhase::Ready);
    assert_eq!(restored.tier, Some(AccountTier::Owner));
    api.usage_reads
        .lock()
        .expect("queue")
        .push_back(Ok(request_receipt("owner-receipt", true).usage));
    assert_eq!(
        restored_account
            .usage()
            .expect("restored OWNER usage despite receipt cache write failure"),
        usage
    );
    // A malformed or mismatched server receipt still never produces usage.
    api.usage_reads
        .lock()
        .expect("queue")
        .push_back(Ok(UsageResponse {
            receipt: "forged.receipt.signature".into(),
            usage: usage.clone(),
        }));
    assert!(restored_account.usage().is_err());
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
            "{SCHEME}://auth/microsoft?error=sign_in_canceled&state={}",
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
            "{SCHEME}://auth/google?code=oauth-code&state={}",
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
                "{SCHEME}://auth/google?code=oauth-code&state={}",
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
            display_name: None,
        }));
    api.entitlements
        .lock()
        .expect("queue")
        .push_back(Ok(EntitlementResponse {
            token: vector_token("cases", "free"),
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
        vector_token("cases", "free"),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
            display_name: None,
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
    let verifier =
        Verifier::from_keys([("test-vectors-1", test_key().as_str())]).expect("test verifier");
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
        vector_token("cases", "free"),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
            display_name: None,
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
        vector_token("cases", "free"),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
            display_name: None,
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
        vector_token("cases", "free"),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
            display_name: None,
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
        vector_token("cases", "free"),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
            display_name: None,
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

fn stored_session_present(store: &TestStore) -> bool {
    AccountSessionStore::new(store)
        .expect("store")
        .load()
        .expect("load")
        .is_some_and(|stored| stored.session().is_some())
}

#[test]
fn exit_preflight_waits_for_an_inflight_sign_out_to_clear_credentials_before_exit() {
    let store = Arc::new(TestStore::default());
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let cached = CachedAccountSecret::new(
        vector_token("cases", "free"),
        PublicAccount {
            id: ACCOUNT_ID.into(),
            email: "owner@example.com".into(),
            activated_at: Some("2026-09-25T12:00:00.000Z".into()),
            display_name: None,
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
    let runtime = Arc::new(runtime(api.clone(), store.clone()));
    runtime.bootstrap().expect("bootstrap");
    let lease = runtime.acquire_active_lease().expect("lease");
    // This is the account command's synchronous linearization point, before blocking-pool
    // dispatch and before coordinator draining. Exit must observe the accepted sign-out even
    // though its credential-clearing body has not started yet.
    let sign_out = runtime
        .begin_sign_out_command()
        .expect("sign-out command admission");
    let coordinator = crate::runtime_coordinator::RuntimeCoordinator::new(runtime.clone());
    assert_eq!(coordinator.lifecycle.pending(), (false, 0));
    assert!(!coordinator.drain_for_exit(std::time::Duration::from_millis(20)));
    assert!(stored_session_present(&store));

    let gate = Arc::new(PollGate::default());
    *api.refresh_gate.lock().expect("refresh gate") = Some(gate.clone());

    // An account request holds the request lane across a slow API call. It holds no lifecycle
    // lease, so the exit drain does not count it.
    let refreshing = {
        let runtime = runtime.clone();
        std::thread::spawn(move || runtime.refresh().expect("stale refresh"))
    };
    gate.wait_until_entered();
    // Sign-out revokes authority, then waits for the lane: credentials are not cleared yet.
    let logging_out = { std::thread::spawn(move || sign_out.logout()) };
    for _ in 0..10_000 {
        if !runtime.validate_active_lease(&lease) {
            break;
        }
        std::thread::yield_now();
    }
    assert!(!runtime.validate_active_lease(&lease));

    // The install/quit preflight: lifecycle work is idle, but the sign-out has not finished, so
    // exiting now would leave a valid stored session for the next launch. It must refuse.
    assert_eq!(coordinator.lifecycle.pending(), (false, 0));
    assert!(!coordinator.drain_for_exit(std::time::Duration::from_millis(200)));
    assert!(stored_session_present(&store));

    // Once the lane frees, sign-out clears credentials, and only then does the preflight pass.
    gate.release();
    assert!(coordinator.drain_for_exit(std::time::Duration::from_secs(10)));
    assert!(!stored_session_present(&store));
    assert_eq!(
        logging_out
            .join()
            .expect("logout thread")
            .expect("logout")
            .phase,
        AccountPhase::SignedOut
    );
    refreshing.join().expect("refresh thread");

    // After exit commits, a new sign-out is refused rather than started and cut off mid-clear.
    let refused = runtime
        .logout()
        .expect_err("sign-out after the exit commit");
    assert_eq!(refused.code, "account_exit_in_progress");
}

#[test]
fn abandoned_sign_out_command_releases_the_exit_waiter() {
    let store = Arc::new(TestStore::default());
    let runtime = Arc::new(runtime(Arc::new(FakeApi::default()), store));
    let coordinator = crate::runtime_coordinator::RuntimeCoordinator::new(runtime.clone());
    let sign_out = runtime
        .begin_sign_out_command()
        .expect("sign-out command admission");

    assert!(!coordinator.drain_for_exit(std::time::Duration::from_millis(20)));
    drop(sign_out);
    assert!(coordinator.drain_for_exit(std::time::Duration::from_secs(1)));
}

#[test]
fn denied_sign_out_command_has_no_account_or_credential_side_effects() {
    let store = Arc::new(TestStore::default());
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    AccountSessionStore::new(store.as_ref())
        .expect("store")
        .save(Some(&session), None)
        .expect("seed");
    let runtime = Arc::new(runtime(Arc::new(FakeApi::default()), store.clone()));
    let before = runtime.snapshot();
    let coordinator = crate::runtime_coordinator::RuntimeCoordinator::new(runtime.clone());
    assert!(coordinator.drain_for_exit(std::time::Duration::from_secs(1)));

    let refused = runtime
        .begin_sign_out_command()
        .err()
        .expect("exit-sealed sign-out must be denied");
    assert_eq!(refused.code, "account_exit_in_progress");
    assert_eq!(runtime.snapshot(), before);
    assert!(stored_session_present(&store));
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
        .start_checkout(PaidTier::Pro, BillingInterval::Month)
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

fn queue_checkout_url(api: &FakeApi) {
    api.checkouts
        .lock()
        .expect("queue")
        .push_back(Ok(BrowserUrlResponse {
            url: "https://checkout.stripe.com/c/pay/test".into(),
        }));
}

#[test]
fn yearly_checkout_sends_the_year_interval_and_persists_it_for_retries() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore::default());
    let runtime = runtime(api.clone(), store.clone());
    sign_in_unactivated(&runtime, &api);
    queue_checkout_url(&api);
    queue_checkout_url(&api);

    runtime
        .start_checkout(PaidTier::Max, BillingInterval::Year)
        .expect("yearly checkout");
    runtime
        .start_checkout(PaidTier::Max, BillingInterval::Year)
        .expect("same yearly checkout resumes");

    assert_eq!(
        *api.checkout_intervals.lock().expect("intervals"),
        vec![BillingInterval::Year, BillingInterval::Year]
    );
    let request_ids = api
        .checkout_request_ids
        .lock()
        .expect("checkout ids")
        .clone();
    assert_eq!(request_ids.len(), 2);
    assert_eq!(request_ids[0], request_ids[1]);
    let stored = AccountSessionStore::new(store.as_ref())
        .expect("store")
        .load()
        .expect("load")
        .expect("session");
    let pending = stored.checkout().expect("pending checkout");
    assert_eq!(pending.interval(), BillingInterval::Year);
    assert_eq!(pending.request_id(), request_ids[0]);
}

#[test]
fn pending_checkout_is_never_reused_for_a_different_interval() {
    let api = Arc::new(FakeApi::default());
    let runtime = runtime(api.clone(), Arc::new(TestStore::default()));
    sign_in_unactivated(&runtime, &api);
    queue_checkout_url(&api);

    runtime
        .start_checkout(PaidTier::Pro, BillingInterval::Month)
        .expect("monthly checkout");
    let refused = runtime
        .start_checkout(PaidTier::Pro, BillingInterval::Year)
        .expect_err("interval switch must not reuse the monthly checkout");

    assert_eq!(refused.code, "checkout_in_progress");
    assert_eq!(api.checkout_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        *api.checkout_intervals.lock().expect("intervals"),
        vec![BillingInterval::Month]
    );
}

fn named_account(display_name: Option<&str>) -> ApiAccount {
    ApiAccount {
        display_name: display_name.map(str::to_owned),
        ..api_account(true)
    }
}

fn sign_in_free(runtime: &AccountRuntime, api: &FakeApi) {
    sign_in_unactivated(runtime, api);
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(named_account(Some("Kaleb Campbell"))));
    api.entitlements
        .lock()
        .expect("queue")
        .push_back(Ok(EntitlementResponse {
            token: vector_token("cases", "free"),
        }));
    let snapshot = runtime.activate_free().expect("activate");
    assert_eq!(snapshot.phase, AccountPhase::Ready);
    assert_eq!(
        snapshot
            .account
            .as_ref()
            .and_then(|account| account.display_name.as_deref()),
        Some("Kaleb Campbell")
    );
}

fn shown_name(snapshot: &account::model::AccountSnapshot) -> Option<&str> {
    snapshot
        .account
        .as_ref()
        .and_then(|account| account.display_name.as_deref())
}

#[test]
fn display_name_saves_without_touching_authority_and_survives_an_offline_restart() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore::default());
    let runtime = runtime(api.clone(), store.clone());
    sign_in_free(&runtime, &api);
    let lease = runtime.acquire_active_lease().expect("active lease");
    let before = runtime.snapshot();

    api.display_names
        .lock()
        .expect("queue")
        .push_back(Ok(named_account(Some("Kaleb"))));
    let saved = runtime
        .set_display_name(Some("  Kaleb ".into()))
        .expect("saved");
    assert_eq!(shown_name(&saved), Some("Kaleb"));
    assert_eq!(
        api.display_name_calls.lock().expect("calls").as_slice(),
        [Some("  Kaleb ".to_owned())]
    );
    // Only the name changed: identity, plan, session and running work are untouched.
    let expected = account::model::AccountSnapshot {
        account: Some(PublicAccount {
            display_name: Some("Kaleb".into()),
            ..before.account.clone().expect("account")
        }),
        ..before.clone()
    };
    assert_eq!(saved, expected);
    assert!(runtime.validate_active_lease(&lease));

    // A cold start without the account service still shows the saved name.
    let offline_api = Arc::new(FakeApi::default());
    offline_api
        .accounts
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    let restarted = runtime_for(offline_api, store.clone());
    let offline = restarted.bootstrap().expect("offline bootstrap");
    assert_eq!(offline.phase, AccountPhase::OfflineGrace);
    assert_eq!(shown_name(&offline), Some("Kaleb"));

    // Clearing removes the cached name too.
    api.display_names
        .lock()
        .expect("queue")
        .push_back(Ok(named_account(None)));
    assert_eq!(
        shown_name(&runtime.set_display_name(None).expect("cleared")),
        None
    );
    let offline_api = Arc::new(FakeApi::default());
    offline_api
        .accounts
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Transport));
    let restarted = runtime_for(offline_api, store);
    assert_eq!(shown_name(&restarted.bootstrap().expect("offline")), None);
}

fn runtime_for(api: Arc<FakeApi>, store: Arc<TestStore>) -> AccountRuntime {
    runtime(api, store)
}

#[test]
fn display_name_failures_are_truthful_and_leave_the_saved_name() {
    let api = Arc::new(FakeApi::default());
    let runtime = runtime(api.clone(), Arc::new(TestStore::default()));
    sign_in_free(&runtime, &api);

    api.display_names.lock().expect("queue").extend([
        Err(ApiError::Http {
            status: 400,
            code: "invalid_display_name".into(),
            retry_after_seconds: None,
        }),
        Err(ApiError::Transport),
        Err(ApiError::Http {
            status: 404,
            code: "not_found".into(),
            retry_after_seconds: None,
        }),
        Err(ApiError::Http {
            status: 429,
            code: "rate_limited".into(),
            retry_after_seconds: Some(5),
        }),
        // A response naming another account is never shown.
        Ok(ApiAccount {
            id: "someone-else".into(),
            ..named_account(Some("Mallory"))
        }),
        // Nor is a name the server could never have stored.
        Ok(named_account(Some("Bad\u{7}Name"))),
    ]);
    let codes: Vec<&str> = (0..6)
        .map(|_| {
            runtime
                .set_display_name(Some("Kaleb".into()))
                .expect_err("refused")
                .code
        })
        .collect();
    assert_eq!(
        codes,
        [
            "invalid_display_name",
            "account_service_unavailable",
            "account_service_unavailable",
            "rate_limited",
            "account_identity_mismatch",
            "invalid_account_response",
        ]
    );
    assert_eq!(shown_name(&runtime.snapshot()), Some("Kaleb Campbell"));
    assert_eq!(runtime.authority(), AccountAuthority::Active);

    // Oversized input never reaches the network.
    let calls = api.display_name_calls.lock().expect("calls").len();
    let error = runtime
        .set_display_name(Some("x".repeat(2000)))
        .expect_err("too long");
    assert_eq!(error.code, "invalid_display_name");
    assert_eq!(api.display_name_calls.lock().expect("calls").len(), calls);
}

#[test]
fn display_name_unauthorized_returns_the_sign_in_gate() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore::default());
    let runtime = runtime(api.clone(), store.clone());
    sign_in_free(&runtime, &api);
    api.display_names
        .lock()
        .expect("queue")
        .push_back(Err(ApiError::Http {
            status: 401,
            code: "unauthenticated".into(),
            retry_after_seconds: None,
        }));
    let error = runtime
        .set_display_name(Some("Kaleb".into()))
        .expect_err("signed out");
    assert_eq!(error.code, "authentication_required");
    assert_eq!(runtime.authority(), AccountAuthority::SignedOut);
    assert!(!stored_session_present(&store));
}

#[test]
fn billing_metadata_does_not_block_ready_and_usage_shows_real_interval() {
    for interval in [BillingInterval::Month, BillingInterval::Year] {
        let api = Arc::new(FakeApi::default());
        api.billing_intervals
            .lock()
            .expect("billing")
            .push_back(Ok(Some(interval)));
        let runtime = metering_account(api.clone(), "pro", Some("pro-receipt"), false);
        assert_eq!(
            runtime.snapshot().billing_interval,
            None,
            "Ready never waits for Stripe"
        );
        assert_eq!(api.billing_intervals.lock().expect("billing").len(), 1);
        // The cached signed receipt supplies usage if its optional refresh is offline.
        api.usage_reads.lock().expect("usage").extend([
            Err(ApiError::Transport),
            Err(ApiError::Transport),
            Err(ApiError::Transport),
        ]);
        let usage = runtime.usage().expect("cached usage");
        assert_eq!(usage.billing_interval, Some(interval));
        assert_eq!(runtime.snapshot().tier, Some(AccountTier::Pro));
    }
}

#[test]
fn legacy_local_outbox_is_retired_once_and_never_replayed_as_cloud() {
    use kalcode_kalvoice::accounting;
    let api = Arc::new(FakeApi::default());
    let account = metering_account(api.clone(), "pro", Some("pro-receipt"), false);
    let (_directory, core) = metering_core();
    let id = kalcode_contracts::ids::new_id();
    core.transact(|conn| {
        accounting::reserve(conn, ACCOUNT_ID, &id, NOW, true)?;
        Ok(((), vec![]))
    })
    .expect("legacy local claim");
    let meter =
        crate::kalvoice_accounting::AccountKalVoice::new(core.clone(), account).expect("upgrade");
    meter.synchronize();
    assert!(api.request_calls.lock().expect("calls").is_empty());
    assert!(
        core.read(|conn| accounting::next_pending(conn, ACCOUNT_ID))
            .expect("outbox")
            .is_none()
    );
    assert!(
        core.transact(|conn| {
            accounting::reserve(conn, ACCOUNT_ID, &id, NOW, true)?;
            Ok(((), vec![]))
        })
        .is_err(),
        "identity fence remains"
    );
}

#[test]
fn free_memory_keeps_local_notes_and_instructions_without_provider_enrichment() {
    use kalcode_contracts::unified_memory::MemorySourceKind;

    let api = Arc::new(FakeApi::default());
    let account = metering_account(api, "free", None, false);
    let (_directory, core) = metering_core();
    let project = tempfile::tempdir().expect("project");
    let instructions = "Architecture: SQLite stores project knowledge.";
    std::fs::write(project.path().join("AGENTS.md"), instructions).expect("instruction file");
    let workspace = core.open_workspace(project.path()).expect("workspace");
    let memory = crate::unified_memory_commands::MemoryService::start(core.clone(), &account)
        .expect("basic memory");
    // The background importer may already have captured this exact file; both paths must
    // preserve the same basic memory, without requiring a duplicate insertion.
    memory
        .capture_now(
            &workspace.id,
            MemorySourceKind::Instructions,
            Some("AGENTS.md"),
            instructions,
        )
        .expect("instructions");
    assert!(
        memory
            .recall(&workspace.id, "SQLite")
            .expect("local recall")
            .contains("SQLite")
    );
    assert!(
        memory
            .provider_context(&workspace.id, "SQLite")
            .expect("provider context")
            .is_empty()
    );
    for source in [
        MemorySourceKind::User,
        MemorySourceKind::Agent,
        MemorySourceKind::Run,
        MemorySourceKind::Merge,
    ] {
        assert_eq!(
            memory
                .capture_now(
                    &workspace.id,
                    source,
                    Some("session"),
                    "Decision: Automatically captured provider outcome."
                )
                .expect("optional capture"),
            0
        );
    }
    let notes = kalcode_context::memory::list(&core.reader(), ACCOUNT_ID, &workspace.id, "")
        .expect("basic local notes");
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].source_kind, MemorySourceKind::Instructions);
}

#[test]
fn existing_memory_service_stops_provider_context_after_verified_downgrade() {
    use kalcode_contracts::unified_memory::MemorySourceKind;

    let api = Arc::new(FakeApi::default());
    let account = metering_account(api.clone(), "pro", None, false);
    let (_directory, core) = metering_core();
    let project = tempfile::tempdir().expect("project");
    let workspace = core.open_workspace(project.path()).expect("workspace");
    let memory = crate::unified_memory_commands::MemoryService::start(core.clone(), &account)
        .expect("project memory");
    assert!(
        memory
            .capture_now(
                &workspace.id,
                MemorySourceKind::Agent,
                Some("session"),
                "Architecture: SQLite stores project knowledge."
            )
            .expect("automatic capture")
            > 0
    );
    assert!(
        memory
            .provider_context(&workspace.id, "SQLite")
            .expect("shared context")
            .contains("SQLite")
    );

    api.refreshes
        .lock()
        .expect("queue")
        .push_back(Ok(signed_in()));
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(api_account(true)));
    api.entitlements
        .lock()
        .expect("queue")
        .push_back(Ok(EntitlementResponse {
            token: vector_token("cases", "free"),
        }));
    assert_eq!(
        account.refresh().expect("downgrade").tier,
        Some(AccountTier::Free)
    );
    assert!(
        memory
            .provider_context(&workspace.id, "SQLite")
            .expect("same service")
            .is_empty()
    );
    assert_eq!(
        memory
            .capture_now(
                &workspace.id,
                MemorySourceKind::Agent,
                Some("later-session"),
                "Decision: A later automatic outcome."
            )
            .expect("capture after downgrade"),
        0
    );
    assert!(
        memory
            .recall(&workspace.id, "SQLite")
            .expect("saved memory retained")
            .contains("SQLite")
    );
    assert_eq!(
        kalcode_context::memory::list(&core.reader(), ACCOUNT_ID, &workspace.id, "")
            .expect("existing note survives")
            .len(),
        1
    );
}

/// Pro vector document: issued at 1_790_000_000, expiring 7 days later.
const PRO_DOCUMENT_EXPIRES_AT: i64 = 1_790_604_800;

fn ready_pro_account(api: &Arc<FakeApi>, clock: &Arc<MutableClock>) -> AccountRuntime {
    let store = Arc::new(TestStore::default());
    AccountSessionStore::new(store.as_ref())
        .expect("store")
        .save_full(
            Some(&SessionSecret::new(signed_in().token, 1_900_000_000).expect("session")),
            None,
            None,
            None,
        )
        .expect("seed");
    queue_pro_authority(api);
    let verifier =
        Verifier::from_keys([("test-vectors-1", test_key().as_str())]).expect("test verifier");
    let runtime = AccountRuntime::with_dependencies(api.clone(), store, verifier, clock.clone());
    assert_eq!(
        runtime.bootstrap().expect("bootstrap").phase,
        AccountPhase::Ready
    );
    runtime
}

fn queue_pro_authority(api: &FakeApi) {
    api.accounts
        .lock()
        .expect("queue")
        .push_back(Ok(api_account(true)));
    api.entitlements
        .lock()
        .expect("queue")
        .push_back(Ok(EntitlementResponse {
            token: vector_token("cases", "pro"),
        }));
}

#[test]
fn a_same_account_refresh_keeps_long_lived_work_valid_until_authority_really_ends() {
    let api = Arc::new(FakeApi::default());
    let clock = Arc::new(MutableClock(AtomicI64::new(NOW)));
    let runtime = ready_pro_account(&api, &clock);
    let lease = runtime.acquire_active_lease().expect("active lease");

    api.refreshes
        .lock()
        .expect("queue")
        .push_back(Ok(signed_in()));
    queue_pro_authority(&api);
    assert_eq!(
        runtime.refresh().expect("refresh").phase,
        AccountPhase::Ready
    );

    // The refresh bumps the authority revision: a one-shot command lease ends, but services that
    // live as long as the runtime (integrations) keep working for the same account.
    assert!(!runtime.validate_active_lease(&lease));
    assert!(runtime.validate_active_account(&lease, ACCOUNT_ID));
    assert!(!runtime.validate_active_account(&lease, "another-account"));

    // Expiry of the signed document still ends them, exactly like sign-out.
    clock.0.store(PRO_DOCUMENT_EXPIRES_AT, Ordering::SeqCst);
    assert!(!runtime.validate_active_account(&lease, ACCOUNT_ID));
}

#[test]
fn a_running_account_renews_its_signed_plan_before_it_expires() {
    let api = Arc::new(FakeApi::default());
    let clock = Arc::new(MutableClock(AtomicI64::new(NOW)));
    let runtime = ready_pro_account(&api, &clock);

    // A fresh document has nothing to renew.
    assert!(!runtime.entitlement_renewal_due());

    // A day before it lapses, it is due; the renewal fetches a new signed document.
    clock.0.store(
        PRO_DOCUMENT_EXPIRES_AT - account::runtime::ENTITLEMENT_RENEW_BEFORE_SECONDS + 60,
        Ordering::SeqCst,
    );
    assert!(runtime.entitlement_renewal_due());
    api.refreshes
        .lock()
        .expect("queue")
        .push_back(Ok(signed_in()));
    queue_pro_authority(&api);
    assert_eq!(
        runtime.refresh().expect("renewal").phase,
        AccountPhase::Ready
    );
    assert!(api.refreshes.lock().expect("queue").is_empty());
    assert!(api.entitlements.lock().expect("queue").is_empty());
    assert!(runtime.acquire_active_lease().is_ok());
}

#[test]
fn signed_out_and_unactivated_accounts_never_renew_a_plan_document() {
    let api = Arc::new(FakeApi::default());
    let store = Arc::new(TestStore::default());
    let runtime = runtime(api.clone(), store);
    assert!(!runtime.entitlement_renewal_due());
    sign_in_unactivated(&runtime, &api);
    assert!(!runtime.entitlement_renewal_due());
}
