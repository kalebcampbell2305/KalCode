//! Passive, credential-free provider quota usage per account.
//!
//! Every number here is copied from a file the provider CLI itself wrote into the account's
//! dedicated profile home. KalCode never runs a provider command, never reads a credential file
//! or the OS keychain, never calls the network, and never writes anything to read usage, so this
//! is safe on Windows and macOS, can't refresh or invalidate a sign-in, and can't show a prompt.
//!
//! - **Claude Code** caches the account's plan utilization (`cachedUsageUtilization`: 5-hour and
//!   weekly windows with reset times, plus `fetchedAtMs`) in `.claude.json` inside the account's
//!   `CLAUDE_CONFIG_DIR`. It refreshes that cache itself while a session runs, so usage appears
//!   once an agent has run on the account. `.claude.json` holds no tokens (those live in
//!   `.credentials.json` or the macOS Keychain, which this module never touches). The cache is
//!   used only when its `accountUuid` matches the profile's signed-in `oauthAccount`.
//! - **Codex** records `rate_limits` (primary/secondary windows: `used_percent`,
//!   `window_minutes`, `resets_at`/`resets_in_seconds`, `plan_type`) on `token_count` events in
//!   its session rollouts (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`). The newest such
//!   record for the account's own `CODEX_HOME` is read from the file tail; conversation content
//!   is never parsed or retained.
//! - **Gemini CLI** (and anything else) exposes no plan usage: `unavailable`.
//!
//! A window whose reset time has passed is dropped (the provider hasn't reported the new
//! window yet), so a stale "0% left" never outlives its reset.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::SystemTime;

use kalcode_contracts::agent::{AuthState, ProviderId};
use kalcode_contracts::provider_accounts::{
    ProviderAccount, ProviderAccountUsage, ProviderUsageStatus, ProviderUsageWindow,
};
use kalcode_core::time::format_rfc3339;
use serde_json::Value;
use time::format_description::well_known::Rfc3339;
use time::{Duration, OffsetDateTime};

use crate::managed::ManagedProfiles;

/// `.claude.json` is normally ~60 KiB; anything far larger is not something to parse on a timer.
const MAX_CLAUDE_STATE_BYTES: u64 = 16 * 1024 * 1024;
/// Rollout tail scanned for the newest `token_count` record (one is written per turn).
const ROLLOUT_TAIL_BYTES: u64 = 4 * 1024 * 1024;
/// Rate-limit windows are at most a week long; older rollouts can't describe a live window.
const ROLLOUT_LOOKBACK_DAYS: i64 = 8;
/// Newest rollouts inspected per read (a turn in any of them carries the account's limits).
const ROLLOUT_FILES_SCANNED: usize = 6;

const FIRST_RUN: &str = "Usage appears after the first agent run";
const SIGNED_OUT: &str = "Signed out";
const RESET_SINCE_READ: &str = "Usage reset since the last agent run";
const UNREADABLE: &str = "Usage couldn't be read";

/// Reads one account's usage. Never fails: anything unreadable becomes `not_checked`.
pub fn read_account_usage(
    profiles: &ManagedProfiles,
    account: &ProviderAccount,
    now: OffsetDateTime,
) -> ProviderAccountUsage {
    let provider = account.provider_id.as_str();
    if provider != ProviderId::CLAUDE_CODE && provider != ProviderId::CODEX {
        return outcome(
            account,
            ProviderUsageStatus::Unavailable,
            Some("This provider doesn't report plan usage"),
        );
    }
    if account.authentication_state == AuthState::NotAuthenticated {
        return outcome(account, ProviderUsageStatus::NotChecked, Some(SIGNED_OUT));
    }
    let home = match profiles.existing_profile_home(provider, &account.id) {
        Ok(Some(home)) => home,
        Ok(None) => return outcome(account, ProviderUsageStatus::NotChecked, Some(FIRST_RUN)),
        Err(_) => return outcome(account, ProviderUsageStatus::NotChecked, Some(UNREADABLE)),
    };
    let reading = if provider == ProviderId::CLAUDE_CODE {
        read_claude(&home)
    } else {
        read_codex(&home, now)
    };
    usage_from_reading(account, reading, now)
}

fn outcome(
    account: &ProviderAccount,
    status: ProviderUsageStatus,
    reason: Option<&str>,
) -> ProviderAccountUsage {
    ProviderAccountUsage {
        account_id: account.id.clone(),
        status,
        plan: None,
        windows: Vec::new(),
        checked_at: None,
        reason: reason.map(str::to_owned),
    }
}

/// One provider-recorded snapshot before the reset/remaining rules are applied.
#[derive(Debug, Clone, PartialEq)]
struct Reading {
    plan: Option<String>,
    checked_at: OffsetDateTime,
    windows: Vec<RawWindow>,
}

#[derive(Debug, Clone, PartialEq)]
struct RawWindow {
    id: String,
    label: String,
    used_percent: f64,
    resets_at: Option<OffsetDateTime>,
    window_minutes: Option<i64>,
}

fn usage_from_reading(
    account: &ProviderAccount,
    reading: Result<Option<Reading>, ()>,
    now: OffsetDateTime,
) -> ProviderAccountUsage {
    let reading = match reading {
        Ok(Some(reading)) => reading,
        Ok(None) => return outcome(account, ProviderUsageStatus::NotChecked, Some(FIRST_RUN)),
        Err(()) => return outcome(account, ProviderUsageStatus::NotChecked, Some(UNREADABLE)),
    };
    let mut windows: Vec<ProviderUsageWindow> = reading
        .windows
        .into_iter()
        .filter(|window| match window.resets_at {
            Some(resets_at) => resets_at > now,
            // Without a reset time, the reading can only describe a window it still falls in.
            None => window
                .window_minutes
                .is_some_and(|minutes| reading.checked_at + Duration::minutes(minutes) > now),
        })
        .map(|window| ProviderUsageWindow {
            id: window.id,
            label: window.label,
            remaining_percent: (100.0 - window.used_percent).clamp(0.0, 100.0),
            resets_at: window.resets_at.map(format_rfc3339),
        })
        .collect();
    windows.sort_by(|left, right| left.remaining_percent.total_cmp(&right.remaining_percent));
    if windows.is_empty() {
        let mut usage = outcome(
            account,
            ProviderUsageStatus::NotChecked,
            Some(RESET_SINCE_READ),
        );
        usage.plan = reading.plan;
        return usage;
    }
    ProviderAccountUsage {
        account_id: account.id.clone(),
        status: ProviderUsageStatus::Available,
        plan: reading.plan,
        windows,
        checked_at: Some(format_rfc3339(reading.checked_at)),
        reason: None,
    }
}

// --- Per-file cache -----------------------------------------------------------------------

type FileKey = (SystemTime, u64);
type ReadingCache = HashMap<PathBuf, (FileKey, Option<Reading>)>;

/// Parsed readings keyed by file path and (modified, length), so a timer refresh re-parses a
/// file only after the provider rewrote it.
fn cached(
    path: &Path,
    parse: impl FnOnce(&Path) -> Result<Option<Reading>, ()>,
) -> Result<Option<Reading>, ()> {
    static CACHE: OnceLock<Mutex<ReadingCache>> = OnceLock::new();
    let metadata = std::fs::metadata(path).map_err(|_| ())?;
    let key = (
        metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        metadata.len(),
    );
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((cached_key, reading)) = cache
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(path)
        && *cached_key == key
    {
        return Ok(reading.clone());
    }
    // A provider mid-write can leave a torn file; that read fails and is not cached.
    let reading = parse(path)?;
    let mut cache = cache.lock().unwrap_or_else(PoisonError::into_inner);
    if cache.len() > 256 {
        cache.clear();
    }
    cache.insert(path.to_path_buf(), (key, reading.clone()));
    Ok(reading)
}

// --- Claude Code ----------------------------------------------------------------------------

fn read_claude(home: &Path) -> Result<Option<Reading>, ()> {
    let path = home.join(".claude.json");
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.is_file() && metadata.len() <= MAX_CLAUDE_STATE_BYTES => {}
        Ok(_) => return Err(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    }
    cached(&path, |path| {
        let text = std::fs::read_to_string(path).map_err(|_| ())?;
        let state: Value = serde_json::from_str(&text).map_err(|_| ())?;
        Ok(parse_claude_state(&state))
    })
}

fn parse_claude_state(state: &Value) -> Option<Reading> {
    // No signed-in account in this profile means the cache can't be attributed to it.
    let account = state.get("oauthAccount")?.as_object()?;
    let cache = state.get("cachedUsageUtilization")?;
    if let (Some(expected), Some(cached_for)) = (
        account.get("accountUuid").and_then(Value::as_str),
        cache.get("accountUuid").and_then(Value::as_str),
    ) && expected != cached_for
    {
        return None;
    }
    let fetched_ms = cache.get("fetchedAtMs").and_then(Value::as_i64)?;
    let checked_at =
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(fetched_ms) * 1_000_000).ok()?;
    let utilization = cache.get("utilization")?;
    let mut windows = Vec::new();
    for (key, id, label, minutes) in [
        ("five_hour", "five_hour", "5-hour", Some(300)),
        ("seven_day", "weekly", "Weekly", Some(10_080)),
        ("seven_day_opus", "weekly_opus", "Weekly Opus", Some(10_080)),
        (
            "seven_day_sonnet",
            "weekly_sonnet",
            "Weekly Sonnet",
            Some(10_080),
        ),
    ] {
        let Some(window) = utilization.get(key).filter(|window| window.is_object()) else {
            continue;
        };
        let Some(used) = window.get("utilization").and_then(Value::as_f64) else {
            continue;
        };
        windows.push(RawWindow {
            id: id.to_owned(),
            label: label.to_owned(),
            used_percent: used,
            resets_at: rfc3339(window.get("resets_at")),
            window_minutes: minutes,
        });
    }
    // Newer Claude Code versions also list every limit, including model-scoped weekly limits.
    for limit in utilization
        .get("limits")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(used) = limit.get("percent").and_then(Value::as_f64) else {
            continue;
        };
        let (id, label) = match limit.get("kind").and_then(Value::as_str) {
            Some("session") => ("five_hour".to_owned(), "5-hour".to_owned()),
            Some("weekly_all") => ("weekly".to_owned(), "Weekly".to_owned()),
            Some("weekly_scoped") => {
                let Some(model) = limit
                    .pointer("/scope/model/display_name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|model| !model.is_empty() && model.chars().count() <= 40)
                else {
                    continue;
                };
                (format!("weekly_{}", slug(model)), format!("Weekly {model}"))
            }
            _ => continue,
        };
        if windows.iter().any(|window| window.id == id) {
            continue;
        }
        let minutes = if id == "five_hour" { 300 } else { 10_080 };
        windows.push(RawWindow {
            id,
            label,
            used_percent: used,
            resets_at: rfc3339(limit.get("resets_at")),
            window_minutes: Some(minutes),
        });
    }
    if windows.is_empty() {
        return None;
    }
    let tier = account
        .get("organizationRateLimitTier")
        .and_then(Value::as_str)
        .or_else(|| account.get("userRateLimitTier").and_then(Value::as_str));
    Some(Reading {
        plan: tier.and_then(claude_plan),
        checked_at,
        windows,
    })
}

/// Only rate-limit tiers whose meaning is unambiguous become a plan label.
fn claude_plan(tier: &str) -> Option<String> {
    let tier = tier.to_ascii_lowercase();
    let plan = if tier.contains("max_20x") {
        "Max 20x"
    } else if tier.contains("max_5x") {
        "Max 5x"
    } else if tier.ends_with("_max") || tier.contains("_max_") {
        "Max"
    } else if tier.ends_with("_pro") {
        "Pro"
    } else {
        return None;
    };
    Some(plan.to_owned())
}

fn slug(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

fn rfc3339(value: Option<&Value>) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value?.as_str()?, &Rfc3339).ok()
}

// --- Codex ----------------------------------------------------------------------------------

fn read_codex(home: &Path, now: OffsetDateTime) -> Result<Option<Reading>, ()> {
    let mut rollouts = recent_rollouts(&home.join("sessions"), now);
    rollouts.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (_, path) in rollouts.into_iter().take(ROLLOUT_FILES_SCANNED) {
        // An unreadable or torn rollout doesn't hide an older readable one.
        if let Ok(Some(reading)) = cached(&path, parse_rollout_tail) {
            return Ok(Some(reading));
        }
    }
    Ok(None)
}

/// Rollout files from the last [`ROLLOUT_LOOKBACK_DAYS`] day directories, with their mtimes.
fn recent_rollouts(sessions: &Path, now: OffsetDateTime) -> Vec<(SystemTime, PathBuf)> {
    let oldest = now.date() - Duration::days(ROLLOUT_LOOKBACK_DAYS);
    let mut found = Vec::new();
    for (year, year_path) in numbered_dirs(sessions) {
        for (month, month_path) in numbered_dirs(&year_path) {
            for (day, day_path) in numbered_dirs(&month_path) {
                let Ok(month) = time::Month::try_from(u8::try_from(month).unwrap_or(0)) else {
                    continue;
                };
                let Ok(date) = time::Date::from_calendar_date(
                    i32::try_from(year).unwrap_or(0),
                    month,
                    u8::try_from(day).unwrap_or(0),
                ) else {
                    continue;
                };
                if date < oldest {
                    continue;
                }
                let Ok(entries) = std::fs::read_dir(&day_path) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let Some(name) = name.to_str() else { continue };
                    if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                        continue;
                    }
                    let Ok(metadata) = entry.metadata() else {
                        continue;
                    };
                    if metadata.is_file() {
                        let modified = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                        found.push((modified, entry.path()));
                    }
                }
            }
        }
    }
    found
}

fn numbered_dirs(path: &Path) -> Vec<(u32, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(path) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .filter_map(|entry| {
            let number = entry.file_name().to_str()?.parse::<u32>().ok()?;
            Some((number, entry.path()))
        })
        .collect()
}

fn parse_rollout_tail(path: &Path) -> Result<Option<Reading>, ()> {
    let mut file = File::open(path).map_err(|_| ())?;
    let length = file.metadata().map_err(|_| ())?.len();
    let start = length.saturating_sub(ROLLOUT_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).map_err(|_| ())?;
    let mut bytes = Vec::new();
    file.take(ROLLOUT_TAIL_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(newest_rate_limits(&text))
}

/// The newest `token_count` record carrying Codex rate limits, scanning lines from the end.
fn newest_rate_limits(text: &str) -> Option<Reading> {
    text.lines()
        .rev()
        // Cheap prefilter: only token_count lines are parsed; conversation lines are skipped.
        .filter(|line| line.contains("\"token_count\"") && line.contains("\"rate_limits\""))
        .find_map(|line| {
            let event: Value = serde_json::from_str(line).ok()?;
            codex_reading(&event)
        })
}

fn codex_reading(event: &Value) -> Option<Reading> {
    let payload = event.get("payload")?;
    if payload.get("type").and_then(Value::as_str) != Some("token_count") {
        return None;
    }
    let limits = payload.get("rate_limits")?.as_object()?;
    // Codex can report additional, separately-metered limits; the account's plan limit is
    // `codex` (older versions omit the id).
    if let Some(limit_id) = limits.get("limit_id").and_then(Value::as_str)
        && limit_id != "codex"
    {
        return None;
    }
    let checked_at = rfc3339(event.get("timestamp"))?;
    let mut windows = Vec::new();
    for slot in ["primary", "secondary"] {
        let Some(window) = limits.get(slot).filter(|window| window.is_object()) else {
            continue;
        };
        let Some(used) = window.get("used_percent").and_then(Value::as_f64) else {
            continue;
        };
        let minutes = window.get("window_minutes").and_then(Value::as_i64);
        let resets_at = window
            .get("resets_at")
            .and_then(Value::as_i64)
            .and_then(|seconds| OffsetDateTime::from_unix_timestamp(seconds).ok())
            .or_else(|| {
                window
                    .get("resets_in_seconds")
                    .and_then(Value::as_i64)
                    .map(|seconds| checked_at + Duration::seconds(seconds))
            });
        let (mut id, label) = codex_window_name(slot, minutes);
        if windows.iter().any(|existing: &RawWindow| existing.id == id) {
            id = slot.to_owned();
        }
        windows.push(RawWindow {
            id,
            label,
            used_percent: used,
            resets_at,
            window_minutes: minutes,
        });
    }
    if windows.is_empty() {
        return None;
    }
    let plan = limits
        .get("plan_type")
        .and_then(Value::as_str)
        .and_then(codex_plan);
    Some(Reading {
        plan,
        checked_at,
        windows,
    })
}

fn codex_window_name(slot: &str, minutes: Option<i64>) -> (String, String) {
    match minutes {
        Some(300) => ("five_hour".to_owned(), "5-hour".to_owned()),
        Some(10_080) => ("weekly".to_owned(), "Weekly".to_owned()),
        Some(minutes) if minutes > 0 && minutes % 1440 == 0 => {
            (slot.to_owned(), format!("{}-day", minutes / 1440))
        }
        Some(minutes) if minutes > 0 && minutes % 60 == 0 => {
            (slot.to_owned(), format!("{}-hour", minutes / 60))
        }
        Some(minutes) if minutes > 0 => (slot.to_owned(), format!("{minutes}-minute")),
        _ => (
            slot.to_owned(),
            if slot == "primary" {
                "Primary".to_owned()
            } else {
                "Secondary".to_owned()
            },
        ),
    }
}

fn codex_plan(plan: &str) -> Option<String> {
    let label = match plan.to_ascii_lowercase().as_str() {
        "free" => "Free",
        "plus" => "Plus",
        "pro" => "Pro",
        "team" => "Team",
        "business" => "Business",
        "enterprise" => "Enterprise",
        "edu" => "Edu",
        _ => return None,
    };
    Some(label.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    const CLAUDE_ID: &str = "0192f3c4-0000-7000-8000-000000000101";
    const CODEX_ID: &str = "0192f3c4-0000-7000-8000-000000000201";
    const GEMINI_ID: &str = "0192f3c4-0000-7000-8000-000000000301";
    const NOW: OffsetDateTime = datetime!(2026-10-03 17:45 UTC);

    fn account(id: &str, provider: &str, auth: AuthState) -> ProviderAccount {
        ProviderAccount {
            id: id.to_owned(),
            provider_id: ProviderId::new(provider),
            display_name: "A".to_owned(),
            provider_reported_identity: None,
            authentication_state: auth,
            is_default: true,
            created_at: "2026-09-24T12:00:00.000Z".to_owned(),
            last_used_at: None,
            last_checked_at: None,
            last_error_code: None,
            archived_at: None,
        }
    }

    fn profiles() -> (tempfile::TempDir, ManagedProfiles) {
        let temp = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir: {error}"));
        // macOS temp lives under the /var -> /private/var link, which managed profiles refuse.
        let root = if cfg!(target_os = "macos") {
            temp.path()
                .canonicalize()
                .unwrap_or_else(|error| panic!("canonical temp: {error}"))
        } else {
            temp.path().to_path_buf()
        };
        let profiles = ManagedProfiles::for_data_dir(&root)
            .unwrap_or_else(|error| panic!("profiles: {error}"));
        (temp, profiles)
    }

    fn write(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap_or_else(|error| panic!("mkdir: {error}"));
        }
        std::fs::write(path, text).unwrap_or_else(|error| panic!("write: {error}"));
    }

    fn home(profiles: &ManagedProfiles, provider: &str, id: &str) -> PathBuf {
        profiles
            .profile_home(provider, id)
            .unwrap_or_else(|error| panic!("home: {error}"))
    }

    /// Trimmed from a real Claude Code 2.1 `.claude.json` (identity values replaced).
    const CLAUDE_STATE: &str = r#"{
      "numStartups": 4,
      "oauthAccount": {
        "accountUuid": "acct-1",
        "emailAddress": "person@example.com",
        "organizationRateLimitTier": "default_claude_max_20x",
        "userRateLimitTier": null
      },
      "cachedUsageUtilization": {
        "fetchedAtMs": 1791040277025,
        "accountUuid": "acct-1",
        "utilization": {
          "five_hour": { "utilization": 36, "resets_at": "2026-10-03T19:59:59.591612+00:00",
                         "limit_dollars": null, "used_dollars": null },
          "seven_day": { "utilization": 58, "resets_at": "2026-10-10T07:59:59.591633+00:00" },
          "seven_day_opus": null,
          "seven_day_sonnet": null,
          "extra_usage": { "is_enabled": false },
          "limits": [
            { "kind": "session", "group": "session", "percent": 36, "severity": "normal",
              "resets_at": "2026-10-03T19:59:59.591612+00:00", "scope": null, "is_active": false },
            { "kind": "weekly_all", "group": "weekly", "percent": 58, "severity": "normal",
              "resets_at": "2026-10-10T07:59:59.591633+00:00", "scope": null, "is_active": true },
            { "kind": "weekly_scoped", "group": "weekly", "percent": 0, "severity": "normal",
              "resets_at": "2026-10-10T08:00:00+00:00",
              "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null },
              "is_active": false }
          ]
        }
      }
    }"#;

    #[test]
    fn claude_reads_cached_utilization_most_constrained_first() {
        let (_temp, profiles) = profiles();
        write(
            &home(&profiles, "claude-code", CLAUDE_ID).join(".claude.json"),
            CLAUDE_STATE,
        );
        let usage = read_account_usage(
            &profiles,
            &account(CLAUDE_ID, "claude-code", AuthState::Authenticated),
            NOW,
        );
        assert_eq!(usage.status, ProviderUsageStatus::Available);
        assert_eq!(usage.plan.as_deref(), Some("Max 20x"));
        assert_eq!(
            usage.checked_at.as_deref(),
            Some("2026-10-03T15:11:17.025Z")
        );
        let windows: Vec<_> = usage
            .windows
            .iter()
            .map(|window| {
                (
                    window.id.as_str(),
                    window.label.as_str(),
                    window.remaining_percent,
                )
            })
            .collect();
        assert_eq!(
            windows,
            vec![
                ("weekly", "Weekly", 42.0),
                ("five_hour", "5-hour", 64.0),
                ("weekly_fable", "Weekly Fable", 100.0),
            ]
        );
        assert_eq!(
            usage.windows[1].resets_at.as_deref(),
            Some("2026-10-03T19:59:59.591Z")
        );
        assert_eq!(usage.reason, None);
    }

    #[test]
    fn claude_cache_for_another_signed_in_account_is_ignored() {
        let (_temp, profiles) = profiles();
        let state = CLAUDE_STATE.replacen(
            "\"accountUuid\": \"acct-1\"",
            "\"accountUuid\": \"acct-2\"",
            1,
        );
        write(
            &home(&profiles, "claude-code", CLAUDE_ID).join(".claude.json"),
            &state,
        );
        let usage = read_account_usage(
            &profiles,
            &account(CLAUDE_ID, "claude-code", AuthState::Authenticated),
            NOW,
        );
        assert_eq!(usage.status, ProviderUsageStatus::NotChecked);
        assert_eq!(usage.reason.as_deref(), Some(FIRST_RUN));
        assert!(usage.windows.is_empty());
    }

    #[test]
    fn claude_without_cache_or_profile_is_not_checked_and_creates_nothing() {
        let (temp, profiles) = profiles();
        let usage = read_account_usage(
            &profiles,
            &account(CLAUDE_ID, "claude-code", AuthState::Authenticated),
            NOW,
        );
        assert_eq!(usage.status, ProviderUsageStatus::NotChecked);
        assert_eq!(usage.reason.as_deref(), Some(FIRST_RUN));
        assert!(!temp.path().join("provider-profiles/providers").exists());

        write(
            &home(&profiles, "claude-code", CLAUDE_ID).join(".claude.json"),
            r#"{"oauthAccount":{"accountUuid":"acct-1"}}"#,
        );
        let usage = read_account_usage(
            &profiles,
            &account(CLAUDE_ID, "claude-code", AuthState::Authenticated),
            NOW,
        );
        assert_eq!(usage.status, ProviderUsageStatus::NotChecked);
    }

    #[test]
    fn torn_claude_state_is_not_checked_not_invented() {
        let (_temp, profiles) = profiles();
        write(
            &home(&profiles, "claude-code", CLAUDE_ID).join(".claude.json"),
            &CLAUDE_STATE[..200],
        );
        let usage = read_account_usage(
            &profiles,
            &account(CLAUDE_ID, "claude-code", AuthState::Authenticated),
            NOW,
        );
        assert_eq!(usage.status, ProviderUsageStatus::NotChecked);
        assert_eq!(usage.reason.as_deref(), Some(UNREADABLE));
    }

    #[test]
    fn windows_past_their_reset_are_dropped() {
        let (_temp, profiles) = profiles();
        write(
            &home(&profiles, "claude-code", CLAUDE_ID).join(".claude.json"),
            CLAUDE_STATE,
        );
        let claude = account(CLAUDE_ID, "claude-code", AuthState::Authenticated);
        let usage = read_account_usage(&profiles, &claude, datetime!(2026-10-04 00:00 UTC));
        assert_eq!(
            usage
                .windows
                .iter()
                .map(|window| window.id.as_str())
                .collect::<Vec<_>>(),
            vec!["weekly", "weekly_fable"]
        );
        let usage = read_account_usage(&profiles, &claude, datetime!(2026-10-11 00:00 UTC));
        assert_eq!(usage.status, ProviderUsageStatus::NotChecked);
        assert_eq!(usage.reason.as_deref(), Some(RESET_SINCE_READ));
        assert_eq!(usage.plan.as_deref(), Some("Max 20x"));
    }

    fn token_count(timestamp: &str, limits: &str) -> String {
        format!(
            r#"{{"timestamp":"{timestamp}","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":10}}}},"rate_limits":{limits}}}}}"#
        )
    }

    #[test]
    fn codex_reads_the_newest_rate_limits_from_recent_rollouts() {
        let (_temp, profiles) = profiles();
        let sessions = home(&profiles, "codex", CODEX_ID).join("sessions");
        // Real 0.16x shape: one weekly primary window, credits, plan.
        let weekly = r#"{"limit_id":"codex","limit_name":null,"primary":{"used_percent":44.0,"window_minutes":10080,"resets_at":1791337663},"secondary":null,"credits":{"has_credits":true,"unlimited":false,"balance":"10.0"},"plan_type":"pro","rate_limit_reached_type":null}"#;
        let older = r#"{"limit_id":"codex","primary":{"used_percent":12.0,"window_minutes":10080,"resets_at":1791337663},"secondary":null,"plan_type":"pro"}"#;
        let rollout = [
            r#"{"timestamp":"2026-10-03T10:00:00.000Z","type":"session_meta","payload":{"id":"x"}}"#.to_owned(),
            token_count("2026-10-03T10:01:00.000Z", older),
            r#"{"timestamp":"2026-10-03T10:02:00.000Z","type":"response_item","payload":{"type":"message","content":"rate_limits token_count"}}"#.to_owned(),
            token_count("2026-10-03T10:03:00.000Z", weekly),
            token_count("2026-10-03T10:04:00.000Z", "null"),
            // A separately-metered limit is not the account's plan window.
            token_count(
                "2026-10-03T10:05:00.000Z",
                r#"{"limit_id":"other","primary":{"used_percent":99.0,"window_minutes":300,"resets_at":1791337663}}"#,
            ),
        ]
        .join("\n");
        write(
            &sessions.join("2026/10/03/rollout-2026-10-03T10-00-00-a.jsonl"),
            &rollout,
        );
        // Outside the lookback window: never read.
        write(
            &sessions.join("2026/09/01/rollout-2026-09-01T10-00-00-b.jsonl"),
            &token_count("2026-10-03T11:00:00.000Z", older),
        );
        let usage = read_account_usage(
            &profiles,
            &account(CODEX_ID, "codex", AuthState::Authenticated),
            NOW,
        );
        assert_eq!(usage.status, ProviderUsageStatus::Available);
        assert_eq!(usage.plan.as_deref(), Some("Pro"));
        assert_eq!(
            usage.checked_at.as_deref(),
            Some("2026-10-03T10:03:00.000Z")
        );
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].id, "weekly");
        assert_eq!(usage.windows[0].label, "Weekly");
        assert_eq!(usage.windows[0].remaining_percent, 56.0);
        assert_eq!(
            usage.windows[0].resets_at.as_deref(),
            Some("2026-10-07T01:47:43.000Z")
        );
    }

    #[test]
    fn codex_legacy_relative_resets_and_two_windows() {
        let event = token_count(
            "2026-10-03T17:00:00.000Z",
            r#"{"primary":{"used_percent":92.5,"window_minutes":300,"resets_in_seconds":3600},"secondary":{"used_percent":30.0,"window_minutes":10080,"resets_in_seconds":86400}}"#,
        );
        let reading = newest_rate_limits(&event).unwrap_or_else(|| panic!("reading"));
        assert_eq!(reading.plan, None);
        assert_eq!(
            reading.windows[0].resets_at,
            Some(datetime!(2026-10-03 18:00 UTC))
        );
        let usage = usage_from_reading(
            &account(CODEX_ID, "codex", AuthState::Authenticated),
            Ok(Some(reading)),
            NOW,
        );
        let windows: Vec<_> = usage
            .windows
            .iter()
            .map(|window| (window.id.as_str(), window.remaining_percent))
            .collect();
        assert_eq!(windows, vec![("five_hour", 7.5), ("weekly", 70.0)]);
    }

    #[test]
    fn codex_without_rollouts_is_not_checked() {
        let (_temp, profiles) = profiles();
        home(&profiles, "codex", CODEX_ID);
        let usage = read_account_usage(
            &profiles,
            &account(CODEX_ID, "codex", AuthState::Authenticated),
            NOW,
        );
        assert_eq!(usage.status, ProviderUsageStatus::NotChecked);
        assert_eq!(usage.reason.as_deref(), Some(FIRST_RUN));
    }

    #[test]
    fn gemini_is_unavailable_and_signed_out_is_not_checked() {
        let (_temp, profiles) = profiles();
        let usage = read_account_usage(
            &profiles,
            &account(GEMINI_ID, "gemini-cli", AuthState::Unknown),
            NOW,
        );
        assert_eq!(usage.status, ProviderUsageStatus::Unavailable);
        assert!(usage.windows.is_empty());

        write(
            &home(&profiles, "claude-code", CLAUDE_ID).join(".claude.json"),
            CLAUDE_STATE,
        );
        let usage = read_account_usage(
            &profiles,
            &account(CLAUDE_ID, "claude-code", AuthState::NotAuthenticated),
            NOW,
        );
        assert_eq!(usage.status, ProviderUsageStatus::NotChecked);
        assert_eq!(usage.reason.as_deref(), Some(SIGNED_OUT));
        assert!(usage.windows.is_empty());
    }

    #[test]
    fn plan_labels_are_only_unambiguous_tiers() {
        assert_eq!(
            claude_plan("default_claude_max_5x").as_deref(),
            Some("Max 5x")
        );
        assert_eq!(claude_plan("default_claude_pro").as_deref(), Some("Pro"));
        assert_eq!(claude_plan("default_claude_ai"), None);
        assert_eq!(codex_plan("plus").as_deref(), Some("Plus"));
        assert_eq!(codex_plan("mystery"), None);
        assert_eq!(codex_window_name("primary", Some(1440)).1, "1-day");
    }
}
