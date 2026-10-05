//! The returning-user home: the greeting and the summary's pure parts.
//!
//! The greeting names the person only by the display name they set in Settings
//! (`profile.displayName`); the OS account name is never read (ADVANCED.md §14a). With no name it
//! is exactly "Welcome back." With a name it rotates through a fixed, time-of-day-aware pool and
//! never repeats one of the last five shown (history in `settings` under `home.greetingHistory`).

use kalcode_contracts::threads::{ThreadStatus, ThreadSummary};

use crate::rail::{is_working, needs_you};
use crate::types::{RecentWorkItem, RecentWorkKind};

/// How many recent greetings may not repeat.
pub const NO_REPEAT: usize = 5;
/// The greeting with no display name (Z7-08).
pub const WELCOME_BACK: &str = "Welcome back.";
/// The greeting on a first run with no display name.
pub const WELCOME_FIRST: &str = "Welcome to KalCode.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Daypart {
    Any,
    Morning,
    Afternoon,
    Evening,
    Night,
}

/// Local hour (0–23) → part of the day.
pub fn daypart(hour: u8) -> Daypart {
    match hour {
        5..=11 => Daypart::Morning,
        12..=16 => Daypart::Afternoon,
        17..=21 => Daypart::Evening,
        _ => Daypart::Night,
    }
}

/// `(id, template, when)`; `{name}` is replaced by the display name.
pub const POOL: &[(&str, &str, Daypart)] = &[
    ("any-welcome", "Welcome back, {name}.", Daypart::Any),
    ("any-good-to-see", "Good to see you, {name}.", Daypart::Any),
    ("any-ready", "Ready when you are, {name}.", Daypart::Any),
    (
        "any-pick-up",
        "Let's pick up where you left off, {name}.",
        Daypart::Any,
    ),
    (
        "any-workspace-ready",
        "Your workspace is ready, {name}.",
        Daypart::Any,
    ),
    ("any-back-at-it", "Back at it, {name}.", Daypart::Any),
    (
        "any-state-of-play",
        "Here's where things stand, {name}.",
        Daypart::Any,
    ),
    (
        "any-where-you-left",
        "Everything is where you left it, {name}.",
        Daypart::Any,
    ),
    ("morning-good", "Good morning, {name}.", Daypart::Morning),
    (
        "morning-build",
        "Morning, {name}. Let's build.",
        Daypart::Morning,
    ),
    (
        "afternoon-good",
        "Good afternoon, {name}.",
        Daypart::Afternoon,
    ),
    (
        "afternoon-momentum",
        "Afternoon, {name}. Keep the momentum.",
        Daypart::Afternoon,
    ),
    ("evening-good", "Good evening, {name}.", Daypart::Evening),
    (
        "evening-state",
        "Evening, {name}. Here's the state of play.",
        Daypart::Evening,
    ),
    ("night-late", "Working late, {name}?", Daypart::Night),
    (
        "night-quiet",
        "The quiet hours, {name}. Let's make them count.",
        Daypart::Night,
    ),
];

/// Picks a greeting. Returns `(id, text)`; the id is `None` when there is no name (the fixed
/// greeting isn't part of the rotation). `seed` makes the choice deterministic in tests.
pub fn choose(
    hour: u8,
    name: Option<&str>,
    first_run: bool,
    history: &[String],
    seed: u64,
) -> (Option<&'static str>, String) {
    let Some(name) = name.map(str::trim).filter(|n| !n.is_empty()) else {
        return (
            None,
            if first_run {
                WELCOME_FIRST
            } else {
                WELCOME_BACK
            }
            .to_owned(),
        );
    };
    if first_run {
        return (None, format!("Welcome to KalCode, {name}."));
    }
    let part = daypart(hour);
    let recent: Vec<&str> = history
        .iter()
        .rev()
        .take(NO_REPEAT)
        .map(String::as_str)
        .collect();
    let fits = |when: Daypart| when == Daypart::Any || when == part;
    let mut candidates: Vec<&(&str, &str, Daypart)> = POOL
        .iter()
        .filter(|(id, _, when)| fits(*when) && !recent.contains(id))
        .collect();
    if candidates.is_empty() {
        // Unreachable with the pool above (10 fit every part of the day); kept for safety.
        candidates = POOL.iter().filter(|(_, _, when)| fits(*when)).collect();
    }
    let index = usize::try_from(seed % candidates.len() as u64).unwrap_or(0);
    let (id, template, _) = candidates[index];
    (Some(id), template.replace("{name}", name))
}

/// Appends a shown greeting id to the history (keeps the last 10).
pub fn remember(history: &mut Vec<String>, id: &str) {
    history.push(id.to_owned());
    let excess = history.len().saturating_sub(10);
    history.drain(..excess);
}

pub fn thread_item(thread: &ThreadSummary) -> RecentWorkItem {
    RecentWorkItem {
        kind: RecentWorkKind::Thread,
        id: thread.id.clone(),
        title: thread.name.clone(),
        workspace_id: Some(thread.workspace_id.clone()),
        workspace_name: Some(thread.workspace_name.clone()),
        provider_id: Some(thread.provider_id.clone()),
        provider_name: Some(thread.provider_name.clone()),
        status: Some(thread.status),
        last_activity_at: thread.last_activity_at.clone(),
    }
}

/// Threads that can be picked up again: stopped (interrupted) or paused, or failed with a
/// provider session to resume.
pub fn is_resumable(thread: &ThreadSummary) -> bool {
    match thread.status {
        ThreadStatus::Interrupted | ThreadStatus::Paused => true,
        ThreadStatus::Failed => thread.resumable,
        _ => false,
    }
}

/// `(running, needs you, resumable)` from the open threads, most recent first, at most `limit`
/// each.
pub fn live_lists(
    threads: &[ThreadSummary],
    limit: usize,
) -> (
    Vec<RecentWorkItem>,
    Vec<RecentWorkItem>,
    Vec<RecentWorkItem>,
) {
    let mut open: Vec<&ThreadSummary> =
        threads.iter().filter(|t| t.archived_at.is_none()).collect();
    open.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
    let pick = |pred: &dyn Fn(&ThreadSummary) -> bool| {
        open.iter()
            .filter(|t| pred(t))
            .take(limit)
            .map(|t| thread_item(t))
            .collect::<Vec<_>>()
    };
    (
        pick(&|t| is_working(t)),
        pick(&|t| needs_you(t)),
        pick(&is_resumable),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_name_is_exactly_welcome_back() {
        for hour in 0..24 {
            assert_eq!(choose(hour, None, false, &[], 7).1, "Welcome back.");
            assert_eq!(choose(hour, Some("   "), false, &[], 7).1, "Welcome back.");
        }
        assert_eq!(choose(9, None, true, &[], 1).1, "Welcome to KalCode.");
        assert_eq!(choose(9, None, false, &[], 1).0, None);
    }

    #[test]
    fn the_name_comes_from_the_argument_only() {
        let (_, text) = choose(9, Some("Kaleb"), false, &[], 3);
        assert!(text.contains("Kaleb"), "{text}");
        assert_eq!(
            choose(9, Some("Kaleb"), true, &[], 3).1,
            "Welcome to KalCode, Kaleb."
        );
    }

    #[test]
    fn never_repeats_one_of_the_last_five_over_many_visits() {
        for hour in [3u8, 8, 13, 19] {
            let mut history: Vec<String> = Vec::new();
            for visit in 0..200u64 {
                let seed = visit.wrapping_mul(2_654_435_761) ^ 0x9e37;
                let (id, _) = choose(hour, Some("Ada"), false, &history, seed);
                let id = id.expect("rotating greeting");
                let last_five: Vec<&String> = history.iter().rev().take(NO_REPEAT).collect();
                assert!(
                    !last_five.iter().any(|h| h.as_str() == id),
                    "{id} repeated within five at hour {hour}"
                );
                remember(&mut history, id);
            }
        }
    }

    #[test]
    fn greetings_follow_the_time_of_day() {
        let texts: Vec<String> = (0..60u64)
            .map(|seed| choose(8, Some("Ada"), false, &[], seed).1)
            .collect();
        assert!(
            texts
                .iter()
                .all(|t| !t.contains("evening") && !t.contains("late"))
        );
        assert!(
            texts
                .iter()
                .any(|t| t.contains("morning") || t.contains("Morning"))
        );
        let night: Vec<String> = (0..60u64)
            .map(|seed| choose(2, Some("Ada"), false, &[], seed).1)
            .collect();
        assert!(night.iter().all(|t| !t.contains("morning")));
    }

    #[test]
    fn every_part_of_the_day_has_enough_greetings() {
        for hour in 0..24u8 {
            let part = daypart(hour);
            let fitting = POOL
                .iter()
                .filter(|(_, _, when)| *when == Daypart::Any || *when == part)
                .count();
            assert!(fitting > NO_REPEAT, "hour {hour}: {fitting}");
        }
    }
}
