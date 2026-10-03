#![allow(dead_code)]

use crate::account;

use std::collections::HashMap;
use std::sync::Mutex;

use account::api::{BillingInterval, PaidTier};
use account::model::{PendingAuthSecret, PublicAccount, SessionSecret};
use account::session_store::{
    ACCOUNT_CHECKOUT_INTERVAL_KEY, ACCOUNT_SESSION_KEY, ACCOUNT_USAGE_RECEIPT_KEY,
    AccountSessionStore, CachedAccountSecret, PendingCheckoutSecret, SessionStoreError,
    SignedUsageReceipt,
};
use account::social::SocialProvider;
use kalcode_secure_store::{SecretKey, SecretStore, SecretStoreError, SecretString};

#[derive(Default)]
struct TestStore {
    values: Mutex<HashMap<String, SecretString>>,
    max_utf16_bytes: Option<usize>,
    reject_key: Mutex<Option<String>>,
    reject_get: Mutex<Option<String>>,
    reject_delete: Mutex<Option<String>>,
}

struct FailingStore;

impl SecretStore for FailingStore {
    fn backend(&self) -> &'static str {
        "failing-account-test"
    }

    fn set(&self, _: &SecretKey, _: &SecretString) -> Result<(), SecretStoreError> {
        Err(secret_shaped_backend_error())
    }

    fn get(&self, _: &SecretKey) -> Result<Option<SecretString>, SecretStoreError> {
        Err(secret_shaped_backend_error())
    }

    fn delete(&self, _: &SecretKey) -> Result<bool, SecretStoreError> {
        Err(secret_shaped_backend_error())
    }
}

fn secret_shaped_backend_error() -> SecretStoreError {
    SecretStoreError::Access("credential=never-render-this-backend-detail".into())
}

impl SecretStore for TestStore {
    fn backend(&self) -> &'static str {
        "account-test"
    }

    fn set(&self, key: &SecretKey, value: &SecretString) -> Result<(), SecretStoreError> {
        if self.reject_key.lock().expect("reject key").as_deref() == Some(key.account()) {
            return Err(secret_shaped_backend_error());
        }
        if self
            .max_utf16_bytes
            .is_some_and(|limit| value.expose_secret().encode_utf16().count() * 2 > limit)
        {
            return Err(SecretStoreError::Access(
                "Windows credential blob exceeds capacity".into(),
            ));
        }
        self.values
            .lock()
            .expect("store lock")
            .insert(key.account().to_owned(), value.clone());
        Ok(())
    }

    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>, SecretStoreError> {
        if self.reject_get.lock().expect("reject get").as_deref() == Some(key.account()) {
            return Err(secret_shaped_backend_error());
        }
        Ok(self
            .values
            .lock()
            .expect("store lock")
            .get(key.account())
            .cloned())
    }

    fn delete(&self, key: &SecretKey) -> Result<bool, SecretStoreError> {
        if self.reject_delete.lock().expect("reject delete").as_deref() == Some(key.account()) {
            return Err(secret_shaped_backend_error());
        }
        Ok(self
            .values
            .lock()
            .expect("store lock")
            .remove(key.account())
            .is_some())
    }
}

fn account() -> PublicAccount {
    PublicAccount {
        id: "account-1".into(),
        email: "owner@example.com".into(),
        activated_at: Some("2026-09-25T12:00:00.000Z".into()),
        display_name: None,
    }
}

// Storage validates token shape; verification remains the account runtime's responsibility.
// Rebuild public vector payloads with production-sized identifiers without reading credentials.
fn social_token_shape(section: &str, name: &str, account_id: &str) -> String {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let vectors: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../../crates/entitlements/testdata/vectors.json"
    ))
    .expect("vectors");
    let token = vectors[section]
        .as_array()
        .expect("cases")
        .iter()
        .find(|case| case["name"] == name)
        .expect("case")["token"]
        .as_str()
        .expect("token");
    let mut parts: Vec<String> = token.split('.').map(str::to_owned).collect();
    for (index, part) in parts.iter_mut().take(2).enumerate() {
        let mut payload: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part.as_bytes()).expect("base64"))
                .expect("payload");
        if index == 0 {
            payload["kid"] = "k2026-09-25".into();
        } else {
            payload["keyId"] = "k2026-09-25".into();
            payload["accountId"] = account_id.into();
        }
        *part = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).expect("JSON"));
    }
    parts.join(".")
}

#[test]
fn social_owner_usage_receipt_round_trips_with_windows_credential_capacity() {
    let backend = TestStore {
        max_utf16_bytes: Some(2560),
        ..TestStore::default()
    };
    let store = AccountSessionStore::new(&backend).expect("store");
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let public = PublicAccount {
        id: format!("acct_{}", "a".repeat(43)),
        email: "owner@example.com".into(),
        activated_at: Some("2026-09-25T12:00:00.000Z".into()),
        display_name: None,
    };
    let cached = CachedAccountSecret::new(social_token_shape("cases", "owner", &public.id), public)
        .expect("entitlement");
    let receipt = SignedUsageReceipt::new(social_token_shape(
        "receiptCases",
        "owner-receipt",
        &cached.account().id,
    ))
    .expect("receipt");
    store
        .save_full(Some(&session), None, Some(&cached), None)
        .expect("login fits Windows credential");
    store
        .save_full(Some(&session), None, Some(&cached), Some(&receipt))
        .expect("adding verified usage must fit Windows credential storage");
    let loaded = store.load().expect("restart load").expect("session");
    assert_eq!(loaded.cached().expect("cached").account(), cached.account());
    assert_eq!(
        loaded.usage_receipt().expect("receipt").expose_receipt(),
        receipt.expose_receipt()
    );
    store.clear().expect("logout");
    assert!(
        backend.values.lock().expect("store").is_empty(),
        "logout removes account secrets"
    );
}

#[test]
fn receipt_backend_failures_do_not_replace_or_restore_session_authority() {
    let backend = TestStore::default();
    let store = AccountSessionStore::new(&backend).expect("store");
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let cached =
        CachedAccountSecret::new("header.payload.signature".into(), account()).expect("cache");
    let usage = SignedUsageReceipt::new("usage.payload.signature".into()).expect("receipt");
    store
        .save_full(Some(&session), None, Some(&cached), Some(&usage))
        .expect("seed");
    *backend.reject_get.lock().expect("reject get") = Some(ACCOUNT_USAGE_RECEIPT_KEY.into());
    let loaded = store
        .load()
        .expect("optional read failure")
        .expect("session");
    assert_eq!(loaded.cached(), Some(&cached));
    assert!(loaded.usage_receipt().is_none());
    *backend.reject_get.lock().expect("reject get") = None;
    *backend.reject_key.lock().expect("reject key") = Some(ACCOUNT_USAGE_RECEIPT_KEY.into());
    let changed = SignedUsageReceipt::new("changed.payload.signature".into()).expect("receipt");
    assert!(
        store
            .save_full(Some(&session), None, Some(&cached), Some(&changed))
            .is_err()
    );
    assert_eq!(
        store
            .load()
            .expect("load")
            .expect("session")
            .usage_receipt(),
        Some(&usage)
    );
    *backend.reject_delete.lock().expect("reject delete") = Some(ACCOUNT_USAGE_RECEIPT_KEY.into());
    assert!(
        store.clear().is_err(),
        "failed cache cleanup must be reported"
    );
    assert!(
        store.load().expect("load").is_none(),
        "orphan cache cannot restore deleted session"
    );
    *backend.reject_delete.lock().expect("reject delete") = None;
    store.clear().expect("retry cleanup");
    assert!(backend.values.lock().expect("values").is_empty());
}

#[test]
fn legacy_inline_receipt_migrates_without_losing_session_or_receipt() {
    let backend = TestStore::default();
    let store = AccountSessionStore::new(&backend).expect("store");
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let cached =
        CachedAccountSecret::new("header.payload.signature".into(), account()).expect("cache");
    let usage = SignedUsageReceipt::new("usage.payload.signature".into()).expect("receipt");
    store
        .save_full(Some(&session), None, Some(&cached), None)
        .expect("seed");
    let key = SecretKey::new(ACCOUNT_SESSION_KEY).expect("key");
    let mut legacy: serde_json::Value = serde_json::from_str(
        backend
            .get(&key)
            .expect("get")
            .expect("envelope")
            .expose_secret(),
    )
    .expect("JSON");
    legacy["usageReceipt"] = usage.expose_receipt().into();
    backend
        .set(&key, &SecretString::new(legacy.to_string()))
        .expect("legacy envelope");
    let loaded = store.load().expect("legacy load").expect("session");
    assert_eq!(loaded.usage_receipt(), Some(&usage));
    store
        .save_full(
            loaded.session(),
            loaded.pending(),
            loaded.cached(),
            loaded.usage_receipt(),
        )
        .expect("migration save");
    let migrated: serde_json::Value = serde_json::from_str(
        backend
            .get(&key)
            .expect("get")
            .expect("envelope")
            .expose_secret(),
    )
    .expect("JSON");
    assert!(migrated["usageReceipt"].is_null());
    let restored = store.load().expect("load").expect("session");
    assert_eq!(
        restored.session().expect("session").expose_token(),
        session.expose_token()
    );
    assert_eq!(restored.usage_receipt(), Some(&usage));
}

#[test]
fn interrupted_account_switch_cannot_attach_another_accounts_receipt() {
    let backend = TestStore::default();
    let store = AccountSessionStore::new(&backend).expect("store");
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let cached =
        CachedAccountSecret::new("header.payload.signature".into(), account()).expect("cache");
    let usage = SignedUsageReceipt::new("usage.payload.signature".into()).expect("receipt");
    store
        .save_full(Some(&session), None, Some(&cached), Some(&usage))
        .expect("initial account");
    let mut other = account();
    other.id = "account-2".into();
    let other_cache =
        CachedAccountSecret::new("other.payload.signature".into(), other).expect("cache");
    *backend.reject_key.lock().expect("reject key") = Some(ACCOUNT_SESSION_KEY.into());
    assert!(
        store
            .save_full(Some(&session), None, Some(&other_cache), Some(&usage))
            .is_err()
    );
    let restored = store
        .load()
        .expect("old session remains readable")
        .expect("session");
    assert_eq!(restored.cached().expect("cache").account().id, "account-1");
    assert!(
        restored.usage_receipt().is_none(),
        "foreign account cache must be ignored"
    );
    store.clear().expect("logout clears both accounts' data");
    assert!(backend.values.lock().expect("values").is_empty());
}

#[test]
fn corrupt_optional_receipt_does_not_discard_verified_login_state() {
    let backend = TestStore::default();
    let store = AccountSessionStore::new(&backend).expect("store");
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let cached =
        CachedAccountSecret::new("header.payload.signature".into(), account()).expect("cache");
    store
        .save_full(Some(&session), None, Some(&cached), None)
        .expect("session");
    backend
        .set(
            &SecretKey::new(ACCOUNT_USAGE_RECEIPT_KEY).expect("key"),
            &SecretString::new("invalid"),
        )
        .expect("broken cache");
    let restored = store
        .load()
        .expect("login remains readable")
        .expect("session");
    assert_eq!(restored.cached(), Some(&cached));
    assert!(restored.usage_receipt().is_none());
}

#[test]
fn signed_cache_round_trips_only_inside_account_os_credentials() {
    let backend = TestStore::default();
    let store = AccountSessionStore::new(&backend).expect("store");
    let session =
        SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session");
    let cached =
        CachedAccountSecret::new("header.payload.signature".into(), account()).expect("cache");
    let usage = SignedUsageReceipt::new("usage.payload.signature".into()).expect("receipt");

    store
        .save_full(Some(&session), None, Some(&cached), Some(&usage))
        .expect("save");
    let mut keys = backend
        .values
        .lock()
        .expect("lock")
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    keys.sort();
    assert_eq!(keys, vec![ACCOUNT_SESSION_KEY, ACCOUNT_USAGE_RECEIPT_KEY]);

    let loaded = store.load().expect("load").expect("value");
    assert_eq!(
        loaded.session().expect("session").expires_at(),
        1_900_000_000
    );
    assert_eq!(loaded.cached().expect("cache").account(), &account());
    assert_eq!(
        loaded.usage_receipt().expect("usage").expose_receipt(),
        "usage.payload.signature"
    );
    let debug = format!(
        "{loaded:?} {:?} {:?}",
        loaded.cached(),
        loaded.usage_receipt()
    );
    assert!(!debug.contains("header.payload"));
    assert!(!debug.contains("usage.payload"));
    assert!(!debug.contains("kcs_"));
}

#[test]
fn backend_error_discards_underlying_diagnostics_at_the_session_boundary() {
    let store = AccountSessionStore::new(&FailingStore).expect("valid fixed session key");
    let error = store.load().expect_err("backend failure");

    assert!(matches!(error, SessionStoreError::Backend));
    assert_eq!(format!("{error:?}"), "Backend");
    assert_eq!(
        error.to_string(),
        "the system credential store is unavailable"
    );
    assert!(!format!("{error:?} {error}").contains("never-render-this-backend-detail"));
}

#[test]
fn malformed_or_orphaned_signed_cache_fails_closed() {
    let backend = TestStore::default();
    let key = SecretKey::new(ACCOUNT_SESSION_KEY).expect("key");
    backend
        .set(
            &key,
            &SecretString::new(
                r#"{"version":1,"session":null,"pending":null,"cached":{"entitlementToken":"header.payload.signature","accountId":"account-1","email":"owner@example.com","activatedAt":"2026-09-25T12:00:00.000Z"},"usageReceipt":null}"#,
            ),
        )
        .expect("seed");
    let store = AccountSessionStore::new(&backend).expect("store");
    assert!(store.load().is_err());
}

#[test]
fn social_pending_round_trips_in_v2_and_legacy_email_v1_remains_readable() {
    let backend = TestStore::default();
    let store = AccountSessionStore::new(&backend).expect("store");
    let social = PendingAuthSecret::social(
        SocialProvider::Microsoft,
        "s".repeat(43),
        "v".repeat(64),
        "n".repeat(43),
        1_900_000_000,
    )
    .expect("pending");
    store.save(None, Some(&social)).expect("save social");
    let raw = backend
        .values
        .lock()
        .expect("lock")
        .get(ACCOUNT_SESSION_KEY)
        .expect("envelope")
        .expose_secret()
        .to_owned();
    assert!(raw.contains(r#""version":2"#));
    assert!(raw.contains(r#""kind":"social""#));
    let loaded = store.load().expect("load").expect("value");
    assert_eq!(
        loaded.pending().expect("pending").social_provider(),
        Some(SocialProvider::Microsoft)
    );

    let key = SecretKey::new(ACCOUNT_SESSION_KEY).expect("key");
    backend
        .set(
            &key,
            &SecretString::new(format!(
                r#"{{"version":1,"session":null,"pending":{{"pollToken":"{}","codeVerifier":"{}","expiresAt":1900000000,"email":"owner@example.com"}},"cached":null,"usageReceipt":null,"checkout":null}}"#,
                "p".repeat(43),
                "v".repeat(64)
            )),
        )
        .expect("seed legacy");
    let legacy = store.load().expect("load legacy").expect("legacy");
    assert_eq!(
        legacy.pending().expect("pending").email(),
        Some("owner@example.com")
    );
}

fn raw_value(backend: &TestStore, key: &str) -> Option<String> {
    backend
        .values
        .lock()
        .expect("values")
        .get(key)
        .map(|value| value.expose_secret().to_owned())
}

fn checkout_session() -> SessionSecret {
    SessionSecret::new(format!("kcs_{}", "a".repeat(43)), 1_900_000_000).expect("session")
}

/// The exact envelope every shipped 0.1.8 build writes and strictly parses for a pending checkout.
fn shipped_checkout_envelope(request_id: &str, tier: &str) -> String {
    format!(
        r#"{{"version":2,"session":{{"token":"kcs_{}","expiresAt":1900000000}},"pending":null,"cached":null,"usageReceipt":null,"checkout":{{"requestId":"{request_id}","tier":"{tier}"}}}}"#,
        "a".repeat(43)
    )
}

#[test]
fn monthly_pending_checkout_record_is_byte_identical_to_the_shipped_format() {
    let backend = TestStore::default();
    let store = AccountSessionStore::new(&backend).expect("store");
    let checkout = PendingCheckoutSecret::new(
        "request-month-0001".into(),
        PaidTier::Max,
        BillingInterval::Month,
    )
    .expect("checkout");
    store
        .save_complete(Some(&checkout_session()), None, None, None, Some(&checkout))
        .expect("save");

    assert_eq!(
        raw_value(&backend, ACCOUNT_SESSION_KEY).as_deref(),
        Some(shipped_checkout_envelope("request-month-0001", "max").as_str())
    );
    assert!(raw_value(&backend, ACCOUNT_CHECKOUT_INTERVAL_KEY).is_none());
    let loaded = store.load().expect("load").expect("session");
    assert_eq!(loaded.checkout(), Some(&checkout));
}

#[test]
fn yearly_pending_checkout_round_trips_without_changing_the_rollback_readable_envelope() {
    let backend = TestStore::default();
    let store = AccountSessionStore::new(&backend).expect("store");
    let checkout = PendingCheckoutSecret::new(
        "request-year-0001".into(),
        PaidTier::Pro,
        BillingInterval::Year,
    )
    .expect("checkout");
    store
        .save_complete(Some(&checkout_session()), None, None, None, Some(&checkout))
        .expect("save");

    // An older strict build reads this envelope unchanged, so a rollback keeps the session.
    assert_eq!(
        raw_value(&backend, ACCOUNT_SESSION_KEY).as_deref(),
        Some(shipped_checkout_envelope("request-year-0001", "pro").as_str())
    );
    let loaded = store.load().expect("load").expect("session");
    assert!(loaded.session().is_some());
    assert_eq!(loaded.checkout(), Some(&checkout));
    assert_eq!(
        loaded.checkout().expect("checkout").interval(),
        BillingInterval::Year
    );

    store.clear().expect("clear");
    assert!(backend.values.lock().expect("values").is_empty());
}

#[test]
fn yearly_marker_applies_only_to_its_own_checkout_and_never_blocks_the_session() {
    let backend = TestStore::default();
    let store = AccountSessionStore::new(&backend).expect("store");
    let session = checkout_session();
    let yearly = PendingCheckoutSecret::new(
        "request-year-0002".into(),
        PaidTier::Max2x,
        BillingInterval::Year,
    )
    .expect("checkout");
    store
        .save_complete(Some(&session), None, None, None, Some(&yearly))
        .expect("save yearly");

    // A later monthly checkout cannot inherit the earlier yearly marker.
    let monthly = PendingCheckoutSecret::new(
        "request-month-0002".into(),
        PaidTier::Max2x,
        BillingInterval::Month,
    )
    .expect("checkout");
    store
        .save_complete(Some(&session), None, None, None, Some(&monthly))
        .expect("save monthly");
    assert_eq!(
        store
            .load()
            .expect("load")
            .expect("session")
            .checkout()
            .expect("checkout")
            .interval(),
        BillingInterval::Month
    );

    // An unreadable or malformed marker degrades to monthly; the session always survives.
    store
        .save_complete(Some(&session), None, None, None, Some(&yearly))
        .expect("save yearly again");
    *backend.reject_get.lock().expect("reject get") = Some(ACCOUNT_CHECKOUT_INTERVAL_KEY.into());
    let loaded = store.load().expect("load").expect("session");
    assert!(loaded.session().is_some());
    assert_eq!(
        loaded.checkout().expect("checkout").interval(),
        BillingInterval::Month
    );
    *backend.reject_get.lock().expect("reject get") = None;
    backend
        .set(
            &SecretKey::new(ACCOUNT_CHECKOUT_INTERVAL_KEY).expect("key"),
            &SecretString::new("not json"),
        )
        .expect("corrupt marker");
    let loaded = store.load().expect("load").expect("session");
    assert!(loaded.session().is_some());
    assert_eq!(
        loaded.checkout().expect("checkout").interval(),
        BillingInterval::Month
    );

    // A failed marker write fails the save, leaving the previous envelope authoritative.
    *backend.reject_key.lock().expect("reject key") = Some(ACCOUNT_CHECKOUT_INTERVAL_KEY.into());
    let other = PendingCheckoutSecret::new(
        "request-year-0003".into(),
        PaidTier::Max2x,
        BillingInterval::Year,
    )
    .expect("checkout");
    assert!(
        store
            .save_complete(Some(&session), None, None, None, Some(&other))
            .is_err()
    );
    assert_eq!(
        store
            .load()
            .expect("load")
            .expect("session")
            .checkout()
            .expect("checkout")
            .request_id(),
        "request-year-0002"
    );
}
