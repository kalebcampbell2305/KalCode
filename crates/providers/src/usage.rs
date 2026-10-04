//! Provider quota usage per account: passive file reads, plus a live read when they age.
//!
//! Every passive number is copied from a file the provider CLI itself wrote into the account's
//! dedicated profile home. That path never runs a provider command, never reads a credential
//! file or the OS keychain, never calls the network, and never writes anything. Because those
//! files only change while an agent runs, the caller may also make a live read (see
//! `live_usage_request`): the provider's own usage endpoint, with the access token the provider
//! keeps in a file in that profile, read-only and never refreshed, copied or stored. Neither
//! path can refresh or invalidate a sign-in or show a prompt (the macOS Keychain is never read).
//!
//! - **Claude Code** caches the account's plan utilization (`cachedUsageUtilization`: 5-hour and
//!   weekly windows with reset times, plus `fetchedAtMs`) in `.claude.json` inside the account's
//!   `CLAUDE_CONFIG_DIR`. It refreshes that cache itself while a session runs, so usage appears
//!   once an agent has run on the account. `.claude.json` holds no tokens (those live in
//!   `.credentials.json` or the macOS Keychain, which this module never touches). The cache is
//!   used only when its `accountUuid` matches the profile's signed-in `oauthAccount`.
//! - **Codex** usage comes only from the authenticated account's live usage endpoint.
//!   Rollout history has no reliable account attribution after reconnect, so it is never
//!   used as evidence of the currently connected identity's quota.
//! - **Gemini CLI** (and anything else) exposes no plan usage: `unavailable`.
//!
//! A window whose reset time has passed is dropped (the provider hasn't reported the new
//! window yet), so a stale "0% left" never outlives its reset.

use std::collections::HashMap;
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
        // Rollouts do not identify the authenticated account. A reconnect in the
        // same profile could otherwise report a previous identity's quota.
        Ok(None)
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
    let has_valid_measurement = reading.windows.iter().any(|window| {
        window.used_percent.is_finite() && (0.0..=100.0).contains(&window.used_percent)
    });
    let mut windows: Vec<ProviderUsageWindow> = reading
        .windows
        .into_iter()
        .filter(|window| {
            window.used_percent.is_finite() && (0.0..=100.0).contains(&window.used_percent)
        })
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
            remaining_percent: 100.0 - window.used_percent,
            resets_at: window.resets_at.map(format_rfc3339),
        })
        .collect();
    windows.sort_by(|left, right| left.remaining_percent.total_cmp(&right.remaining_percent));
    if windows.is_empty() {
        let mut usage = outcome(
            account,
            ProviderUsageStatus::NotChecked,
            Some(if has_valid_measurement {
                RESET_SINCE_READ
            } else {
                UNREADABLE
            }),
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
    let expected = account.get("accountUuid")?.as_str()?.trim();
    let cached_for = cache.get("accountUuid")?.as_str()?.trim();
    if expected.is_empty() || expected != cached_for {
        return None;
    }
    let fetched_ms = cache.get("fetchedAtMs").and_then(Value::as_i64)?;
    let checked_at =
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(fetched_ms) * 1_000_000).ok()?;
    let tier = account
        .get("organizationRateLimitTier")
        .and_then(Value::as_str)
        .or_else(|| account.get("userRateLimitTier").and_then(Value::as_str));
    claude_utilization(cache.get("utilization")?, checked_at, tier)
}

/// Claude's plan utilization (the `/api/oauth/usage` response, which Claude Code also caches).
fn claude_utilization(
    utilization: &Value,
    checked_at: OffsetDateTime,
    tier: Option<&str>,
) -> Option<Reading> {
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
    let plan = tier.and_then(claude_plan);
    if windows.is_empty() && plan.is_none() {
        return None;
    }
    Some(Reading {
        plan,
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

// --- Live provider reads ----------------------------------------------------------------------
//
// The files above only change while an agent runs, so an idle account's numbers age. A live
// read asks the provider's own usage endpoint (the one its CLI's usage screen calls) with the
// access token the provider CLI already keeps in the account's profile. It is read-only: the
// token is never refreshed, copied, logged or persisted, and nothing is written. An expired or
// rejected token simply leaves the file reading in place; it is not proof of sign-out. Tokens
// kept in the macOS Keychain are never read (that could prompt), so those accounts stay passive.
// The network call itself lives with the caller; this module only builds and interprets it.

/// One live usage request: the provider endpoint and its headers (including the bearer token).
pub struct LiveUsageRequest {
    pub url: &'static str,
    pub headers: Vec<(&'static str, String)>,
}

impl std::fmt::Debug for LiveUsageRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Headers carry the access token.
        formatter
            .debug_struct("LiveUsageRequest")
            .field("url", &self.url)
            .finish_non_exhaustive()
    }
}

const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
/// Provider credential files are small; anything larger is not one.
const MAX_CREDENTIAL_BYTES: u64 = 64 * 1024;
/// A token this close to expiry is left for the provider CLI to refresh.
const TOKEN_EXPIRY_MARGIN: Duration = Duration::seconds(60);

/// The live request for an account, or `None` when it can't be read live (another provider,
/// signed out, no profile, no file-kept token, or an expired one).
pub fn live_usage_request(
    profiles: &ManagedProfiles,
    account: &ProviderAccount,
    now: OffsetDateTime,
) -> Option<LiveUsageRequest> {
    if account.authentication_state == AuthState::NotAuthenticated {
        return None;
    }
    let provider = account.provider_id.as_str();
    if provider != ProviderId::CLAUDE_CODE && provider != ProviderId::CODEX {
        return None;
    }
    let home = profiles
        .existing_profile_home(provider, &account.id)
        .ok()??;
    if provider == ProviderId::CLAUDE_CODE {
        let credentials = read_small_json(&home.join(".credentials.json"))?;
        let oauth = credentials.get("claudeAiOauth")?;
        let token = oauth.get("accessToken")?.as_str()?.trim();
        let expires_ms = oauth.get("expiresAt").and_then(Value::as_i64)?;
        let expires =
            OffsetDateTime::from_unix_timestamp_nanos(i128::from(expires_ms) * 1_000_000).ok()?;
        if token.is_empty() || expires <= now + TOKEN_EXPIRY_MARGIN {
            return None;
        }
        Some(LiveUsageRequest {
            url: CLAUDE_USAGE_URL,
            headers: vec![
                ("Authorization", format!("Bearer {token}")),
                ("anthropic-beta", "oauth-2025-04-20".to_owned()),
            ],
        })
    } else {
        let auth = read_small_json(&home.join("auth.json"))?;
        let tokens = auth.get("tokens")?;
        let token = tokens.get("access_token")?.as_str()?.trim();
        if token.is_empty() {
            return None;
        }
        let mut headers = vec![("Authorization", format!("Bearer {token}"))];
        if let Some(id) = tokens
            .get("account_id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
        {
            headers.push(("ChatGPT-Account-Id", id.to_owned()));
        }
        Some(LiveUsageRequest {
            url: CODEX_USAGE_URL,
            headers,
        })
    }
}

/// Usage from a live response body, or `None` when it doesn't describe the account's limits.
pub fn usage_from_live_response(
    profiles: &ManagedProfiles,
    account: &ProviderAccount,
    body: &Value,
    now: OffsetDateTime,
) -> Option<ProviderAccountUsage> {
    let reading = if account.provider_id.as_str() == ProviderId::CLAUDE_CODE {
        let home = profiles
            .existing_profile_home(ProviderId::CLAUDE_CODE, &account.id)
            .ok()??;
        let tier = read_small_json(&home.join(".credentials.json")).and_then(|credentials| {
            credentials
                .pointer("/claudeAiOauth/rateLimitTier")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        claude_utilization(body, now, tier.as_deref())?
    } else if account.provider_id.as_str() == ProviderId::CODEX {
        codex_live_reading(body, now)?
    } else {
        return None;
    };
    Some(usage_from_reading(account, Ok(Some(reading)), now))
}

fn codex_live_reading(body: &Value, now: OffsetDateTime) -> Option<Reading> {
    let limits = body.get("rate_limit").and_then(Value::as_object);
    let mut windows = Vec::new();
    for (key, slot) in [
        ("primary_window", "primary"),
        ("secondary_window", "secondary"),
    ] {
        let Some(window) = limits
            .and_then(|limits| limits.get(key))
            .filter(|window| window.is_object())
        else {
            continue;
        };
        let Some(used) = window.get("used_percent").and_then(Value::as_f64) else {
            continue;
        };
        let minutes = window
            .get("limit_window_seconds")
            .and_then(Value::as_i64)
            .map(|seconds| seconds / 60);
        let resets_at = window
            .get("reset_at")
            .and_then(Value::as_i64)
            .and_then(|seconds| OffsetDateTime::from_unix_timestamp(seconds).ok())
            .or_else(|| {
                window
                    .get("reset_after_seconds")
                    .and_then(Value::as_i64)
                    .map(|seconds| now + Duration::seconds(seconds))
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
    let plan = body
        .get("plan_type")
        .and_then(Value::as_str)
        .and_then(codex_plan);
    if windows.is_empty() && plan.is_none() {
        return None;
    }
    Some(Reading {
        plan,
        checked_at: now,
        windows,
    })
}

fn read_small_json(path: &Path) -> Option<Value> {
    let metadata = std::fs::symlink_metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_CREDENTIAL_BYTES {
        return None;
    }
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
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
    fn live_claude_request_uses_the_profile_token_until_it_expires() {
        let (_temp, profiles) = profiles();
        let claude = account(CLAUDE_ID, ProviderId::CLAUDE_CODE, AuthState::Authenticated);
        assert!(
            live_usage_request(&profiles, &claude, NOW).is_none(),
            "no profile yet"
        );
        let dir = home(&profiles, ProviderId::CLAUDE_CODE, CLAUDE_ID);
        let expires = (NOW + Duration::hours(1)).unix_timestamp() * 1000;
        write(
            &dir.join(".credentials.json"),
            &format!(
                r#"{{"claudeAiOauth":{{"accessToken":"tok-1","expiresAt":{expires},"rateLimitTier":"default_claude_max_20x"}}}}"#
            ),
        );
        let request = live_usage_request(&profiles, &claude, NOW).expect("request");
        assert_eq!(request.url, CLAUDE_USAGE_URL);
        assert!(
            request
                .headers
                .contains(&("Authorization", "Bearer tok-1".to_owned()))
        );
        assert!(
            !format!("{request:?}").contains("tok-1"),
            "Debug never shows the token"
        );
        assert!(live_usage_request(&profiles, &claude, NOW + Duration::hours(2)).is_none());
        let signed_out = account(
            CLAUDE_ID,
            ProviderId::CLAUDE_CODE,
            AuthState::NotAuthenticated,
        );
        assert!(live_usage_request(&profiles, &signed_out, NOW).is_none());

        let body: Value = serde_json::from_str(
            r#"{"five_hour":{"utilization":9,"resets_at":"2026-10-03T20:00:00+00:00"},
                "seven_day":{"utilization":16,"resets_at":"2026-10-10T08:00:00+00:00"},
                "limits":[{"kind":"weekly_scoped","percent":2,"resets_at":"2026-10-10T08:00:00+00:00",
                           "scope":{"model":{"display_name":"Fable"}}}]}"#,
        )
        .unwrap_or_else(|error| panic!("json: {error}"));
        let usage = usage_from_live_response(&profiles, &claude, &body, NOW).expect("usage");
        assert_eq!(usage.status, ProviderUsageStatus::Available);
        assert_eq!(
            usage.checked_at.as_deref(),
            Some("2026-10-03T17:45:00.000Z")
        );
        assert_eq!(usage.plan.as_deref(), Some("Max 20x"));
        let ids: Vec<_> = usage
            .windows
            .iter()
            .map(|w| (w.id.as_str(), w.remaining_percent))
            .collect();
        assert_eq!(
            ids,
            [
                ("weekly", 84.0),
                ("five_hour", 91.0),
                ("weekly_fable", 98.0)
            ]
        );
    }

    #[test]
    fn live_codex_request_and_response() {
        let (_temp, profiles) = profiles();
        let codex = account(CODEX_ID, ProviderId::CODEX, AuthState::Authenticated);
        let dir = home(&profiles, ProviderId::CODEX, CODEX_ID);
        write(
            &dir.join("auth.json"),
            r#"{"auth_mode":"chatgpt","tokens":{"access_token":"tok-2","account_id":"acct-9"}}"#,
        );
        let request = live_usage_request(&profiles, &codex, NOW).expect("request");
        assert_eq!(request.url, CODEX_USAGE_URL);
        assert!(
            request
                .headers
                .contains(&("ChatGPT-Account-Id", "acct-9".to_owned()))
        );

        let resets = (NOW + Duration::days(6)).unix_timestamp();
        let body: Value = serde_json::from_str(&format!(
            r#"{{"plan_type":"pro","rate_limit":{{"primary_window":{{"used_percent":21,"limit_window_seconds":604800,"reset_at":{resets}}},"secondary_window":null}}}}"#
        ))
        .unwrap_or_else(|error| panic!("json: {error}"));
        let usage = usage_from_live_response(&profiles, &codex, &body, NOW).expect("usage");
        assert_eq!(usage.plan.as_deref(), Some("Pro"));
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].id, "weekly");
        assert!((usage.windows[0].remaining_percent - 79.0).abs() < f64::EPSILON);
        assert!(usage_from_live_response(&profiles, &codex, &Value::Null, NOW).is_none());
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

    #[test]
    fn invalid_percentages_never_become_exhausted_usage() {
        let codex = account(CODEX_ID, ProviderId::CODEX, AuthState::Authenticated);
        for used_percent in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY, -1.0, 101.0] {
            let reading = Reading {
                plan: Some("Pro".to_owned()),
                checked_at: NOW,
                windows: vec![RawWindow {
                    id: "primary".to_owned(),
                    label: "Primary".to_owned(),
                    used_percent,
                    resets_at: Some(NOW + Duration::hours(1)),
                    window_minutes: Some(300),
                }],
            };
            let usage = usage_from_reading(&codex, Ok(Some(reading)), NOW);
            assert!(
                usage.windows.is_empty(),
                "invalid {used_percent} was converted to quota"
            );
            assert_ne!(usage.status, ProviderUsageStatus::Available);
            assert_eq!(usage.plan.as_deref(), Some("Pro"));
        }
    }

    #[test]
    fn live_adapters_reject_malformed_values_and_preserve_real_zero() {
        let (_temp, profiles) = profiles();
        let codex = account(CODEX_ID, ProviderId::CODEX, AuthState::Authenticated);
        let claude = account(CLAUDE_ID, ProviderId::CLAUDE_CODE, AuthState::Authenticated);
        home(&profiles, ProviderId::CLAUDE_CODE, CLAUDE_ID);
        for value in [
            Value::Null,
            serde_json::json!("100"),
            serde_json::json!(-1),
            serde_json::json!(101),
            serde_json::json!({}),
        ] {
            for (provider, body) in [
                (
                    &codex,
                    serde_json::json!({"rate_limit":{"primary_window":{"used_percent":value,"limit_window_seconds":300}}}),
                ),
                (
                    &claude,
                    serde_json::json!({"five_hour":{"utilization":value}}),
                ),
            ] {
                let usage = usage_from_live_response(&profiles, provider, &body, NOW);
                assert!(usage.is_none_or(|usage| usage.windows.is_empty()));
            }
        }
        for (used, remaining) in [(100.0, 0.0), (0.0, 100.0), (99.9, 0.1)] {
            for (provider, body) in [
                (
                    &codex,
                    serde_json::json!({"rate_limit":{"primary_window":{"used_percent":used,"limit_window_seconds":300}}}),
                ),
                (
                    &claude,
                    serde_json::json!({"five_hour":{"utilization":used}}),
                ),
            ] {
                let usage = usage_from_live_response(&profiles, provider, &body, NOW)
                    .expect("reported usage");
                assert_eq!(usage.status, ProviderUsageStatus::Available);
                assert!((usage.windows[0].remaining_percent - remaining).abs() < 0.00001);
                assert_eq!(usage.plan, None, "plan is independent of quota");
            }
        }
    }

    #[test]
    fn claude_cache_requires_explicit_matching_identity() {
        let mut state: Value = serde_json::from_str(CLAUDE_STATE).expect("fixture");
        state["cachedUsageUtilization"]
            .as_object_mut()
            .expect("cache")
            .remove("accountUuid");
        assert!(parse_claude_state(&state).is_none());
    }

    #[test]
    fn known_plan_survives_missing_or_malformed_usage() {
        let (_temp, profiles) = profiles();
        let codex = account(CODEX_ID, ProviderId::CODEX, AuthState::Authenticated);
        let claude = account(CLAUDE_ID, ProviderId::CLAUDE_CODE, AuthState::Authenticated);
        write(
            &home(&profiles, ProviderId::CLAUDE_CODE, CLAUDE_ID).join(".credentials.json"),
            r#"{"claudeAiOauth":{"rateLimitTier":"default_claude_pro"}}"#,
        );
        for (provider, body) in [
            (&codex, serde_json::json!({"plan_type":"pro"})),
            (
                &codex,
                serde_json::json!({"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":null}}}),
            ),
            (
                &claude,
                serde_json::json!({"five_hour":{"utilization":null}}),
            ),
        ] {
            let usage = usage_from_live_response(&profiles, provider, &body, NOW)
                .expect("known plan response");
            assert_eq!(usage.plan.as_deref(), Some("Pro"));
            assert!(usage.windows.is_empty());
            assert_eq!(usage.checked_at, None, "no fake usage freshness");
            assert_ne!(usage.status, ProviderUsageStatus::Available);
            assert_eq!(provider.authentication_state, AuthState::Authenticated);
        }
    }

    #[test]
    fn codex_rollouts_cannot_attribute_usage_to_a_reconnected_identity() {
        let (_temp, profiles) = profiles();
        write(
            &home(&profiles, "codex", CODEX_ID).join("sessions/2026/10/03/rollout-old.jsonl"),
            r#"{"timestamp":"2026-10-03T17:44:00.000Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":100,"window_minutes":10080},"plan_type":"pro"}}}"#,
        );
        let usage = read_account_usage(
            &profiles,
            &account(CODEX_ID, "codex", AuthState::Authenticated),
            NOW,
        );
        assert!(usage.windows.is_empty());
        assert_eq!(usage.plan, None);
    }
}
