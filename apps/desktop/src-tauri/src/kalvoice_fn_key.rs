//! Permission-free, platform-independent recognition of a standalone Fn hold.
//!
//! Platform adapters report only an Fn transition they can identify exactly, plus another key
//! while Fn is held. The machine delays listening so a tap remains the operating system's, and
//! suppresses chords so the keyboard's Fn layer and the configured fallback key keep working.

use std::time::{Duration, Instant};

pub const HOLD_THRESHOLD: Duration = Duration::from_millis(300);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Idle,
    Pending { pressed: Instant, generation: u64 },
    Suppressed,
    Listening,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    None,
    Arm { generation: u64 },
    Start { pressed: Instant },
    Finish,
    Cancel,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Fallback,
    Function,
}

/// Session ids owned by each physical push-to-talk source. A release may settle only the session
/// its own press started; this prevents an F8 release from ending an Fn take and vice versa.
#[derive(Debug, Default)]
pub struct SessionOwners {
    fallback: Option<String>,
    function: Option<String>,
}

impl SessionOwners {
    pub fn claim(&mut self, source: Source, session_id: String) {
        *self.slot(source) = Some(session_id);
    }

    pub fn take_if_current(&mut self, source: Source, current: Option<&str>) -> Option<String> {
        let owned = self.slot(source).take();
        owned.filter(|session_id| current == Some(session_id.as_str()))
    }

    pub fn clear(&mut self) {
        self.fallback = None;
        self.function = None;
    }

    fn slot(&mut self, source: Source) -> &mut Option<String> {
        match source {
            Source::Fallback => &mut self.fallback,
            Source::Function => &mut self.function,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FnGesture {
    state: State,
    generation: u64,
}

impl Default for FnGesture {
    fn default() -> Self {
        Self {
            state: State::Idle,
            generation: 0,
        }
    }
}

impl FnGesture {
    pub fn down(&mut self, now: Instant, occupied: bool) -> Action {
        if self.state != State::Idle {
            return Action::None;
        }
        if occupied {
            self.state = State::Suppressed;
            return Action::None;
        }
        self.generation = self.generation.wrapping_add(1);
        self.state = State::Pending {
            pressed: now,
            generation: self.generation,
        };
        Action::Arm {
            generation: self.generation,
        }
    }

    pub fn up(&mut self, now: Instant) -> Action {
        let action = match self.state {
            State::Pending { .. } => Action::None,
            State::Listening => Action::Finish,
            State::Idle | State::Suppressed => Action::None,
        };
        self.state = State::Idle;
        let _ = now;
        action
    }

    pub fn other_key(&mut self) -> Action {
        match self.state {
            State::Pending { .. } => {
                self.state = State::Suppressed;
                Action::None
            }
            State::Listening => {
                self.state = State::Suppressed;
                Action::Cancel
            }
            State::Idle | State::Suppressed => Action::None,
        }
    }

    pub fn tick(&mut self, generation: u64) -> Action {
        let State::Pending {
            pressed,
            generation: pending,
        } = self.state
        else {
            return Action::None;
        };
        if generation != pending {
            return Action::None;
        }
        self.state = State::Listening;
        Action::Start { pressed }
    }

    pub fn focus_lost(&mut self) -> Action {
        let action = if self.state == State::Listening {
            Action::Finish
        } else {
            Action::None
        };
        self.state = State::Idle;
        action
    }

    pub fn start_failed_or_blocked(&mut self) {
        self.state = State::Suppressed;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn later(start: Instant, millis: u64) -> Instant {
        start + Duration::from_millis(millis)
    }

    fn arm(gesture: &mut FnGesture, start: Instant) -> u64 {
        match gesture.down(start, false) {
            Action::Arm { generation } => generation,
            action => panic!("expected timer arm, got {action:?}"),
        }
    }

    #[test]
    fn a_tap_never_starts_listening() {
        let start = Instant::now();
        let mut gesture = FnGesture::default();
        let generation = arm(&mut gesture, start);
        assert_eq!(gesture.up(later(start, 100)), Action::None);
        assert_eq!(gesture.tick(generation), Action::None);
    }

    #[test]
    fn a_solo_hold_starts_once_and_release_finishes() {
        let start = Instant::now();
        let mut gesture = FnGesture::default();
        let generation = arm(&mut gesture, start);
        assert_eq!(gesture.tick(generation), Action::Start { pressed: start });
        assert_eq!(gesture.tick(generation), Action::None);
        assert_eq!(gesture.up(later(start, 400)), Action::Finish);
        assert_eq!(gesture.up(later(start, 401)), Action::None);
    }

    #[test]
    fn another_key_before_threshold_suppresses_the_fn_gesture() {
        let start = Instant::now();
        let mut gesture = FnGesture::default();
        let generation = arm(&mut gesture, start);
        assert_eq!(gesture.other_key(), Action::None);
        assert_eq!(gesture.tick(generation), Action::None);
        assert_eq!(gesture.up(later(start, 400)), Action::None);
    }

    #[test]
    fn configured_fallback_press_suppresses_a_pending_fn_timer() {
        let start = Instant::now();
        let mut gesture = FnGesture::default();
        let generation = arm(&mut gesture, start);
        // The native fallback callback reports this directly; it does not depend on a duplicate
        // AppKit or WebView key event arriving first.
        assert_eq!(gesture.other_key(), Action::None);
        assert_eq!(gesture.tick(generation), Action::None);
        assert_eq!(gesture.up(later(start, 400)), Action::None);
    }

    #[test]
    fn another_key_after_listening_cancels_without_finishing() {
        let start = Instant::now();
        let mut gesture = FnGesture::default();
        let generation = arm(&mut gesture, start);
        assert!(matches!(gesture.tick(generation), Action::Start { .. }));
        assert_eq!(gesture.other_key(), Action::Cancel);
        assert_eq!(gesture.up(later(start, 400)), Action::None);
    }

    #[test]
    fn double_taps_are_both_left_to_the_operating_system() {
        let start = Instant::now();
        let mut gesture = FnGesture::default();
        arm(&mut gesture, start);
        assert_eq!(gesture.up(later(start, 50)), Action::None);
        let second = arm(&mut gesture, later(start, 200));
        assert_eq!(gesture.up(later(start, 250)), Action::None);
        assert_eq!(gesture.tick(second), Action::None);
    }

    #[test]
    fn a_hold_after_a_tap_is_not_suppressed() {
        let start = Instant::now();
        let mut gesture = FnGesture::default();
        arm(&mut gesture, start);
        gesture.up(later(start, 50));
        let second = arm(&mut gesture, later(start, 200));
        assert_eq!(
            gesture.tick(second),
            Action::Start {
                pressed: later(start, 200)
            }
        );
    }

    #[test]
    fn focus_loss_finishes_only_an_fn_owned_listen() {
        let start = Instant::now();
        let mut gesture = FnGesture::default();
        assert_eq!(gesture.focus_lost(), Action::None);
        let generation = arm(&mut gesture, start);
        assert!(matches!(gesture.tick(generation), Action::Start { .. }));
        assert_eq!(gesture.focus_lost(), Action::Finish);
        assert_eq!(gesture.focus_lost(), Action::None);
    }

    #[test]
    fn a_failed_start_stays_suppressed_until_release() {
        let start = Instant::now();
        let mut gesture = FnGesture::default();
        let generation = arm(&mut gesture, start);
        assert!(matches!(gesture.tick(generation), Action::Start { .. }));
        gesture.start_failed_or_blocked();
        assert_eq!(gesture.down(later(start, 350), false), Action::None);
        assert_eq!(gesture.up(later(start, 400)), Action::None);
        assert!(matches!(
            gesture.down(later(start, 1_000), false),
            Action::Arm { .. }
        ));
    }

    #[test]
    fn stale_timers_cannot_start_a_later_hold() {
        let start = Instant::now();
        let mut gesture = FnGesture::default();
        let first = arm(&mut gesture, start);
        gesture.up(later(start, 50));
        let second = arm(&mut gesture, later(start, 1_000));
        assert_ne!(first, second);
        assert_eq!(gesture.tick(first), Action::None);
        assert!(matches!(gesture.tick(second), Action::Start { .. }));
    }

    #[test]
    fn repeated_transitions_are_idempotent() {
        let start = Instant::now();
        let mut gesture = FnGesture::default();
        let generation = arm(&mut gesture, start);
        for _ in 0..50 {
            assert_eq!(gesture.down(start, false), Action::None);
        }
        assert!(matches!(gesture.tick(generation), Action::Start { .. }));
        for _ in 0..50 {
            assert_eq!(gesture.tick(generation), Action::None);
        }
        assert_eq!(gesture.up(later(start, 400)), Action::Finish);
        for _ in 0..50 {
            assert_eq!(gesture.up(later(start, 401)), Action::None);
        }
    }

    #[test]
    fn each_source_can_release_only_the_session_its_press_started() {
        let mut owners = SessionOwners::default();
        owners.claim(Source::Function, "fn-session".to_owned());
        assert_eq!(
            owners.take_if_current(Source::Fallback, Some("fn-session")),
            None,
            "an ignored F8 press/release must not finish the active Fn take"
        );
        assert_eq!(
            owners.take_if_current(Source::Function, Some("fn-session")),
            Some("fn-session".to_owned())
        );

        owners.claim(Source::Fallback, "f8-session".to_owned());
        assert_eq!(
            owners.take_if_current(Source::Function, Some("f8-session")),
            None,
            "an ignored Fn press/release must not finish the active F8 take"
        );
        assert_eq!(
            owners.take_if_current(Source::Fallback, Some("f8-session")),
            Some("f8-session".to_owned())
        );
    }

    #[test]
    fn a_stale_owner_never_finishes_a_newer_session() {
        let mut owners = SessionOwners::default();
        owners.claim(Source::Function, "old".to_owned());
        assert_eq!(owners.take_if_current(Source::Function, Some("new")), None);
        assert_eq!(owners.take_if_current(Source::Function, Some("old")), None);
    }

    #[test]
    fn duplicate_down_preserves_its_own_live_capture_but_busy_first_press_is_suppressed() {
        let now = Instant::now();
        let mut gesture = FnGesture::default();
        assert_eq!(gesture.down(now, true), Action::None);
        assert_eq!(gesture.up(now), Action::None);
        let generation = arm(&mut gesture, now);
        assert!(matches!(gesture.tick(generation), Action::Start { .. }));
        assert_eq!(gesture.down(now, true), Action::None);
        assert_eq!(gesture.up(now), Action::Finish);
    }

    #[test]
    fn lifecycle_reset_invalidates_a_pending_hold_even_after_focus_returns() {
        let mut gesture = FnGesture::default();
        let first = arm(&mut gesture, Instant::now());
        assert_eq!(gesture.focus_lost(), Action::None);
        assert_eq!(gesture.tick(first), Action::None);
        let second = arm(&mut gesture, Instant::now());
        assert_eq!(gesture.tick(first), Action::None);
        assert!(matches!(gesture.tick(second), Action::Start { .. }));
    }

    #[test]
    fn fallback_chord_and_existing_session_cannot_leave_a_pending_fn_start() {
        let mut gesture = FnGesture::default();
        let generation = arm(&mut gesture, Instant::now());
        gesture.other_key(); // F8 is pressed and released before the Fn hold timer.
        assert_eq!(gesture.tick(generation), Action::None);
        gesture.up(Instant::now());
        let generation = arm(&mut gesture, Instant::now());
        gesture.start_failed_or_blocked(); // F8 already owns capture at Fn-down.
        assert_eq!(gesture.tick(generation), Action::None);
        assert_eq!(gesture.up(Instant::now()), Action::None);
    }
}
