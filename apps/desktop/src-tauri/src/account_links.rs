//! Native-only OAuth callback delivery. URLs remain in bounded memory and never enter logs.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::async_runtime::{Sender, channel};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

use crate::account::model::AccountPhase;
use crate::account::runtime::AccountRuntime;
use crate::runtime_coordinator::{AccountMutation, RuntimeCoordinator};

const MAX_CALLBACK_BYTES: usize = 8_192;
const MAX_QUEUED_CALLBACKS: usize = 8;

fn enqueue(sender: &Sender<String>, urls: impl IntoIterator<Item = Url>) -> usize {
    let mut queued = 0;
    for url in urls.into_iter().take(MAX_QUEUED_CALLBACKS) {
        // This is only an admission bound. The account owner validates the full callback and
        // its durable provider/state/PKCE/nonce binding before it can change account authority.
        if url.as_str().len() <= MAX_CALLBACK_BYTES
            && url.scheme() == kalcode_contracts::identity::URL_SCHEME
            && url.host_str() == Some("auth")
            && sender.try_send(url.into()).is_ok()
        {
            queued += 1;
        }
    }
    queued
}

fn enqueue_warm(
    sender: &Sender<String>,
    urls: impl IntoIterator<Item = Url>,
    restore: impl FnOnce(),
) {
    if enqueue(sender, urls) > 0 {
        restore();
    }
}

/// How often the renewal thread checks local account state. This is deliberately cheap and lets
/// a launch that entered verified offline grace recover promptly when connectivity returns.
const RENEWAL_CHECK_INTERVAL: Duration = Duration::from_secs(15);
/// The fewest seconds between two renewal requests, so an offline device or a document that is
/// already short-lived (a lapsing subscription) never hammers the account service.
const RENEWAL_RETRY_INTERVAL: Duration = Duration::from_secs(30 * 60);
const OFFLINE_RETRY_INITIAL_INTERVAL: Duration = Duration::from_secs(30);
const OFFLINE_RETRY_MAX_INTERVAL: Duration = Duration::from_secs(5 * 60);

fn renewal_retry_interval(phase: AccountPhase, consecutive_failures: u32) -> Duration {
    if phase != AccountPhase::OfflineGrace {
        return RENEWAL_RETRY_INTERVAL;
    }
    let exponent = consecutive_failures.saturating_sub(1).min(5);
    OFFLINE_RETRY_INITIAL_INTERVAL
        .saturating_mul(1_u32 << exponent)
        .min(OFFLINE_RETRY_MAX_INTERVAL)
}

/// Keeps a long-running KalCode's signed plan document fresh. Without this, the document
/// fetched at launch expires after at most 7 days (sooner near a subscription renewal) and the
/// runtime coordinator drains every running agent and terminal although the plan is still paid.
fn start_entitlement_renewal(account: &Arc<AccountRuntime>, coordinator: &Arc<RuntimeCoordinator>) {
    let account = Arc::downgrade(account);
    let coordinator = Arc::downgrade(coordinator);
    let spawned = std::thread::Builder::new()
        .name("kalcode-entitlement-renewal".into())
        .spawn(move || {
            let mut last_attempt: Option<Instant> = None;
            let mut consecutive_failures = 0_u32;
            loop {
                std::thread::sleep(RENEWAL_CHECK_INTERVAL);
                let (Some(account), Some(coordinator)) = (account.upgrade(), coordinator.upgrade())
                else {
                    return;
                };
                if coordinator.lifecycle.phase() == crate::runtime_lifecycle::Phase::AppExiting {
                    return;
                }
                if !account.entitlement_renewal_due() {
                    last_attempt = None;
                    consecutive_failures = 0;
                    continue;
                }
                let retry_interval =
                    renewal_retry_interval(account.snapshot().phase, consecutive_failures);
                if last_attempt.is_some_and(|at| at.elapsed() < retry_interval) {
                    continue;
                }
                // The same admission as the Account Center's Refresh, so renewal never races a
                // sign-out or runtime drain.
                let Ok(admission) = AccountMutation::acquire(&coordinator) else {
                    continue;
                };
                last_attempt = Some(Instant::now());
                match account.refresh() {
                    Ok(snapshot) if snapshot.phase == AccountPhase::OfflineGrace => {
                        consecutive_failures = consecutive_failures.saturating_add(1);
                        tracing::warn!(event = "account.entitlement_renewal_failed");
                    }
                    Ok(_) => consecutive_failures = 0,
                    Err(_) => {
                        consecutive_failures = consecutive_failures.saturating_add(1);
                        tracing::warn!(event = "account.entitlement_renewal_failed");
                    }
                }
                drop(admission);
            }
        });
    if spawned.is_err() {
        tracing::warn!(event = "account.entitlement_renewal_unavailable");
    }
}

pub fn start(
    app: &tauri::AppHandle,
    account: Arc<AccountRuntime>,
    coordinator: Arc<RuntimeCoordinator>,
) {
    start_entitlement_renewal(&account, &coordinator);
    let (sender, mut receiver) = channel(MAX_QUEUED_CALLBACKS);
    let warm_sender = sender.clone();
    let warm_app = app.clone();
    app.deep_link().on_open_url(move |event| {
        enqueue_warm(&warm_sender, event.urls(), || {
            let _ = crate::restore_main_window(&warm_app);
        });
    });
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        enqueue(&sender, urls);
    }
    tauri::async_runtime::spawn(async move {
        if crate::account_commands::bootstrap_runtime(account.clone())
            .await
            .is_err()
        {
            tracing::warn!(event = "account.bootstrap_failed");
        }
        while let Some(raw) = receiver.recv().await {
            let Ok(admission) = AccountMutation::acquire(&coordinator) else {
                continue;
            };
            if crate::account_commands::complete_social_callback(account.clone(), admission, raw)
                .await
                .is_err()
            {
                // Do not format an error here: downstream/network errors may contain a URL.
                tracing::warn!(event = "account.social_callback_rejected");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn callbacks_are_bounded_and_foreign_destinations_never_enter_the_queue() {
        let (sender, mut receiver) = channel(MAX_QUEUED_CALLBACKS);
        assert_eq!(
            enqueue(
                &sender,
                [
                    Url::parse("https://auth/google?code=synthetic").unwrap(),
                    Url::parse(&format!(
                        "{}://other/google?code=synthetic",
                        kalcode_contracts::identity::URL_SCHEME
                    ))
                    .unwrap(),
                    Url::parse(&format!(
                        "{}://auth/google?code={}",
                        kalcode_contracts::identity::URL_SCHEME,
                        "x".repeat(MAX_CALLBACK_BYTES)
                    ))
                    .unwrap(),
                ],
            ),
            0
        );
        assert!(receiver.try_recv().is_err());
        for _ in 0..3 {
            enqueue(
                &sender,
                (0..20).map(|_| {
                    Url::parse(&format!(
                        "{}://auth/google?code=synthetic&state=synthetic",
                        kalcode_contracts::identity::URL_SCHEME
                    ))
                    .unwrap()
                }),
            );
        }
        let mut queued = 0;
        while receiver.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, MAX_QUEUED_CALLBACKS);
    }

    #[test]
    fn warm_callbacks_restore_only_after_an_auth_url_is_queued() {
        let (sender, mut receiver) = channel(1);
        let restores = Cell::new(0);
        enqueue_warm(
            &sender,
            [Url::parse("https://attacker.example/callback").unwrap()],
            || restores.set(restores.get() + 1),
        );
        assert_eq!(restores.get(), 0);

        let callback = Url::parse(&format!(
            "{}://auth/google?code=synthetic&state=synthetic",
            kalcode_contracts::identity::URL_SCHEME
        ))
        .unwrap();
        enqueue_warm(&sender, [callback.clone()], || {
            restores.set(restores.get() + 1);
        });
        assert_eq!(restores.get(), 1);

        // A full queue did not admit this callback, so it must not claim foreground authority.
        enqueue_warm(&sender, [callback], || {
            restores.set(restores.get() + 1);
        });
        assert_eq!(restores.get(), 1);
        assert!(receiver.try_recv().is_ok());
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn cold_and_warm_duplicates_are_both_left_for_one_use_account_authority() {
        let (sender, mut receiver) = channel(2);
        let callback = Url::parse(&format!(
            "{}://auth/google?code=synthetic&state=synthetic",
            kalcode_contracts::identity::URL_SCHEME
        ))
        .unwrap();
        assert_eq!(enqueue(&sender, [callback.clone()]), 1);
        enqueue_warm(&sender, [callback], || {});
        assert_eq!(
            receiver.try_recv().expect("cold callback"),
            receiver.try_recv().expect("warm callback")
        );
        assert!(receiver.try_recv().is_err());
    }

    #[test]
    fn offline_reconnect_backoff_is_prompt_and_bounded_without_changing_ready_renewal() {
        assert_eq!(
            renewal_retry_interval(AccountPhase::OfflineGrace, 0),
            Duration::from_secs(30)
        );
        assert_eq!(
            renewal_retry_interval(AccountPhase::OfflineGrace, 1),
            Duration::from_secs(30)
        );
        assert_eq!(
            renewal_retry_interval(AccountPhase::OfflineGrace, 2),
            Duration::from_secs(60)
        );
        assert_eq!(
            renewal_retry_interval(AccountPhase::OfflineGrace, 100),
            Duration::from_secs(5 * 60)
        );
        assert_eq!(
            renewal_retry_interval(AccountPhase::Ready, 100),
            RENEWAL_RETRY_INTERVAL
        );
    }
}
