#![allow(dead_code)]

use crate::account;

use std::collections::HashMap;
use std::sync::Mutex;

use account::model::{PendingAuthSecret, PublicAccount, SessionSecret};
use account::session_store::{
    ACCOUNT_SESSION_KEY, AccountSessionStore, CachedAccountSecret, SessionStoreError,
    SignedUsageReceipt,
};
use account::social::SocialProvider;
use kalcode_secure_store::{SecretKey, SecretStore, SecretStoreError, SecretString};

#[derive(Default)]
struct TestStore {
    values: Mutex<HashMap<String, SecretString>>,
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
    }
}

#[test]
fn signed_cache_round_trips_only_inside_the_fixed_os_secret_envelope() {
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
    assert_eq!(
        backend
            .values
            .lock()
            .expect("lock")
            .keys()
            .cloned()
            .collect::<Vec<_>>(),
        vec![ACCOUNT_SESSION_KEY]
    );

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
