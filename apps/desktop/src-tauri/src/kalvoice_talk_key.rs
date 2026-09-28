//! The push-to-talk key's registration as a small, platform-free reconciler.
//!
//! KalCode holds its talk key (F8 by default, configurable) only while KalCode is the foreground
//! app, so other apps keep the key the rest of the time. Every lifecycle transition (runtime
//! start, foreground change, page load, Settings or preference change, shutdown) calls
//! [`reconcile`] with what it wants now; the reconciler compares that with what this app holds
//! and performs at most one release and one registration. It is idempotent: repeating a call
//! with the same inputs changes nothing, so storms of transitions cannot duplicate or drop the
//! registration.
//!
//! This file is plain `std` Rust with no Tauri types, so the lifecycle rules are unit-tested
//! without a window system.

/// Why the talk key is not wanted right now. Logged as a reason code (no user content).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// Another app is in the foreground.
    NotFocused,
    /// Push to talk is off in Settings.
    Disabled,
    /// KalVoice is stopping (sign-out, account switch, update or exit).
    ShuttingDown,
    /// Preferences could not be read and none were read before.
    PrefsError,
    /// No KalCode page is subscribed to KalVoice signals yet (cold start, page reload), so a
    /// press could not show listening or run anything.
    NotConnected,
}

impl Skip {
    pub const fn code(self) -> &'static str {
        match self {
            Self::NotFocused => "not_focused",
            Self::Disabled => "disabled",
            Self::ShuttingDown => "shutting_down",
            Self::PrefsError => "prefs_error",
            Self::NotConnected => "not_connected",
        }
    }
}

/// The talk-key settings the reconciler needs: whether push to talk is on and the parsed key
/// (`None` when the saved accelerator does not parse).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TalkPrefs<K> {
    pub enabled: bool,
    pub key: Option<K>,
}

/// What the app should hold right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Want<K> {
    /// Hold this key.
    Hold(K),
    /// Push to talk is wanted, but the saved key cannot be registered by the OS.
    Unparseable,
    /// Hold nothing.
    Release(Skip),
}

/// Decides what to hold. `connected` is whether at least one KalCode page is subscribed to
/// KalVoice signals. `prefs` is the latest successfully read preferences (the caller keeps the
/// last good read, so one failed read never drops a working key).
pub fn want<K: Copy>(
    shutting_down: bool,
    foreground: bool,
    connected: bool,
    prefs: Option<TalkPrefs<K>>,
) -> Want<K> {
    if shutting_down {
        return Want::Release(Skip::ShuttingDown);
    }
    let Some(prefs) = prefs else {
        return Want::Release(Skip::PrefsError);
    };
    if !prefs.enabled {
        return Want::Release(Skip::Disabled);
    }
    if !foreground {
        return Want::Release(Skip::NotFocused);
    }
    if !connected {
        return Want::Release(Skip::NotConnected);
    }
    prefs.key.map_or(Want::Unparseable, Want::Hold)
}

/// Why registering a key failed, as reported by the OS layer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterError {
    /// The OS says the key is already registered (by another app, or by this app outside the
    /// reconciler's record).
    InUse,
    /// Any other failure (the OS or the main-thread dispatch).
    Failed,
}

/// The OS registration layer (the global-shortcut plugin in the app; a fake in tests).
pub trait KeyRegistry<K> {
    fn register(&mut self, key: K) -> Result<(), RegisterError>;
    fn unregister(&mut self, key: K) -> Result<(), RegisterError>;
    /// Whether this app currently holds `key` through the same registry.
    fn holds(&self, key: K) -> bool;
}

/// How a wanted key came to be held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Held {
    /// It was already held; nothing was done.
    Unchanged,
    /// It was registered now.
    Registered,
    /// Registration reported "already registered" but this app's registry holds it: adopted as
    /// ours instead of being reported as taken by another app.
    Adopted,
}

/// Why a wanted key is not held.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unavailable {
    Unparseable,
    InUse,
    Failed,
    /// The previously held key could not be released; it stays recorded so the next call
    /// retries, and the new key is not registered on top of it.
    ReleaseFailed,
}

impl Unavailable {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Unparseable => "unparseable",
            Self::InUse => "in_use",
            Self::Failed => "register_failed",
            Self::ReleaseFailed => "release_failed",
        }
    }
}

/// The result of one reconcile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Outcome<K> {
    /// A key released during this call.
    pub released: Option<K>,
    pub result: Status<K>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status<K> {
    Holding(K, Held),
    Idle(Skip),
    Unavailable(Unavailable),
}

/// Brings `held` (the key this app registered, if any) to `want` through `registry`.
pub fn reconcile<K: Copy + Eq, R: KeyRegistry<K>>(
    held: &mut Option<K>,
    want: Want<K>,
    registry: &mut R,
) -> Outcome<K> {
    let mut released = None;
    if let Some(old) = *held {
        if want == Want::Hold(old) && registry.holds(old) {
            return Outcome {
                released: None,
                result: Status::Holding(old, Held::Unchanged),
            };
        }
        if registry.holds(old) {
            if registry.unregister(old).is_err() && registry.holds(old) {
                return Outcome {
                    released: None,
                    result: Status::Unavailable(Unavailable::ReleaseFailed),
                };
            }
            released = Some(old);
        }
        // Either released now or no longer held by the registry: forget it either way.
        *held = None;
    }
    let result = match want {
        Want::Release(skip) => Status::Idle(skip),
        Want::Unparseable => Status::Unavailable(Unavailable::Unparseable),
        Want::Hold(key) => match registry.register(key) {
            Ok(()) => {
                *held = Some(key);
                Status::Holding(key, Held::Registered)
            }
            Err(_) if registry.holds(key) => {
                *held = Some(key);
                Status::Holding(key, Held::Adopted)
            }
            Err(RegisterError::InUse) => Status::Unavailable(Unavailable::InUse),
            Err(RegisterError::Failed) => Status::Unavailable(Unavailable::Failed),
        },
    };
    Outcome { released, result }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    const F8: u32 = 8;
    const F9: u32 = 9;

    /// An OS-like registry: one owner per key, like RegisterHotKey / RegisterEventHotKey.
    #[derive(Default)]
    struct Fake {
        /// Keys this app holds (the plugin's map).
        ours: HashSet<u32>,
        /// Keys another app holds.
        theirs: HashSet<u32>,
        fail_unregister: bool,
        fail_register: bool,
        registrations: usize,
    }

    impl KeyRegistry<u32> for Fake {
        fn register(&mut self, key: u32) -> Result<(), RegisterError> {
            if self.fail_register {
                return Err(RegisterError::Failed);
            }
            if self.ours.contains(&key) || self.theirs.contains(&key) {
                return Err(RegisterError::InUse);
            }
            self.registrations += 1;
            self.ours.insert(key);
            Ok(())
        }
        fn unregister(&mut self, key: u32) -> Result<(), RegisterError> {
            if self.fail_unregister || !self.ours.remove(&key) {
                return Err(RegisterError::Failed);
            }
            Ok(())
        }
        fn holds(&self, key: u32) -> bool {
            self.ours.contains(&key)
        }
    }

    fn prefs(key: u32) -> Option<TalkPrefs<u32>> {
        Some(TalkPrefs {
            enabled: true,
            key: Some(key),
        })
    }

    /// Mirrors the app: each transition recomputes `want` from current facts and reconciles.
    fn step(held: &mut Option<u32>, os: &mut Fake, foreground: bool, key: u32) -> Status<u32> {
        reconcile(held, want(false, foreground, true, prefs(key)), os).result
    }

    #[test]
    fn registers_exactly_once_however_many_transitions_repeat() {
        let (mut held, mut os) = (None, Fake::default());
        for _ in 0..50 {
            step(&mut held, &mut os, true, F8);
        }
        assert_eq!(held, Some(F8));
        assert_eq!(os.registrations, 1);
        assert_eq!(os.ours.len(), 1);
    }

    #[test]
    fn a_runtime_started_while_foreground_holds_the_key_immediately() {
        // 60a17a8 seeded "focused" from the top-level window's own keyboard focus, which is
        // false on Windows while the WebView holds focus, and then waited for a focus event
        // that never came. The foreground fact must be enough on its own.
        let (mut held, mut os) = (None, Fake::default());
        let status = step(&mut held, &mut os, true, F8);
        assert_eq!(status, Status::Holding(F8, Held::Registered));
    }

    #[test]
    fn focus_moving_between_kalcode_views_keeps_one_registration() {
        let (mut held, mut os) = (None, Fake::default());
        step(&mut held, &mut os, true, F8);
        // A child webview or native dialog takes focus: KalCode is still the foreground app.
        for _ in 0..10 {
            assert_eq!(
                step(&mut held, &mut os, true, F8),
                Status::Holding(F8, Held::Unchanged)
            );
        }
        assert_eq!(os.registrations, 1);
    }

    #[test]
    fn another_app_in_front_releases_and_returning_registers_again() {
        let (mut held, mut os) = (None, Fake::default());
        step(&mut held, &mut os, true, F8);
        let away = reconcile(&mut held, want(false, false, true, prefs(F8)), &mut os);
        assert_eq!(away.released, Some(F8));
        assert_eq!(away.result, Status::Idle(Skip::NotFocused));
        assert!(os.ours.is_empty());
        assert_eq!(
            step(&mut held, &mut os, true, F8),
            Status::Holding(F8, Held::Registered)
        );
        assert_eq!(os.ours.len(), 1);
    }

    #[test]
    fn a_failed_release_is_retried_and_never_stacks_a_second_key() {
        let (mut held, mut os) = (None, Fake::default());
        step(&mut held, &mut os, true, F8);
        os.fail_unregister = true;
        let changed = reconcile(&mut held, want(false, true, true, prefs(F9)), &mut os);
        assert_eq!(
            changed.result,
            Status::Unavailable(Unavailable::ReleaseFailed)
        );
        assert_eq!(
            held,
            Some(F8),
            "keep tracking the key that is still registered"
        );
        assert!(!os.ours.contains(&F9));
        os.fail_unregister = false;
        assert_eq!(
            step(&mut held, &mut os, true, F9),
            Status::Holding(F9, Held::Registered)
        );
        assert_eq!(os.ours, HashSet::from([F9]));
    }

    #[test]
    fn a_key_still_held_by_this_app_after_a_lost_record_is_adopted_not_reported_taken() {
        // 60a17a8 forgot the key before unregistering it; a failed unregister then made the next
        // registration fail as "already registered", reported as another app's key, while the
        // OS kept delivering it to a handler that ignored it.
        let (mut held, mut os) = (None, Fake::default());
        os.ours.insert(F8);
        assert_eq!(
            step(&mut held, &mut os, true, F8),
            Status::Holding(F8, Held::Adopted)
        );
        assert_eq!(held, Some(F8));
    }

    #[test]
    fn a_record_the_registry_no_longer_holds_is_registered_again() {
        let (mut held, mut os) = (Some(F8), Fake::default());
        assert_eq!(
            step(&mut held, &mut os, true, F8),
            Status::Holding(F8, Held::Registered)
        );
        assert_eq!(os.registrations, 1);
    }

    #[test]
    fn a_key_another_app_holds_is_reported_in_use() {
        let (mut held, mut os) = (None, Fake::default());
        os.theirs.insert(F8);
        assert_eq!(
            step(&mut held, &mut os, true, F8),
            Status::Unavailable(Unavailable::InUse)
        );
        assert_eq!(held, None);
        // Once the other app lets go, the next transition registers it.
        os.theirs.clear();
        assert_eq!(
            step(&mut held, &mut os, true, F8),
            Status::Holding(F8, Held::Registered)
        );
    }

    #[test]
    fn a_transient_register_failure_recovers_on_the_next_transition() {
        let (mut held, mut os) = (None, Fake::default());
        os.fail_register = true;
        assert_eq!(
            step(&mut held, &mut os, true, F8),
            Status::Unavailable(Unavailable::Failed)
        );
        os.fail_register = false;
        assert_eq!(
            step(&mut held, &mut os, true, F8),
            Status::Holding(F8, Held::Registered)
        );
    }

    #[test]
    fn changing_the_key_moves_the_single_registration() {
        let (mut held, mut os) = (None, Fake::default());
        step(&mut held, &mut os, true, F8);
        let moved = reconcile(&mut held, want(false, true, true, prefs(F9)), &mut os);
        assert_eq!(moved.released, Some(F8));
        assert_eq!(moved.result, Status::Holding(F9, Held::Registered));
        assert_eq!(os.ours, HashSet::from([F9]));
    }

    #[test]
    fn a_press_before_any_page_subscribed_is_never_captured() {
        // Cold launch: KalCode is in front but its page has not subscribed yet. Holding the key
        // then would capture a press whose listening state and result reach no one.
        let (mut held, mut os) = (None, Fake::default());
        let early = reconcile(&mut held, want(false, true, false, prefs(F8)), &mut os);
        assert_eq!(early.result, Status::Idle(Skip::NotConnected));
        assert!(os.ours.is_empty());
        // The page subscribes: the key is registered.
        assert_eq!(
            step(&mut held, &mut os, true, F8),
            Status::Holding(F8, Held::Registered)
        );
        // The page reloads (its subscription is gone): the key is released until it returns.
        let reload = reconcile(&mut held, want(false, true, false, prefs(F8)), &mut os);
        assert_eq!(reload.released, Some(F8));
        assert_eq!(reload.result, Status::Idle(Skip::NotConnected));
        assert!(os.ours.is_empty());
    }

    #[test]
    fn unreadable_preferences_without_a_previous_read_skip_with_a_reason() {
        assert_eq!(
            want::<u32>(false, true, true, None),
            Want::Release(Skip::PrefsError)
        );
    }

    #[test]
    fn disabled_shutting_down_and_unparseable_keys_are_never_registered() {
        let off = Some(TalkPrefs {
            enabled: false,
            key: Some(F8),
        });
        assert_eq!(want(false, true, true, off), Want::Release(Skip::Disabled));
        assert_eq!(
            want(true, true, true, prefs(F8)),
            Want::Release(Skip::ShuttingDown)
        );
        let bad = Some(TalkPrefs::<u32> {
            enabled: true,
            key: None,
        });
        assert_eq!(want(false, true, true, bad), Want::Unparseable);
        assert_eq!(
            want(false, false, true, bad),
            Want::Release(Skip::NotFocused)
        );
    }

    #[test]
    fn shutdown_releases_and_later_transitions_cannot_reregister() {
        let (mut held, mut os) = (None, Fake::default());
        step(&mut held, &mut os, true, F8);
        let stopped = reconcile(&mut held, want(true, true, true, prefs(F8)), &mut os);
        assert_eq!(stopped.released, Some(F8));
        for _ in 0..5 {
            reconcile(&mut held, want(true, true, true, prefs(F8)), &mut os);
        }
        assert!(os.ours.is_empty());
        assert_eq!(held, None);
    }
}
