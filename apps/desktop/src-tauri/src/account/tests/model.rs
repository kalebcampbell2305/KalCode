#![allow(dead_code)]

use crate::account;

use std::sync::Mutex;

use account::guard::{CommandAuthorization, authorize_command};
use account::model::{
    AccountAuthority, AccountPhase, AccountSnapshot, PendingAuthSecret, SessionSecret,
};
use account::session_store::{ACCOUNT_SESSION_KEY, AccountSessionStore};
use account::social::SocialProvider;
use kalcode_secure_store::{SecretKey, SecretStore, SecretStoreError, SecretString};

#[derive(Default)]
struct TestSecretStore {
    value: Mutex<Option<SecretString>>,
}

impl SecretStore for TestSecretStore {
    fn backend(&self) -> &'static str {
        "test"
    }

    fn set(&self, _key: &SecretKey, value: &SecretString) -> Result<(), SecretStoreError> {
        *self.value.lock().expect("test store") = Some(value.clone());
        Ok(())
    }

    fn get(&self, _key: &SecretKey) -> Result<Option<SecretString>, SecretStoreError> {
        Ok(self.value.lock().expect("test store").clone())
    }

    fn delete(&self, _key: &SecretKey) -> Result<bool, SecretStoreError> {
        Ok(self.value.lock().expect("test store").take().is_some())
    }
}

fn token(fill: char) -> String {
    format!("kcs_{}", fill.to_string().repeat(43))
}

fn pending() -> PendingAuthSecret {
    PendingAuthSecret::new(
        "a".repeat(43),
        "b".repeat(64),
        1_800_000_000,
        "owner@example.com".into(),
    )
    .expect("valid pending auth")
}

#[test]
fn public_snapshot_serialization_never_contains_native_secrets() {
    let secret = SessionSecret::new(token('A'), 1_800_000_100).expect("valid token");
    let snapshot = AccountSnapshot::signed_out();
    let rendered = format!("{secret:?}");
    let json = serde_json::to_string(&snapshot).expect("serialize snapshot");

    assert_eq!(rendered, "SessionSecret([REDACTED])");
    assert!(!json.contains("kcs_"));
    assert!(!json.contains("codeVerifier"));
    assert!(!json.contains("pollToken"));
}

#[test]
fn secret_shapes_and_expiry_are_validated_before_storage() {
    assert!(SessionSecret::new("not-a-session-token".into(), 1_800_000_100).is_err());
    assert!(
        PendingAuthSecret::new(
            "short".into(),
            "b".repeat(64),
            1_800_000_000,
            "x@y.z".into()
        )
        .is_err()
    );
    assert!(
        PendingAuthSecret::new(
            "a".repeat(43),
            "contains space".into(),
            1_800_000_000,
            "x@y.z".into()
        )
        .is_err()
    );
    assert!(pending().is_expired_at(1_800_000_000));
    assert!(!pending().is_expired_at(1_799_999_999));
}

#[test]
fn durable_session_envelope_round_trips_under_the_fixed_account_key() {
    let backend = TestSecretStore::default();
    let store = AccountSessionStore::new(&backend).expect("session store");
    let session = SessionSecret::new(token('Z'), 1_800_000_100).expect("valid token");

    store.save(Some(&session), Some(&pending())).expect("save");
    let restored = store.load().expect("load").expect("envelope");

    assert_eq!(ACCOUNT_SESSION_KEY, "kalcode-account-session");
    assert_eq!(
        restored.session().expect("session").expose_token(),
        token('Z')
    );
    assert_eq!(
        restored.pending().expect("pending").email(),
        Some("owner@example.com")
    );
    assert!(store.clear().expect("clear"));
    assert!(store.load().expect("load empty").is_none());
}

#[test]
fn command_authorization_is_fail_closed_and_activation_bound() {
    assert_eq!(
        authorize_command("boot", AccountAuthority::Bootstrapping),
        CommandAuthorization::Allowed
    );
    assert_eq!(
        authorize_command("account_email_start", AccountAuthority::SignedOut),
        CommandAuthorization::Allowed
    );
    assert_eq!(
        authorize_command("account_social_start", AccountAuthority::SignedOut),
        CommandAuthorization::Allowed
    );
    assert_eq!(
        authorize_command("workspace_list", AccountAuthority::SignedOut),
        CommandAuthorization::Denied("authentication_required")
    );
    assert_eq!(
        authorize_command("thread_create", AccountAuthority::AuthenticatedUnactivated),
        CommandAuthorization::Denied("account_not_activated")
    );
    assert_eq!(
        authorize_command("brand_new_unclassified_command", AccountAuthority::Active),
        CommandAuthorization::Denied("command_not_authorized")
    );
    assert_eq!(
        authorize_command("thread_create", AccountAuthority::Active),
        CommandAuthorization::Allowed
    );
}

#[test]
fn social_pending_secret_is_strict_and_debug_redacted() {
    let pending = PendingAuthSecret::social(
        SocialProvider::Google,
        "s".repeat(43),
        "v".repeat(64),
        "n".repeat(43),
        1_800_000_000,
    )
    .expect("social pending");
    assert_eq!(pending.social_provider(), Some(SocialProvider::Google));
    assert_eq!(pending.expose_state(), Some("s".repeat(43).as_str()));
    assert_eq!(format!("{pending:?}"), "PendingAuthSecret([REDACTED])");
    assert!(
        PendingAuthSecret::social(
            SocialProvider::Google,
            "short".into(),
            "v".repeat(64),
            "n".repeat(43),
            1_800_000_000,
        )
        .is_err()
    );
}

#[test]
fn snapshots_expose_only_truthful_authority_phases() {
    assert_eq!(AccountSnapshot::signed_out().phase, AccountPhase::SignedOut);
    assert_eq!(
        AccountSnapshot::signed_out().authority(),
        AccountAuthority::SignedOut
    );
    assert_eq!(
        AccountSnapshot::bootstrapping().authority(),
        AccountAuthority::Bootstrapping
    );
}
