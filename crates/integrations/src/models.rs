use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IntegrationKind {
    RemoteMcp,
    CustomApi,
    SecureMcpTunnel,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    Read,
    Sensitive,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Surface {
    Code,
    Kalvoice,
    Brainstorm,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ToolScope {
    pub workspace_id: String,
    pub surface: Surface,
    pub session_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccessGrant {
    pub workspace_id: String,
    pub surface: Surface,
    pub session_id: String,
    pub tool_names: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CustomTool {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub method: String,
    pub path: String,
    pub risk: Risk,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
    pub risk: Risk,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IntegrationInput {
    pub id: Option<String>,
    pub name: String,
    pub kind: IntegrationKind,
    pub endpoint: String,
    #[serde(default)]
    pub tools: Vec<CustomTool>,
    #[serde(default)]
    pub trusted_read_tools: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    Unknown,
    Healthy,
    Offline,
    AuthExpired,
    Error,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Integration {
    pub id: String,
    pub name: String,
    pub kind: IntegrationKind,
    pub endpoint: String,
    pub connected: bool,
    pub health: Health,
    pub status_message: String,
    pub capabilities: Vec<ToolDefinition>,
    pub grants: Vec<AccessGrant>,
    pub revision: u64,
    pub last_checked_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DiscoveredTool {
    pub integration_id: String,
    pub integration_name: String,
    #[serde(flatten)]
    pub tool: ToolDefinition,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApprovalRequest {
    pub id: String,
    pub integration_id: String,
    pub integration_name: String,
    pub tool_name: String,
    pub scope: ToolScope,
    /// Safe preview only. Exact arguments remain internal and cannot be modified by approval.
    pub arguments_preview: Value,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum CallOutcome {
    ApprovalRequired { approval: ApprovalRequest },
    Completed { result: ToolResult },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolResult {
    pub integration_id: String,
    pub tool_name: String,
    /// Always "untrusted_external_data"; keep in tool-result channel, never system instructions.
    pub trust: String,
    /// No automatic Unified Memory persistence. Source results expire with access grants.
    pub persist_to_memory: bool,
    pub content: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OAuthConfig {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub client_id: String,
    pub scopes: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OAuthStart {
    pub authorization_url: String,
    pub state: String,
    pub expires_at_ms: u64,
}
