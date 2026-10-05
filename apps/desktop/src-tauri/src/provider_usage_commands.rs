//! Provider quota usage per account (`kalcode_providers::usage`).
//!
//! The passive read copies only files the provider CLIs wrote into each account's managed
//! profile. Those files change only while an agent runs, so when an account's reading is older
//! than `LIVE_INTERVAL` this also asks the provider's own usage endpoint, at most once per
//! interval per account, and shows whichever reading is newer. The live read is read-only (no
//! token refresh, nothing written or stored) and a failed one leaves the passive reading in
//! place. Paths, tokens and file contents never cross this boundary, only the usage numbers.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use kalcode_contracts::agent::AuthState;
use kalcode_contracts::provider_accounts::{
    ProviderAccount, ProviderAccountUsage, ProviderUsageStatus,
};
use kalcode_core::{ErrorCategory, IpcError, KalError};
use kalcode_providers::accounts::AccountStore;
use kalcode_providers::managed::ManagedProfiles;
use kalcode_providers::usage::{
    LiveUsageRequest, live_usage_request, read_account_usage, usage_from_live_response,
};
use tauri::State;

use crate::AppState;

/// A reading younger than this is current enough; older ones get a live read at most this often.
const LIVE_INTERVAL: Duration = Duration::from_secs(120);
/// After a failed or refused live read (offline, expired token, rate limited).
const LIVE_RETRY_AFTER_FAILURE: Duration = Duration::from_secs(600);
const LIVE_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_LIVE_RESPONSE_BYTES: u64 = 1024 * 1024;

struct LiveEntry {
    identity: AccountIdentity,
    attempted: Instant,
    succeeded: bool,
    usage: Option<ProviderAccountUsage>,
}

#[derive(Clone, PartialEq, Eq)]
struct AccountIdentity {
    provider: String,
    reported: Option<String>,
    authentication: AuthState,
    credential_revision: Option<(std::time::SystemTime, u64)>,
}

fn identity(profiles: &ManagedProfiles, account: &ProviderAccount) -> AccountIdentity {
    // Only filesystem metadata enters the cache key, never credentials. A successful
    // reconnect can replace credentials before the asynchronously checked email changes.
    let credential_revision = profiles
        .existing_profile_home(account.provider_id.as_str(), &account.id)
        .ok()
        .flatten()
        .and_then(|home| {
            let file = if account.provider_id.as_str() == "codex" {
                "auth.json"
            } else {
                ".credentials.json"
            };
            std::fs::symlink_metadata(home.join(file)).ok()
        })
        .filter(|metadata| metadata.is_file())
        .and_then(|metadata| {
            metadata
                .modified()
                .ok()
                .map(|modified| (modified, metadata.len()))
        });

    AccountIdentity {
        provider: account.provider_id.as_str().to_owned(),
        reported: account.provider_reported_identity.clone(),
        authentication: account.authentication_state,
        credential_revision,
    }
}

fn unavailable(account: &ProviderAccount, plan: Option<String>) -> ProviderAccountUsage {
    ProviderAccountUsage {
        account_id: account.id.clone(),
        status: ProviderUsageStatus::Unavailable,
        plan,
        windows: Vec::new(),
        checked_at: None,
        reason: Some("Usage couldn't be read".to_owned()),
    }
}

fn live_entries() -> &'static Mutex<HashMap<String, LiveEntry>> {
    static ENTRIES: OnceLock<Mutex<HashMap<String, LiveEntry>>> = OnceLock::new();
    ENTRIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Usage for active accounts (all of them, or only `account_ids`). Async: off the main thread.
#[tauri::command(async)]
pub fn provider_account_usage(
    _runtime_access: crate::runtime_coordinator::RuntimeAccess,
    state: State<'_, AppState>,
    account_ids: Option<Vec<String>>,
) -> Result<Vec<ProviderAccountUsage>, IpcError> {
    _runtime_access.revalidate()?;
    let accounts = AccountStore::new(state.core()?.clone())
        .list(None)
        .map_err(|error| error.log_and_convert("provider_account_usage"))?;
    let profiles = ManagedProfiles::for_data_dir(&state.paths.data_dir).map_err(|error| {
        KalError::new(
            ErrorCategory::Provider,
            "provider_account_profile_unavailable",
            "KalCode couldn't safely open managed provider profiles.",
        )
        .with_source(error)
        .to_ipc()
    })?;
    let now = time::OffsetDateTime::now_utc();
    let accounts: Vec<&ProviderAccount> = accounts
        .iter()
        .filter(|account| account.archived_at.is_none())
        .filter(|account| {
            account_ids
                .as_ref()
                .is_none_or(|ids| ids.iter().any(|id| id == &account.id))
        })
        .collect();
    let identities: HashMap<_, _> = accounts
        .iter()
        .map(|account| (account.id.clone(), identity(&profiles, account)))
        .collect();
    let passive: Vec<ProviderAccountUsage> = accounts
        .iter()
        .map(|account| read_account_usage(&profiles, account, now))
        .collect();
    refresh_live(&profiles, &accounts, &passive, &identities, now);
    // Authentication may have completed while the network request was in flight.
    let current = AccountStore::new(state.core()?.clone())
        .list(None)
        .map_err(|error| error.log_and_convert("provider_account_usage"))?;
    let entries = live_entries()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    Ok(accounts
        .iter()
        .zip(passive)
        .map(|(account, passive)| {
            if !current.iter().any(|value| {
                value.id == account.id
                    && value.archived_at.is_none()
                    && identities.get(&account.id) == Some(&identity(&profiles, value))
            }) {
                return unavailable(account, None);
            }
            let entry = entries
                .get(&account.id)
                .filter(|entry| identities.get(&account.id) == Some(&entry.identity));
            if let Some(entry) = entry.filter(|entry| !entry.succeeded) {
                return unavailable(
                    account,
                    entry
                        .usage
                        .as_ref()
                        .and_then(|usage| usage.plan.clone())
                        .or(passive.plan),
                );
            }
            let live = entry
                .and_then(|entry| entry.usage.as_ref())
                .filter(|_| account.authentication_state != AuthState::NotAuthenticated);
            match live {
                Some(live) if live.checked_at.is_none() || newer(live, &passive) => live.clone(),
                _ => passive,
            }
        })
        .collect())
}

/// Live-reads, in parallel, every account whose reading is older than `LIVE_INTERVAL` and whose
/// last live attempt is due again. Concurrent calls never read the same account twice.
fn refresh_live(
    profiles: &ManagedProfiles,
    accounts: &[&ProviderAccount],
    passive: &[ProviderAccountUsage],
    identities: &HashMap<String, AccountIdentity>,
    now: time::OffsetDateTime,
) {
    let due: Vec<(&ProviderAccount, AccountIdentity, LiveUsageRequest)> = {
        let mut entries = live_entries()
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        accounts
            .iter()
            .zip(passive)
            .filter_map(|(account, passive)| {
                let expected_identity = identities.get(&account.id)?;
                if *expected_identity != identity(profiles, account) {
                    return None;
                }
                if entries
                    .get(&account.id)
                    .is_some_and(|entry| entry.identity != *expected_identity)
                {
                    entries.remove(&account.id);
                }
                let current = entries
                    .get(&account.id)
                    .and_then(|entry| entry.usage.as_ref())
                    .filter(|live| newer(live, passive))
                    .unwrap_or(passive);
                if younger_than(current, LIVE_INTERVAL, now) {
                    return None;
                }
                if let Some(entry) = entries.get(&account.id) {
                    let wait = if entry.succeeded {
                        LIVE_INTERVAL
                    } else {
                        LIVE_RETRY_AFTER_FAILURE
                    };
                    if entry.attempted.elapsed() < wait {
                        return None;
                    }
                }
                let request = live_usage_request(profiles, account, now)?;
                let entry = entries.entry(account.id.clone()).or_insert(LiveEntry {
                    identity: expected_identity.clone(),
                    attempted: Instant::now(),
                    succeeded: false,
                    usage: None,
                });
                entry.attempted = Instant::now();
                Some((*account, expected_identity.clone(), request))
            })
            .collect()
    };
    if due.is_empty() {
        return;
    }
    std::thread::scope(|scope| {
        for (account, expected_identity, request) in due {
            scope.spawn(move || {
                let usage = fetch_live(&request).and_then(|body| {
                    usage_from_live_response(
                        profiles,
                        account,
                        &body,
                        time::OffsetDateTime::now_utc(),
                    )
                });
                let mut entries = live_entries()
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                if let Some(entry) = entries.get_mut(&account.id).filter(|entry| {
                    response_matches(entry, &expected_identity, &identity(profiles, account))
                }) {
                    entry.succeeded = usage.is_some();
                    entry.usage = usage.or_else(|| {
                        Some(unavailable(
                            account,
                            entry
                                .usage
                                .as_ref()
                                .and_then(|previous| previous.plan.clone()),
                        ))
                    });
                }
            });
        }
    });
}

fn response_matches(
    entry: &LiveEntry,
    requested: &AccountIdentity,
    current: &AccountIdentity,
) -> bool {
    entry.identity == *requested && requested == current
}

fn fetch_live(request: &LiveUsageRequest) -> Option<serde_json::Value> {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    let agent = AGENT.get_or_init(|| {
        ureq::Agent::config_builder()
            .timeout_global(Some(LIVE_TIMEOUT))
            .max_redirects(0)
            .http_status_as_error(false)
            .user_agent("KalCode")
            .build()
            .into()
    });
    let mut call = agent.get(request.url);
    for (name, value) in &request.headers {
        call = call.header(*name, value);
    }
    let mut response = call.call().ok()?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        tracing::debug!(event = "provider_usage.live_refused", status);
        return None;
    }
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_LIVE_RESPONSE_BYTES)
        .read_to_vec()
        .ok()?;
    serde_json::from_slice(&body).ok()
}

/// Whether `candidate` was read after `other` (both RFC 3339 UTC from `format_rfc3339`).
fn newer(candidate: &ProviderAccountUsage, other: &ProviderAccountUsage) -> bool {
    match (&candidate.checked_at, &other.checked_at) {
        (Some(candidate), Some(other)) => parse(candidate) > parse(other),
        (Some(_), None) => true,
        (None, _) => false,
    }
}

fn younger_than(usage: &ProviderAccountUsage, age: Duration, now: time::OffsetDateTime) -> bool {
    usage
        .checked_at
        .as_deref()
        .and_then(parse)
        .is_some_and(|checked| now - checked < age)
}

fn parse(value: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::agent::ProviderId;

    #[test]
    fn reconnect_invalidates_usage_even_before_reported_identity_changes() {
        let temp = tempfile::tempdir().expect("profile root");
        let root = temp.path().canonicalize().expect("canonical profile root");
        let profiles = ManagedProfiles::for_data_dir(&root).expect("profiles");
        let account = ProviderAccount {
            id: "0192f3c4-0000-7000-8000-000000000201".to_owned(),
            provider_id: ProviderId::new("codex"),
            display_name: "Codex B".to_owned(),
            provider_reported_identity: Some("person@example.test".to_owned()),
            authentication_state: AuthState::Authenticated,
            is_default: true,
            created_at: "2026-10-04T00:00:00Z".to_owned(),
            last_used_at: None,
            last_checked_at: None,
            last_error_code: None,
            archived_at: None,
        };
        let home = profiles
            .profile_home("codex", &account.id)
            .expect("profile");
        std::fs::write(home.join("auth.json"), "synthetic original").expect("fixture");
        let before = identity(&profiles, &account);
        std::fs::write(home.join("auth.json"), "synthetic replacement session")
            .expect("reconnect fixture");
        let after = identity(&profiles, &account);
        assert!(before != after);
        let replacement = LiveEntry {
            identity: after.clone(),
            attempted: Instant::now(),
            succeeded: true,
            usage: None,
        };
        assert!(
            !response_matches(&replacement, &before, &after),
            "old in-flight response cannot overwrite the new identity's cache"
        );
        assert!(response_matches(&replacement, &after, &after));
        let unavailable = unavailable(&account, Some("Pro".to_owned()));
        assert_eq!(unavailable.status, ProviderUsageStatus::Unavailable);
        assert!(unavailable.windows.is_empty());
        assert_eq!(unavailable.plan.as_deref(), Some("Pro"));
        assert_eq!(account.authentication_state, AuthState::Authenticated);
    }
}
