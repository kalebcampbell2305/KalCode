//! Per-session keys and random identifiers, from the OS CSPRNG.

use std::fmt;

/// A 256-bit per-session key. Redacted in `Debug`; cleared on drop (best effort).
#[derive(Clone, PartialEq, Eq)]
pub struct SessionKey([u8; 32]);

impl SessionKey {
    /// A fresh key from the OS random source.
    pub fn generate() -> std::io::Result<Self> {
        Ok(Self(random_bytes()?))
    }

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    /// Parses the 64-character hex form. Anything else is refused.
    pub fn from_hex(text: &str) -> Option<Self> {
        let text = text.trim();
        if text.len() != 64 {
            return None;
        }
        let mut bytes = [0u8; 32];
        hex::decode_to_slice(text, &mut bytes).ok()?;
        Some(Self(bytes))
    }

    /// The hex form passed to the provider's environment.
    pub fn to_hex(&self) -> String {
        hex::encode(self.0)
    }

    pub(crate) fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for SessionKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SessionKey(redacted)")
    }
}

impl Drop for SessionKey {
    fn drop(&mut self) {
        self.0.fill(0);
        std::hint::black_box(&self.0);
    }
}

/// `N` bytes from the OS random source.
pub fn random_bytes<const N: usize>() -> std::io::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(bytes)
}

/// A random 128-bit identifier as 32 lowercase hex characters.
pub fn random_id() -> std::io::Result<String> {
    Ok(hex::encode(random_bytes::<16>()?))
}

/// Session ids and nonces are lowercase hex of a fixed length.
pub fn is_hex_of_len(text: &str, len: usize) -> bool {
    text.len() == len && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_through_hex_and_are_redacted() {
        let key = SessionKey::generate().expect("key");
        let hex = key.to_hex();
        assert_eq!(hex.len(), 64);
        assert_eq!(SessionKey::from_hex(&hex), Some(key.clone()));
        assert_eq!(format!("{key:?}"), "SessionKey(redacted)");
        assert!(!format!("{key:?}").contains(&hex));
    }

    #[test]
    fn malformed_keys_are_refused() {
        for text in ["", "abc", &"g".repeat(64), &"a".repeat(63), &"a".repeat(66)] {
            assert_eq!(SessionKey::from_hex(text), None, "{text}");
        }
    }

    #[test]
    fn ids_are_random_hex() {
        let a = random_id().expect("id");
        let b = random_id().expect("id");
        assert!(is_hex_of_len(&a, 32));
        assert_ne!(a, b);
        assert!(
            !is_hex_of_len("ABCDEF", 6),
            "uppercase is not the canonical form"
        );
    }
}
