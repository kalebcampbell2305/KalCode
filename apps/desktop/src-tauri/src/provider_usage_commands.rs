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
use kalcode_contracts::provider_accounts::{ProviderAccount, ProviderAccountUsage};
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
    attempted: Instant,
    succeeded: bool,
    usage: Option<ProviderAccountUsage>,
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
    let passive: Vec<ProviderAccountUsage> = accounts
        .iter()
        .map(|account| read_account_usage(&profiles, account, now))
        .collect();
    refresh_live(&profiles, &accounts, &passive, now);
    let entries = live_entries()
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    Ok(accounts
        .iter()
        .zip(passive)
        .map(|(account, passive)| {
            let live = entries
                .get(&account.id)
                .and_then(|entry| entry.usage.as_ref())
                .filter(|_| account.authentication_state != AuthState::NotAuthenticated);
            match live {
                Some(live) if newer(live, &passive) => live.clone(),
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
    now: time::OffsetDateTime,
) {
    let due: Vec<(&ProviderAccount, LiveUsageRequest)> = {
        let mut entries = live_entries()
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        accounts
            .iter()
            .zip(passive)
            .filter_map(|(account, passive)| {
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
                    attempted: Instant::now(),
                    succeeded: false,
                    usage: None,
                });
                entry.attempted = Instant::now();
                Some((*account, request))
            })
            .collect()
    };
    if due.is_empty() {
        return;
    }
    std::thread::scope(|scope| {
        for (account, request) in due {
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
                if let Some(entry) = entries.get_mut(&account.id) {
                    entry.succeeded = usage.is_some();
                    if usage.is_some() {
                        entry.usage = usage;
                    }
                }
            });
        }
    });
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
