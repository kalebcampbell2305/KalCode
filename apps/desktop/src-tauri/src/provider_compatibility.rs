//! Optional signed provider policy refresh. Local capability probes remain authoritative.

use std::path::Path;
use std::time::Duration;

use kalcode_providers::compatibility::{CompatibilityStore, CompatibilityVerifier};
use serde::Deserialize;

const ENDPOINT: &str = "https://kalcoded.com/providers/v1/compatibility/stable.jws";
const PUBLIC_DOCUMENT: &str = include_str!("../../../../tooling/release/component-public-key.json");
const MAX_POLICY_BYTES: usize = 192 * 1024;
const REFRESH_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublicDocument {
    schema_version: u32,
    alg: String,
    kid: String,
    x: String,
}

fn verifier(document: &str) -> Result<CompatibilityVerifier, &'static str> {
    let key: PublicDocument = serde_json::from_str(document).map_err(|_| "invalid_trust")?;
    if key.schema_version != 1 || key.alg != "EdDSA" {
        return Err("invalid_trust");
    }
    CompatibilityVerifier::from_keys([(key.kid.as_str(), key.x.as_str())])
        .map_err(|_| "invalid_trust")
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| i64::try_from(elapsed.as_secs()).ok())
        .unwrap_or(0)
}

/// Read only bounded local signed data before launches; network refresh never gates the UI.
pub(crate) fn start(data_dir: &Path) {
    let result = verifier(PUBLIC_DOCUMENT).and_then(|verifier| {
        CompatibilityStore::open(data_dir.join("provider-compatibility"), verifier, now())
            .map_err(|_| "cache_unavailable")
    });
    let Ok(store) = result else {
        tracing::warn!(event = "provider.compatibility_policy_unavailable");
        return;
    };
    kalcode_providers::compatibility::set_active_store(store.clone());
    tauri::async_runtime::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .build()
        else {
            return;
        };
        loop {
            if let Ok(token) = fetch(&client).await {
                // Invalid, stale or unavailable remote data never replaces the verified cache.
                if store.refresh(&token, now()).is_err() {
                    tracing::debug!(event = "provider.compatibility_policy_rejected");
                }
            }
            tokio::time::sleep(REFRESH_INTERVAL).await;
        }
    });
}

async fn fetch(client: &reqwest::Client) -> Result<String, ()> {
    let mut response = client.get(ENDPOINT).send().await.map_err(|_| ())?;
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|len| len > MAX_POLICY_BYTES as u64)
    {
        return Err(());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if bytes.len().saturating_add(chunk.len()) > MAX_POLICY_BYTES {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_existing_embedded_distribution_trust_with_strict_schema() {
        assert!(verifier(PUBLIC_DOCUMENT).is_ok());
        let value: serde_json::Value = serde_json::from_str(PUBLIC_DOCUMENT).unwrap();
        for (field, replacement) in [
            ("schemaVersion", serde_json::json!(2)),
            ("alg", serde_json::json!("none")),
            ("x", serde_json::json!("invalid")),
            ("endpoint", serde_json::json!("https://untrusted.invalid")),
        ] {
            let mut changed = value.clone();
            changed[field] = replacement;
            assert!(verifier(&changed.to_string()).is_err());
        }
    }
}
