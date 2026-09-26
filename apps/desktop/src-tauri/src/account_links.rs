//! Native-only OAuth callback delivery. URLs remain in bounded memory and never enter logs.

use std::sync::Arc;

use tauri::async_runtime::{Sender, channel};
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

use crate::account::runtime::AccountRuntime;
use crate::runtime_coordinator::{AccountMutation, RuntimeCoordinator};

const MAX_CALLBACK_BYTES: usize = 8_192;
const MAX_QUEUED_CALLBACKS: usize = 8;

fn enqueue(sender: &Sender<String>, urls: impl IntoIterator<Item = Url>) {
    for url in urls.into_iter().take(MAX_QUEUED_CALLBACKS) {
        // This is only an admission bound. The account owner validates the full callback and
        // its durable provider/state/PKCE/nonce binding before it can change account authority.
        if url.as_str().len() <= MAX_CALLBACK_BYTES
            && url.scheme() == "kalcode"
            && url.host_str() == Some("auth")
        {
            let _ = sender.try_send(url.into());
        }
    }
}

pub fn start(
    app: &tauri::AppHandle,
    account: Arc<AccountRuntime>,
    coordinator: Arc<RuntimeCoordinator>,
) {
    let (sender, mut receiver) = channel(MAX_QUEUED_CALLBACKS);
    let warm_sender = sender.clone();
    app.deep_link().on_open_url(move |event| {
        enqueue(&warm_sender, event.urls());
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

    #[test]
    fn callbacks_are_bounded_and_foreign_destinations_never_enter_the_queue() {
        let (sender, mut receiver) = channel(MAX_QUEUED_CALLBACKS);
        enqueue(
            &sender,
            [
                Url::parse("https://auth/google?code=synthetic").unwrap(),
                Url::parse("kalcode://other/google?code=synthetic").unwrap(),
                Url::parse(&format!(
                    "kalcode://auth/google?code={}",
                    "x".repeat(MAX_CALLBACK_BYTES)
                ))
                .unwrap(),
            ],
        );
        assert!(receiver.try_recv().is_err());
        for _ in 0..3 {
            enqueue(
                &sender,
                (0..20).map(|_| {
                    Url::parse("kalcode://auth/google?code=synthetic&state=synthetic").unwrap()
                }),
            );
        }
        let mut queued = 0;
        while receiver.try_recv().is_ok() {
            queued += 1;
        }
        assert_eq!(queued, MAX_QUEUED_CALLBACKS);
    }
}
