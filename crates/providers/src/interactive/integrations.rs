//! Native-injected MCP access for a single real coding session. Remote credentials never
//! enter the provider process; its ephemeral bearer can only use this session's grants.
use kalcode_contracts::agent::{ProviderError, SessionConfig};
use kalcode_secure_store::SecretString;

pub struct IntegrationConnection {
    pub url: String,
    pub bearer: SecretString,
    /// Revokes the session token when the provider exits or fails to start.
    pub lifetime: Box<dyn Send + Sync>,
}

pub type IntegrationConnector =
    dyn Fn(&SessionConfig) -> Result<IntegrationConnection, ProviderError> + Send + Sync;

pub const BEARER_ENV: &str = "KALCODE_INTEGRATION_SESSION";

pub fn claude_config(url: &str) -> Vec<std::ffi::OsString> {
    let config = serde_json::json!({"mcpServers":{"kalcode":{"type":"http","url":url,"headers":{"Authorization":format!("Bearer ${{{BEARER_ENV}}}")}}}});
    vec!["--mcp-config".into(), config.to_string().into()]
}

pub fn codex_config(url: &str) -> Vec<std::ffi::OsString> {
    // The URL is minted by native code, contains no secret, and is always loopback.
    vec![
        "-c".into(),
        format!("mcp_servers.kalcode.url=\"{url}\"").into(),
        "-c".into(),
        format!("mcp_servers.kalcode.bearer_token_env_var=\"{BEARER_ENV}\"").into(),
    ]
}

#[cfg(test)]
mod tests {
    #[test]
    fn config_contains_only_reference_to_ephemeral_bearer() {
        let args = super::codex_config("http://127.0.0.1:12345/mcp");
        assert_eq!(args.len(), 4);
        assert!(args[3].to_string_lossy().contains(super::BEARER_ENV));
        assert!(!args[1].to_string_lossy().contains("token="));
        let claude = super::claude_config("http://127.0.0.1:12345/mcp");
        assert!(
            claude[1]
                .to_string_lossy()
                .contains("${KALCODE_INTEGRATION_SESSION}")
        );
    }
}
