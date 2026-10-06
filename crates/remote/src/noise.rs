//! Noise IK session setup and the long-term X25519 static keys.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use snow::params::DHChoice;
use snow::resolvers::{CryptoResolver, DefaultResolver};
use snow::{Builder, HandshakeState};
use zeroize::{Zeroize, Zeroizing};

use crate::Error;

/// The Noise protocol name.
pub const PATTERN: &str = "Noise_IK_25519_ChaChaPoly_SHA256";

/// Prologue mixed into every handshake hash.
pub const PROLOGUE: &[u8] = b"kalcode-remote/1";

/// X25519 key length.
pub const KEY_LEN: usize = 32;

/// AEAD tag added to every encrypted Noise payload.
pub const TAG_LEN: usize = 16;

/// A Noise builder for [`PATTERN`] with [`PROLOGUE`] already set. Add keys and build.
pub fn builder<'a>() -> Result<Builder<'a>, Error> {
    Ok(Builder::new(PATTERN.parse()?).prologue(PROLOGUE)?)
}

/// The desktop's handshake state.
pub fn responder(host: &StaticKeypair) -> Result<HandshakeState, Error> {
    Ok(builder()?
        .local_private_key(host.private_bytes())?
        .build_responder()?)
}

/// A device's handshake state, pinned to the workstation's static public key.
pub fn initiator(
    device: &StaticKeypair,
    host_public: &[u8; KEY_LEN],
) -> Result<HandshakeState, Error> {
    Ok(builder()?
        .local_private_key(device.private_bytes())?
        .remote_public_key(host_public)?
        .build_initiator()?)
}

/// A long-term X25519 static keypair. The private half is zeroed on drop and never printed.
#[derive(Clone)]
pub struct StaticKeypair {
    private: Zeroizing<[u8; KEY_LEN]>,
    public: [u8; KEY_LEN],
}

impl StaticKeypair {
    /// A fresh random keypair.
    pub fn generate() -> Result<Self, Error> {
        let mut private = Zeroizing::new([0u8; KEY_LEN]);
        getrandom::fill(private.as_mut_slice()).map_err(|e| Error::Random(e.to_string()))?;
        Self::from_private(*private)
    }

    /// Rebuilds a keypair from its 32-byte private key.
    pub fn from_private(private: [u8; KEY_LEN]) -> Result<Self, Error> {
        let private = Zeroizing::new(private);
        let mut dh = DefaultResolver
            .resolve_dh(&DHChoice::Curve25519)
            .ok_or_else(|| Error::InvalidKey("Curve25519 is unavailable".into()))?;
        dh.set(private.as_slice());
        let public = to_key(dh.pubkey())?;
        // The resolver's copy of the private key: overwrite it before it is dropped.
        let mut scrub = [0u8; KEY_LEN];
        dh.set(&scrub);
        scrub.zeroize();
        Ok(Self { private, public })
    }

    /// Imports a private key stored as standard base64 (the `remote:host-key` format).
    pub fn from_private_base64(encoded: &str) -> Result<Self, Error> {
        let bytes = Zeroizing::new(
            STANDARD
                .decode(encoded.trim())
                .map_err(|e| Error::InvalidKey(e.to_string()))?,
        );
        Self::from_private(to_key(&bytes)?)
    }

    /// The private key as standard base64, for the OS secret store.
    pub fn private_base64(&self) -> Zeroizing<String> {
        Zeroizing::new(STANDARD.encode(self.private.as_slice()))
    }

    pub fn private_bytes(&self) -> &[u8; KEY_LEN] {
        &self.private
    }

    pub fn public(&self) -> &[u8; KEY_LEN] {
        &self.public
    }

    /// The public key as standard base64 (the pairing payload's `pk`).
    pub fn public_base64(&self) -> String {
        STANDARD.encode(self.public)
    }
}

impl std::fmt::Debug for StaticKeypair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StaticKeypair")
            .field("public", &self.public_base64())
            .finish_non_exhaustive()
    }
}

/// Decodes a standard-base64 X25519 public key.
pub fn decode_public_key(encoded: &str) -> Result<[u8; KEY_LEN], Error> {
    let bytes = STANDARD
        .decode(encoded.trim())
        .map_err(|e| Error::InvalidKey(e.to_string()))?;
    to_key(&bytes)
}

/// Encodes a public key as standard base64.
pub fn encode_public_key(key: &[u8; KEY_LEN]) -> String {
    STANDARD.encode(key)
}

pub(crate) fn to_key(bytes: &[u8]) -> Result<[u8; KEY_LEN], Error> {
    <[u8; KEY_LEN]>::try_from(bytes)
        .map_err(|_| Error::InvalidKey(format!("expected {KEY_LEN} bytes, got {}", bytes.len())))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]
    use super::*;

    #[test]
    fn keypair_round_trips_through_base64() {
        let key = StaticKeypair::generate().unwrap();
        let again = StaticKeypair::from_private_base64(&key.private_base64()).unwrap();
        assert_eq!(key.public(), again.public());
        assert_eq!(
            decode_public_key(&key.public_base64()).unwrap(),
            *key.public()
        );
        assert!(!format!("{key:?}").contains(key.private_base64().as_str()));
    }

    #[test]
    fn rejects_wrong_length_keys() {
        assert!(matches!(
            decode_public_key("AAAA"),
            Err(Error::InvalidKey(_))
        ));
        assert!(StaticKeypair::from_private_base64("not base64!").is_err());
    }

    #[test]
    fn public_key_matches_rfc7748_vector() {
        // RFC 7748 §6.1, Alice.
        let private: [u8; 32] =
            hex::decode("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
                .unwrap()
                .try_into()
                .unwrap();
        let key = StaticKeypair::from_private(private).unwrap();
        assert_eq!(
            hex::encode(key.public()),
            "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"
        );
    }
}
