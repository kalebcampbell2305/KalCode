//! KalCode secret storage.
//!
//! Secrets (provider API keys, OAuth refresh tokens, plugin secrets) are stored only in the
//! operating system's credential store — Windows Credential Manager, macOS Keychain, or the
//! Secret Service on Linux — behind the [`SecretStore`] trait. They never go to SQLite, logs,
//! events, analytics or the UI. Database rows reference a secret by its [`SecretKey`] account.

use std::fmt;

use zeroize::Zeroizing;

/// Keychain service name for every KalCode secret.
pub const SERVICE: &str = "com.kalcode.desktop";

/// A secret value. `Debug` is redacted, there is no `Display`/`Serialize`, and KalCode-owned
/// buffers are zeroized on drop. Zeroization cannot cover copies made outside this type: the
/// `&str`/`String` passed to [`SecretString::new`], or the OS credential store's own buffers.
#[derive(Clone, PartialEq, Eq)]
pub struct SecretString(Zeroizing<String>);

impl SecretString {
    pub fn new(value: impl Into<String>) -> Self {
        Self(Zeroizing::new(value.into()))
    }

    /// Returns the secret. Call sites should be few, obvious, and never log the result.
    pub fn expose_secret(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretString([REDACTED])")
    }
}

/// Identifies one secret. Accounts are restricted to a safe character set so they can be used
/// as opaque references in the database without escaping concerns.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct SecretKey {
    account: String,
}

impl SecretKey {
    /// `account` must be 1–128 chars of `[a-z0-9._:-]`, e.g. `provider:claude-code:personal`.
    pub fn new(account: impl Into<String>) -> Result<Self, SecretStoreError> {
        let account = account.into();
        let valid = !account.is_empty()
            && account.len() <= 128
            && account
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._:-".contains(&b));
        if valid {
            Ok(Self { account })
        } else {
            Err(SecretStoreError::InvalidKey)
        }
    }

    pub fn account(&self) -> &str {
        &self.account
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SecretStoreError {
    #[error("the secret key is invalid")]
    InvalidKey,
    #[error("the system credential store is unavailable: {0}")]
    Unavailable(String),
    #[error("the system credential store rejected the operation: {0}")]
    Access(String),
    #[error("the stored secret could not be read back correctly")]
    Mismatch,
}

pub trait SecretStore: Send + Sync {
    /// Human-readable backend name for diagnostics, e.g. "Windows Credential Manager".
    fn backend(&self) -> &'static str;
    fn set(&self, key: &SecretKey, value: &SecretString) -> Result<(), SecretStoreError>;
    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>, SecretStoreError>;
    /// Returns `true` when a secret existed and was deleted.
    fn delete(&self, key: &SecretKey) -> Result<bool, SecretStoreError>;
}

/// The operating system credential store.
#[derive(Debug, Default)]
pub struct OsSecretStore;

impl OsSecretStore {
    pub fn new() -> Self {
        Self
    }

    fn entry(key: &SecretKey) -> Result<keyring::Entry, SecretStoreError> {
        keyring::Entry::new(SERVICE, key.account()).map_err(map_keyring_error)
    }
}

fn map_keyring_error(error: keyring::Error) -> SecretStoreError {
    match error {
        // No usable store on this system (e.g. no Secret Service daemon on Linux). Note: the
        // keyring crate caches store initialization per process, so this persists until restart.
        keyring::Error::NoDefaultStore => SecretStoreError::Unavailable(error.to_string()),
        // The store exists but refused access (e.g. a locked keychain).
        keyring::Error::NoStorageAccess(_) => SecretStoreError::Access(error.to_string()),
        other => SecretStoreError::Access(other.to_string()),
    }
}

impl SecretStore for OsSecretStore {
    fn backend(&self) -> &'static str {
        if cfg!(target_os = "windows") {
            "Windows Credential Manager"
        } else if cfg!(target_os = "macos") {
            "macOS Keychain"
        } else {
            "Secret Service"
        }
    }

    fn set(&self, key: &SecretKey, value: &SecretString) -> Result<(), SecretStoreError> {
        Self::entry(key)?
            .set_password(value.expose_secret())
            .map_err(map_keyring_error)
    }

    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>, SecretStoreError> {
        match Self::entry(key)?.get_password() {
            Ok(value) => Ok(Some(SecretString::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn delete(&self, key: &SecretKey) -> Result<bool, SecretStoreError> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) => Ok(true),
            Err(keyring::Error::NoEntry) => Ok(false),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

/// In-memory store for tests. Compiled only for tests or with the `test-support` feature.
#[cfg(any(test, feature = "test-support"))]
#[derive(Debug, Default)]
pub struct MemorySecretStore {
    secrets: std::sync::Mutex<std::collections::HashMap<SecretKey, SecretString>>,
}

#[cfg(any(test, feature = "test-support"))]
impl MemorySecretStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(
        &self,
    ) -> Result<
        std::sync::MutexGuard<'_, std::collections::HashMap<SecretKey, SecretString>>,
        SecretStoreError,
    > {
        self.secrets
            .lock()
            .map_err(|_| SecretStoreError::Access("memory store poisoned".into()))
    }
}

#[cfg(any(test, feature = "test-support"))]
impl SecretStore for MemorySecretStore {
    fn backend(&self) -> &'static str {
        "In-memory (test)"
    }

    fn set(&self, key: &SecretKey, value: &SecretString) -> Result<(), SecretStoreError> {
        self.lock()?.insert(key.clone(), value.clone());
        Ok(())
    }

    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>, SecretStoreError> {
        Ok(self.lock()?.get(key).cloned())
    }

    fn delete(&self, key: &SecretKey) -> Result<bool, SecretStoreError> {
        Ok(self.lock()?.remove(key).is_some())
    }
}

/// Account used by [`probe`]. Fixed, so a failed cleanup can leave at most one entry behind.
pub const PROBE_ACCOUNT: &str = "diagnostics:probe";

/// Verifies a store end to end: writes a random probe secret, reads it back, deletes it.
/// The probe value is random and never leaves this function. Callers should not run probes
/// concurrently against the same store (they share [`PROBE_ACCOUNT`]).
pub fn probe(store: &dyn SecretStore) -> Result<(), SecretStoreError> {
    let key = SecretKey::new(PROBE_ACCOUNT)?;
    let value = SecretString::new(uuid::Uuid::new_v4().to_string());
    store.set(&key, &value)?;
    let read = store.get(&key);
    // Always attempt cleanup, even if the read failed.
    let deleted = store.delete(&key);
    let read = read?;
    deleted?;
    match read {
        Some(found) if found == value => Ok(()),
        _ => Err(SecretStoreError::Mismatch),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_debug_is_redacted() {
        let secret = SecretString::new("sk-live-should-never-print");
        let rendered = format!("{secret:?}");
        assert_eq!(rendered, "SecretString([REDACTED])");
        assert!(!rendered.contains("sk-live"));
    }

    #[test]
    fn secret_key_validation() {
        assert!(SecretKey::new("provider:claude-code:personal").is_ok());
        assert!(SecretKey::new("a").is_ok());
        for bad in [
            "",
            "Upper",
            "has space",
            "slash/path",
            "semi;colon",
            &"x".repeat(129),
        ] {
            assert!(SecretKey::new(bad).is_err(), "{bad:?} should be rejected");
        }
    }

    #[test]
    fn memory_store_round_trip() {
        let store = MemorySecretStore::new();
        let key = SecretKey::new("test:key").expect("valid key");
        assert!(store.get(&key).expect("get").is_none());
        store.set(&key, &SecretString::new("value")).expect("set");
        assert_eq!(
            store
                .get(&key)
                .expect("get")
                .map(|s| s.expose_secret().to_owned()),
            Some("value".into())
        );
        assert!(store.delete(&key).expect("delete"));
        assert!(!store.delete(&key).expect("delete twice"));
    }

    #[test]
    fn probe_succeeds_on_memory_store() {
        probe(&MemorySecretStore::new()).expect("probe");
    }

    /// Exercises the real OS credential store. Runs by default on developer machines and CI
    /// runners that have a credential store; set KALCODE_SKIP_OS_KEYCHAIN_TEST=1 to skip
    /// (e.g. headless Linux without a Secret Service daemon).
    #[test]
    fn os_store_round_trip() {
        if std::env::var_os("KALCODE_SKIP_OS_KEYCHAIN_TEST").is_some() {
            return;
        }
        let store = OsSecretStore::new();
        probe(&store).expect("OS credential store probe");
        let key = SecretKey::new(format!(
            "test:os-roundtrip:{}",
            uuid::Uuid::now_v7().simple()
        ))
        .expect("key");
        assert!(store.get(&key).expect("get missing").is_none());
        assert!(!store.delete(&key).expect("delete missing"));
    }
}
