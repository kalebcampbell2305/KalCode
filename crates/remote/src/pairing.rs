//! The pairing window: one at a time, a single-use 32-byte code, 5-minute expiry (§1, §2).

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

use crate::Error;
use crate::noise::StaticKeypair;
use crate::wire::PairingPayload;

/// How long a pairing code is valid.
pub const PAIRING_TTL_SECS: i64 = 5 * 60;

/// Code length in bytes.
pub const CODE_LEN: usize = 32;

/// Unix-seconds clock, injectable for tests.
pub trait Clock: Send + Sync {
    fn now_unix(&self) -> i64;
}

/// The system clock.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_unix(&self) -> i64 {
        crate::unix_now()
    }
}

/// Why a presented code was not accepted. Every variant maps to `pairing_expired` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PairingError {
    #[error("no pairing window is open")]
    NoWindow,
    #[error("the pairing code expired")]
    Expired,
    #[error("the pairing code does not match")]
    Mismatch,
}

/// A freshly opened window: show it as a QR code / link.
#[derive(Clone)]
pub struct PairingTicket {
    /// Standard base64 of the 32-byte code.
    pub code: Zeroizing<String>,
    /// Unix seconds.
    pub expires_at: i64,
}

impl std::fmt::Debug for PairingTicket {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PairingTicket")
            .field("expires_at", &self.expires_at)
            .finish_non_exhaustive()
    }
}

impl PairingTicket {
    /// The §2 payload for this ticket.
    pub fn payload(
        &self,
        workstation_id: &str,
        name: &str,
        host_key: &StaticKeypair,
        addrs: Vec<String>,
    ) -> PairingPayload {
        PairingPayload {
            v: crate::PROTOCOL_VERSION,
            wid: workstation_id.to_owned(),
            name: name.to_owned(),
            pk: host_key.public_base64(),
            code: self.code.as_str().to_owned(),
            addrs,
            exp: self.expires_at,
        }
    }
}

struct Window {
    code: Zeroizing<[u8; CODE_LEN]>,
    expires_at: i64,
}

/// The desktop's pairing state. At most one window is open; opening another replaces it.
pub struct Pairing {
    clock: Arc<dyn Clock>,
    window: Mutex<Option<Window>>,
}

impl Default for Pairing {
    fn default() -> Self {
        Self::new()
    }
}

impl Pairing {
    pub fn new() -> Self {
        Self::with_clock(Arc::new(SystemClock))
    }

    pub fn with_clock(clock: Arc<dyn Clock>) -> Self {
        Self {
            clock,
            window: Mutex::new(None),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Option<Window>> {
        self.window.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Opens a new window with a fresh code, replacing (and invalidating) any open one.
    pub fn open(&self) -> Result<PairingTicket, Error> {
        let mut code = Zeroizing::new([0u8; CODE_LEN]);
        getrandom::fill(code.as_mut_slice()).map_err(|e| Error::Random(e.to_string()))?;
        let expires_at = self.clock.now_unix() + PAIRING_TTL_SECS;
        let ticket = PairingTicket {
            code: Zeroizing::new(STANDARD.encode(code.as_slice())),
            expires_at,
        };
        *self.lock() = Some(Window { code, expires_at });
        Ok(ticket)
    }

    /// Closes the window, if any.
    pub fn close(&self) {
        *self.lock() = None;
    }

    /// Whether an unexpired window is open.
    pub fn is_open(&self) -> bool {
        let now = self.clock.now_unix();
        self.lock().as_ref().is_some_and(|w| now < w.expires_at)
    }

    /// Checks `code` (standard base64) in constant time and burns the window on success.
    pub fn redeem(&self, code: &str) -> Result<(), PairingError> {
        let presented = Zeroizing::new(STANDARD.decode(code.trim()).unwrap_or_default());
        let mut window = self.lock();
        let Some(open) = window.as_ref() else {
            return Err(PairingError::NoWindow);
        };
        if self.clock.now_unix() >= open.expires_at {
            *window = None;
            return Err(PairingError::Expired);
        }
        let matches = presented.len() == CODE_LEN
            && bool::from(presented.as_slice().ct_eq(open.code.as_slice()));
        if !matches {
            return Err(PairingError::Mismatch);
        }
        *window = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]
    use std::sync::atomic::{AtomicI64, Ordering};

    use super::*;

    struct FakeClock(AtomicI64);
    impl Clock for FakeClock {
        fn now_unix(&self) -> i64 {
            self.0.load(Ordering::SeqCst)
        }
    }

    fn setup() -> (Arc<FakeClock>, Pairing) {
        let clock = Arc::new(FakeClock(AtomicI64::new(1_000)));
        let pairing = Pairing::with_clock(clock.clone());
        (clock, pairing)
    }

    #[test]
    fn code_is_single_use() {
        let (_, pairing) = setup();
        let ticket = pairing.open().unwrap();
        assert_eq!(ticket.expires_at, 1_300);
        assert!(pairing.is_open());
        assert_eq!(pairing.redeem(&ticket.code), Ok(()));
        assert_eq!(pairing.redeem(&ticket.code), Err(PairingError::NoWindow));
        assert!(!pairing.is_open());
    }

    #[test]
    fn code_expires_after_five_minutes() {
        let (clock, pairing) = setup();
        let ticket = pairing.open().unwrap();
        clock.0.store(1_299, Ordering::SeqCst);
        assert!(pairing.is_open());
        clock.0.store(1_300, Ordering::SeqCst);
        assert!(!pairing.is_open());
        assert_eq!(pairing.redeem(&ticket.code), Err(PairingError::Expired));
        assert_eq!(pairing.redeem(&ticket.code), Err(PairingError::NoWindow));
    }

    #[test]
    fn wrong_code_does_not_burn_the_window() {
        let (_, pairing) = setup();
        let ticket = pairing.open().unwrap();
        assert_eq!(
            pairing.redeem(&STANDARD.encode([7u8; 32])),
            Err(PairingError::Mismatch)
        );
        assert_eq!(pairing.redeem("garbage"), Err(PairingError::Mismatch));
        assert_eq!(pairing.redeem(""), Err(PairingError::Mismatch));
        assert_eq!(pairing.redeem(&ticket.code), Ok(()));
    }

    #[test]
    fn new_window_replaces_old_code() {
        let (_, pairing) = setup();
        let first = pairing.open().unwrap();
        let second = pairing.open().unwrap();
        assert_ne!(first.code, second.code);
        assert_eq!(pairing.redeem(&first.code), Err(PairingError::Mismatch));
        assert_eq!(pairing.redeem(&second.code), Ok(()));
    }
}
