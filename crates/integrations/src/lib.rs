//! Canonical, provider-independent external-tool authority.
//! Management/approval methods belong only to trusted application UI; never register them as model tools.
mod models;
mod transport;
pub use models::*;

use kalcode_secure_store::{SecretKey, SecretStore, SecretString};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use transport::Transport;

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("Integration not found. Connect it again.")]
    NotFound,
    #[error("This session does not have access to that tool. Update access in Integrations.")]
    AccessDenied,
    #[error("Authentication expired or rejected. Reconnect this integration.")]
    Authentication,
    #[error("Server unavailable. Check the endpoint and retry.")]
    Offline,
    #[error("External service timed out. Check its status before retrying a write.")]
    Timeout,
    #[error("External service returned HTTP {0}. Check provider status and permissions.")]
    RemoteStatus(u16),
    #[error("Server returned an unsupported MCP response. Verify the Streamable HTTP endpoint.")]
    Protocol,
    #[error("Response exceeds the 1 MiB safety limit. Request a smaller result.")]
    ResponseTooLarge,
    #[error("Approval expired, was already used, or does not match this exact request.")]
    ApprovalInvalid,
    #[error("Integration changed during this operation. Retry with its current configuration.")]
    Changed,
    #[error("Secure MCP Tunnel requires the OpenAI Responses adapter.")]
    TunnelAdapterRequired,
    #[error(
        "Secure credential storage is unavailable. Unlock the operating system credential store and reconnect."
    )]
    CredentialStore,
    #[error("Integration storage is unavailable. Restart KalCode and retry.")]
    Storage,
}

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    view: Integration,
    tools: Vec<CustomTool>,
    trusted_read_tools: Vec<String>,
}
struct Approval {
    view: ApprovalRequest,
    arguments: Value,
    revision: u64,
    approved: bool,
}
struct OAuthPending {
    integration_id: String,
    revision: u64,
    config: OAuthConfig,
    redirect_uri: String,
    verifier: SecretString,
    expires_at_ms: u64,
}
struct State {
    db: Connection,
    approvals: HashMap<String, Approval>,
    oauth: HashMap<String, OAuthPending>,
}
pub struct IntegrationBroker {
    state: Mutex<State>,
    secrets: Arc<dyn SecretStore>,
    authority: Arc<dyn Fn() -> bool + Send + Sync>,
    connection_limit: Arc<dyn Fn() -> Option<kalcode_core::plans::PlanLimit> + Send + Sync>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn key(id: &str) -> Result<SecretKey> {
    SecretKey::new(format!("integration:{id}")).map_err(|_| Error::CredentialStore)
}
fn schema_valid(schema: &Value) -> Result<()> {
    // Network/file references are never resolved. Restrict schemas to local, bounded definitions.
    fn refs(value: &Value, depth: usize) -> bool {
        if depth > 32 {
            return false;
        }
        match value {
            Value::Object(map) => map.iter().all(|(k, v)| {
                !matches!(k.as_str(), "$id" | "$dynamicRef" | "$recursiveRef")
                    && (k != "$ref" || v.as_str().is_some_and(|r| r.starts_with("#/")))
                    && refs(v, depth + 1)
            }),
            Value::Array(a) => a.iter().all(|v| refs(v, depth + 1)),
            _ => true,
        }
    }
    if schema.to_string().len() > 32_768 || !refs(schema, 0) || schema["type"] != "object" {
        return Err(Error::Invalid(
            "Tool schemas must be bounded object schemas with local references only.".into(),
        ));
    }
    jsonschema::validator_for(schema)
        .map_err(|_| Error::Invalid("Invalid tool JSON schema.".into()))?;
    Ok(())
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}
fn valid_scope(scope: &ToolScope) -> bool {
    [&scope.workspace_id, &scope.session_id].iter().all(|s| {
        !s.is_empty() && s.len() <= 256 && !s.contains('*') && !s.chars().any(char::is_control)
    })
}
fn granted(record: &Record, scope: &ToolScope, name: &str) -> bool {
    record.view.connected
        && valid_scope(scope)
        && record.view.grants.iter().any(|g| {
            g.workspace_id == scope.workspace_id
                && g.surface == scope.surface
                && g.session_id == scope.session_id
                && g.tool_names.iter().any(|n| n == name)
        })
}
fn read_record(db: &Connection, id: &str) -> Result<Record> {
    let text: String = db
        .query_row("SELECT document FROM integrations WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .map_err(|e| {
            if matches!(e, rusqlite::Error::QueryReturnedNoRows) {
                Error::NotFound
            } else {
                Error::Storage
            }
        })?;
    serde_json::from_str(&text).map_err(|_| Error::Storage)
}
fn write_record(db: &Connection, record: &Record) -> Result<()> {
    let text = serde_json::to_string(record).map_err(|_| Error::Storage)?;
    db.execute("INSERT INTO integrations(id,document) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET document=excluded.document", params![record.view.id, text]).map_err(|_| Error::Storage)?;
    Ok(())
}

impl IntegrationBroker {
    /// Native host supplies the current verified plan. Checked inside the storage lock so
    /// concurrent saves and OAuth reconnects cannot overbook the allowance.
    pub fn with_connection_limit(
        mut self,
        limit: Arc<dyn Fn() -> Option<kalcode_core::plans::PlanLimit> + Send + Sync>,
    ) -> Self {
        self.connection_limit = limit;
        self
    }

    fn admit_connection(&self, db: &Connection, existing: Option<&Record>) -> Result<()> {
        if existing.is_some_and(|r| r.view.connected) {
            return Ok(());
        }
        let Some(limit) = (self.connection_limit)() else {
            return Ok(());
        };
        let count: i64 = db.query_row(
            "SELECT COUNT(*) FROM integrations WHERE json_extract(document, '$.view.connected') = 1", [], |row| row.get(0)
        ).map_err(|_| Error::Storage)?;
        limit
            .admit(count)
            .map_err(|error| Error::Invalid(error.message))
    }

    /// Bind the broker to the active account lifetime. Revocation is checked again after awaits.
    pub fn with_authority(mut self, authority: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        self.authority = authority;
        self
    }
    fn check_authority(&self) -> Result<()> {
        if (self.authority)() {
            Ok(())
        } else {
            Err(Error::AccessDenied)
        }
    }
    /// Begin an explicit user OAuth connection. Native host binds the loopback listener first;
    /// the browser receives S256 challenge only, never the verifier or resulting token.
    pub fn begin_oauth(
        &self,
        id: &str,
        config: OAuthConfig,
        redirect_uri: &str,
    ) -> Result<OAuthStart> {
        self.check_authority()?;
        use base64::Engine;
        use sha2::Digest;
        let mut authorization = transport::validate_endpoint(&config.authorization_endpoint)?;
        transport::validate_endpoint(&config.token_endpoint)?;
        let redirect = url::Url::parse(redirect_uri)
            .map_err(|_| Error::Invalid("Invalid OAuth callback.".into()))?;
        if redirect.scheme() != "http"
            || redirect.host_str() != Some("127.0.0.1")
            || redirect.port().is_none()
            || redirect.path() != "/callback"
            || !redirect.username().is_empty()
            || redirect.password().is_some()
            || redirect.query().is_some()
            || redirect.fragment().is_some()
        {
            return Err(Error::Invalid(
                "OAuth requires the app's temporary loopback callback.".into(),
            ));
        }
        if config.client_id.is_empty()
            || config.client_id.len() > 512
            || config.client_id.chars().any(char::is_control)
            || config.scopes.len() > 50
            || config
                .scopes
                .iter()
                .any(|s| s.len() > 256 || s.chars().any(char::is_whitespace))
        {
            return Err(Error::Invalid("Invalid OAuth client ID or scope.".into()));
        }
        let mut state = self.state.lock().map_err(|_| Error::Storage)?;
        state.oauth.retain(|_, p| p.expires_at_ms > now());
        if state.oauth.len() >= 8 {
            return Err(Error::Invalid(
                "Finish the current sign-in before starting another.".into(),
            ));
        }
        let record = read_record(&state.db, id)?;
        self.admit_connection(&state.db, Some(&record))?;
        // Reconnect uses saved configuration but never silently re-enables old grants.
        let oauth_state = format!(
            "{}{}",
            uuid::Uuid::now_v7().simple(),
            uuid::Uuid::now_v7().simple()
        );
        let verifier = SecretString::new(format!(
            "{}{}",
            uuid::Uuid::now_v7().simple(),
            uuid::Uuid::now_v7().simple()
        ));
        let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(sha2::Sha256::digest(verifier.expose_secret().as_bytes()));
        authorization
            .query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", &config.client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("scope", &config.scopes.join(" "))
            .append_pair("state", &oauth_state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        let expires_at_ms = now() + 180_000;
        state.oauth.insert(
            oauth_state.clone(),
            OAuthPending {
                integration_id: id.into(),
                revision: record.view.revision,
                config,
                redirect_uri: redirect_uri.into(),
                verifier,
                expires_at_ms,
            },
        );
        Ok(OAuthStart {
            authorization_url: authorization.into(),
            state: oauth_state,
            expires_at_ms,
        })
    }

    pub fn cancel_oauth(&self, oauth_state: &str) -> Result<()> {
        self.state
            .lock()
            .map_err(|_| Error::Storage)?
            .oauth
            .remove(oauth_state);
        Ok(())
    }

    /// Single-use callback. Codes and verifier never enter persistent metadata or model context.
    pub async fn complete_oauth(&self, oauth_state: &str, code: &str) -> Result<Integration> {
        self.check_authority()?;
        let pending = self
            .state
            .lock()
            .map_err(|_| Error::Storage)?
            .oauth
            .remove(oauth_state)
            .ok_or(Error::Authentication)?;
        if pending.expires_at_ms <= now()
            || code.is_empty()
            || code.len() > 4096
            || code.chars().any(char::is_control)
        {
            return Err(Error::Authentication);
        }
        let record = self.record(&pending.integration_id)?;
        if record.view.revision != pending.revision {
            return Err(Error::Changed);
        }
        let transport = Transport::new(&pending.config.token_endpoint, None)
            .await?
            .with_authority(self.authority.clone());
        let token = transport
            .exchange_code(
                &pending.config.client_id,
                code,
                &pending.redirect_uri,
                pending.verifier.expose_secret(),
            )
            .await?;
        let mut state = self.state.lock().map_err(|_| Error::Storage)?;
        let mut current = read_record(&state.db, &pending.integration_id)?;
        self.check_authority()?;
        if current.view.revision != pending.revision {
            return Err(Error::Changed);
        }
        self.admit_connection(&state.db, Some(&current))?;
        self.secrets
            .set(&key(&pending.integration_id)?, &token)
            .map_err(|_| Error::CredentialStore)?;
        current.view.connected = true;
        current.view.health = Health::Unknown;
        current.view.status_message = "Signed in. Refresh capabilities to verify access.".into();
        current.view.grants.clear();
        current.view.revision += 1;
        write_record(&state.db, &current)?;
        state
            .approvals
            .retain(|_, a| a.view.integration_id != pending.integration_id);
        Ok(current.view)
    }

    pub fn open(path: PathBuf, secrets: Arc<dyn SecretStore>) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|_| Error::Storage)?;
        }
        let db = Connection::open(path).map_err(|_| Error::Storage)?;
        db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS integrations(id TEXT PRIMARY KEY,document TEXT NOT NULL);").map_err(|_| Error::Storage)?;
        Ok(Self {
            state: Mutex::new(State {
                db,
                approvals: HashMap::new(),
                oauth: HashMap::new(),
            }),
            secrets,
            authority: Arc::new(|| true),
            connection_limit: Arc::new(|| {
                kalcode_core::plans::PlanTier::Free
                    .limit(kalcode_core::plans::Limited::ExternalIntegrations)
            }),
        })
    }

    pub fn list(&self) -> Result<Vec<Integration>> {
        self.check_authority()?;
        let state = self.state.lock().map_err(|_| Error::Storage)?;
        let mut statement = state
            .db
            .prepare("SELECT document FROM integrations ORDER BY id")
            .map_err(|_| Error::Storage)?;
        let rows = statement
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|_| Error::Storage)?;
        rows.map(|r| {
            serde_json::from_str::<Record>(&r.map_err(|_| Error::Storage)?)
                .map(|r| r.view)
                .map_err(|_| Error::Storage)
        })
        .collect()
    }

    /// Trusted settings UI only; never contains the OS-stored credential.
    pub fn configuration(&self, id: &str) -> Result<IntegrationInput> {
        let record = self.record(id)?;
        Ok(IntegrationInput {
            id: Some(record.view.id),
            name: record.view.name,
            kind: record.view.kind,
            endpoint: record.view.endpoint,
            tools: record.tools,
            trusted_read_tools: record.trusted_read_tools,
        })
    }

    pub fn save(
        &self,
        input: IntegrationInput,
        credential: Option<SecretString>,
    ) -> Result<Integration> {
        self.check_authority()?;
        if input.name.trim().is_empty()
            || input.name.len() > 100
            || input.name.chars().any(char::is_control)
        {
            return Err(Error::Invalid("Choose a name of 1–100 characters.".into()));
        }
        if input.kind == IntegrationKind::SecureMcpTunnel {
            if input.endpoint.is_empty()
                || input.endpoint.len() > 200
                || !input
                    .endpoint
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            {
                return Err(Error::Invalid(
                    "Enter the tunnel ID issued by OpenAI Secure MCP Tunnel.".into(),
                ));
            }
        } else {
            transport::validate_endpoint(&input.endpoint)?;
        }
        if input.tools.len() > 100 || input.trusted_read_tools.len() > 200 {
            return Err(Error::Invalid("Too many tool definitions.".into()));
        }
        if input.kind != IntegrationKind::CustomApi && !input.tools.is_empty() {
            return Err(Error::Invalid(
                "MCP capabilities must be discovered from the server.".into(),
            ));
        }
        let mut names = std::collections::HashSet::new();
        for tool in &input.tools {
            if !valid_name(&tool.name)
                || !names.insert(tool.name.clone())
                || tool.description.len() > 1000
            {
                return Err(Error::Invalid("Tool names must be unique safe identifiers and descriptions at most 1000 characters.".into()));
            }
            schema_valid(&tool.input_schema)?;
            if tool.input_schema["additionalProperties"] != false {
                return Err(Error::Invalid(
                    "Custom tool schemas must set additionalProperties:false.".into(),
                ));
            }
            if !matches!(
                tool.method.as_str(),
                "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
            ) || (tool.risk == Risk::Read && tool.method != "GET")
            {
                return Err(Error::Invalid(
                    "Only GET operations may be marked read-only.".into(),
                ));
            }
            validate_path(&tool.path)?;
        }
        if input.trusted_read_tools.iter().any(|n| !valid_name(n)) {
            return Err(Error::Invalid("Invalid read-only tool name.".into()));
        }
        if credential.as_ref().is_some_and(|secret| {
            secret.expose_secret().is_empty()
                || secret.expose_secret().len() > 16_384
                || secret.expose_secret().chars().any(char::is_control)
        }) {
            return Err(Error::Invalid(
                "Credential must be a nonempty single-line token.".into(),
            ));
        }
        let mut state = self.state.lock().map_err(|_| Error::Storage)?;
        let old = input
            .id
            .as_deref()
            .map(|id| read_record(&state.db, id))
            .transpose()?;
        self.admit_connection(&state.db, old.as_ref())?;
        let id = old
            .as_ref()
            .map(|r| r.view.id.clone())
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        // SQLite and the OS credential store cannot share a transaction. Revoke the old
        // destination durably first, so a later credential/DB failure cannot pair a new
        // token with the previous endpoint. The final write reconnects with cleared grants.
        if let Some(previous) = &old {
            let mut revoked = previous.clone();
            revoked.view.connected = false;
            revoked.view.grants.clear();
            revoked.view.revision += 1;
            revoked.view.health = Health::Unknown;
            revoked.view.status_message =
                "Connection update incomplete. Reconnect to finish.".into();
            write_record(&state.db, &revoked)?;
            state.approvals.retain(|_, a| a.view.integration_id != id);
        }
        // Credential destinations never change silently: changing endpoint clears the old token.
        if old
            .as_ref()
            .is_some_and(|r| r.view.endpoint != input.endpoint || r.view.kind != input.kind)
        {
            self.secrets
                .delete(&key(&id)?)
                .map_err(|_| Error::CredentialStore)?;
        }
        if let Some(secret) = credential {
            self.secrets
                .set(&key(&id)?, &secret)
                .map_err(|_| Error::CredentialStore)?;
        }
        let capabilities = input
            .tools
            .iter()
            .map(|t| ToolDefinition {
                name: t.name.clone(),
                description: t.description.clone(),
                input_schema: t.input_schema.clone(),
                risk: t.risk.clone(),
            })
            .collect();
        let view = Integration {
            id: id.clone(),
            name: input.name.trim().into(),
            kind: input.kind,
            endpoint: input.endpoint,
            connected: true,
            health: Health::Unknown,
            status_message: "Connected. Check capabilities to verify service availability.".into(),
            capabilities,
            grants: Vec::new(),
            revision: old.map_or(1, |r| r.view.revision + 1),
            last_checked_ms: None,
        };
        let record = Record {
            view: view.clone(),
            tools: input.tools,
            trusted_read_tools: input.trusted_read_tools,
        };
        write_record(&state.db, &record)?;
        state.approvals.retain(|_, a| a.view.integration_id != id);
        Ok(view)
    }

    pub fn disconnect(&self, id: &str) -> Result<()> {
        self.check_authority()?;
        let mut state = self.state.lock().map_err(|_| Error::Storage)?;
        let mut record = read_record(&state.db, id)?;
        record.view.connected = false;
        record.view.grants.clear();
        record.view.capabilities.clear();
        record.view.revision += 1;
        record.view.health = Health::Unknown;
        record.view.status_message = "Disconnected. Reconnect to use its tools.".into();
        write_record(&state.db, &record)?;
        state.approvals.retain(|_, a| a.view.integration_id != id);
        self.secrets
            .delete(&key(id)?)
            .map_err(|_| Error::CredentialStore)?;
        Ok(())
    }
    pub fn rename(&self, id: &str, name: &str) -> Result<Integration> {
        self.check_authority()?;
        if name.trim().is_empty() || name.len() > 100 || name.chars().any(char::is_control) {
            return Err(Error::Invalid("Choose a name of 1–100 characters.".into()));
        }
        let state = self.state.lock().map_err(|_| Error::Storage)?;
        let mut record = read_record(&state.db, id)?;
        record.view.name = name.trim().into();
        write_record(&state.db, &record)?;
        Ok(record.view)
    }
    pub fn set_grants(&self, id: &str, grants: Vec<AccessGrant>) -> Result<Integration> {
        self.check_authority()?;
        let mut state = self.state.lock().map_err(|_| Error::Storage)?;
        let mut record = read_record(&state.db, id)?;
        if !record.view.connected {
            return Err(Error::AccessDenied);
        }
        if grants.len() > 200 {
            return Err(Error::Invalid("Too many access grants.".into()));
        }
        for grant in &grants {
            if !valid_scope(&ToolScope {
                workspace_id: grant.workspace_id.clone(),
                surface: grant.surface.clone(),
                session_id: grant.session_id.clone(),
            }) || grant.tool_names.len() > 200
                || grant
                    .tool_names
                    .iter()
                    .any(|n| !record.view.capabilities.iter().any(|t| &t.name == n))
            {
                return Err(Error::Invalid(
                    "Grant exact workspace, session and discovered tool names.".into(),
                ));
            }
        }
        record.view.grants = grants;
        record.view.revision += 1;
        write_record(&state.db, &record)?;
        state.approvals.retain(|_, a| a.view.integration_id != id);
        Ok(record.view)
    }
    pub fn discover(&self, scope: &ToolScope, query: &str) -> Result<Vec<DiscoveredTool>> {
        if !valid_scope(scope) {
            return Err(Error::AccessDenied);
        }
        let terms: Vec<String> = query
            .split_whitespace()
            .take(8)
            .map(str::to_lowercase)
            .collect();
        let mut result = Vec::new();
        for view in self.list()? {
            let record = self.record(&view.id)?;
            for tool in &view.capabilities {
                let text =
                    format!("{} {} {}", view.name, tool.name, tool.description).to_lowercase();
                if granted(&record, scope, &tool.name)
                    && (terms.is_empty() || terms.iter().any(|t| text.contains(t)))
                {
                    result.push(DiscoveredTool {
                        integration_id: view.id.clone(),
                        integration_name: view.name.clone(),
                        tool: tool.clone(),
                    });
                    if result.len() == 24 {
                        return Ok(result);
                    }
                }
            }
        }
        Ok(result)
    }
    fn record(&self, id: &str) -> Result<Record> {
        self.check_authority()?;
        read_record(&self.state.lock().map_err(|_| Error::Storage)?.db, id)
    }
    pub fn credential(&self, id: &str) -> Result<Option<SecretString>> {
        if !self.record(id)?.view.connected {
            return Err(Error::AccessDenied);
        }
        let credential = self
            .secrets
            .get(&key(id)?)
            .map_err(|_| Error::CredentialStore)?;
        self.check_authority()?;
        Ok(credential)
    }

    pub async fn refresh(&self, id: &str) -> Result<Integration> {
        let record = self.record(id)?;
        if !record.view.connected {
            return Err(Error::AccessDenied);
        }
        if record.view.kind == IntegrationKind::SecureMcpTunnel {
            return Err(Error::TunnelAdapterRequired);
        }
        if record.view.kind == IntegrationKind::CustomApi {
            // No unsolicited API call: metadata validation is not proof that credentials or service work.
            return Ok(record.view);
        }
        let discovery = async {
            let credential = self.credential(id)?;
            let transport = Transport::new(&record.view.endpoint, credential.clone())
                .await?
                .with_authority(self.authority.clone());
            let current = self.record(id)?;
            if !current.view.connected || current.view.revision != record.view.revision {
                return Err(Error::Changed);
            }
            let session = transport.initialize().await?;
            let mut cursor: Option<String> = None;
            let mut tools = Vec::new();
            for page in 0..10u64 {
                let current = self.record(id)?;
                if !current.view.connected || current.view.revision != record.view.revision {
                    return Err(Error::Changed);
                }
                let params = cursor.as_ref().map_or(json!({}), |c| json!({"cursor":c}));
                let (result, _) = transport
                    .rpc("tools/list", params, Some(page + 2), session.as_deref())
                    .await?;
                let result = redact_metadata(result, credential.as_ref());
                for value in result["tools"].as_array().ok_or(Error::Protocol)? {
                    let name = value["name"].as_str().ok_or(Error::Protocol)?.to_owned();
                    let input_schema = value["inputSchema"].clone();
                    schema_valid(&input_schema)?;
                    if !valid_name(&name)
                        || tools.iter().any(|t: &ToolDefinition| t.name == name)
                        || tools.len() >= 200
                    {
                        return Err(Error::Protocol);
                    }
                    let description = value["description"]
                        .as_str()
                        .unwrap_or("")
                        .chars()
                        .take(1000)
                        .collect();
                    let risk = if record.trusted_read_tools.contains(&name) {
                        Risk::Read
                    } else {
                        Risk::Sensitive
                    };
                    tools.push(ToolDefinition {
                        name,
                        description,
                        input_schema,
                        risk,
                    });
                }
                cursor = result
                    .get("nextCursor")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                if cursor.is_none() {
                    return Ok(tools);
                }
                if cursor.as_ref().is_some_and(|c| c.len() > 2048) {
                    return Err(Error::Protocol);
                }
            }
            Err(Error::Invalid(
                "MCP capability discovery exceeded 10 pages.".into(),
            ))
        }
        .await;
        match discovery {
            Ok(tools) => self.record_capabilities(id, record.view.revision, tools),
            Err(error) => {
                self.record_health(id, record.view.revision, Some(&error))?;
                Err(error)
            }
        }
    }

    fn record_capabilities(
        &self,
        id: &str,
        revision: u64,
        mut tools: Vec<ToolDefinition>,
    ) -> Result<Integration> {
        self.check_authority()?;
        let mut state = self.state.lock().map_err(|_| Error::Storage)?;
        let mut record = read_record(&state.db, id)?;
        if !record.view.connected || record.view.revision != revision {
            return Err(Error::Changed);
        }
        for tool in &mut tools {
            schema_valid(&tool.input_schema)?;
            if !valid_name(&tool.name) {
                return Err(Error::Protocol);
            }
            tool.risk = if record.trusted_read_tools.contains(&tool.name) {
                Risk::Read
            } else {
                Risk::Sensitive
            };
        }
        let changed = serde_json::to_value(&tools).ok()
            != serde_json::to_value(&record.view.capabilities).ok();
        if changed {
            record.view.revision += 1;
            // Changed schemas do not inherit permission to execute different operations.
            record.view.grants.clear();
            state.approvals.retain(|_, a| a.view.integration_id != id);
        }
        record.view.capabilities = tools;
        record.view.health = Health::Healthy;
        record.view.last_checked_ms = Some(now());
        record.view.status_message = "Connected and capabilities verified.".into();
        write_record(&state.db, &record)?;
        Ok(record.view)
    }
    fn record_health(&self, id: &str, revision: u64, error: Option<&Error>) -> Result<()> {
        self.check_authority()?;
        let state = self.state.lock().map_err(|_| Error::Storage)?;
        let mut record = read_record(&state.db, id)?;
        if !record.view.connected || record.view.revision != revision {
            return Err(Error::Changed);
        }
        record.view.health = match error {
            None => Health::Healthy,
            Some(Error::Authentication) => Health::AuthExpired,
            Some(Error::Offline | Error::Timeout) => Health::Offline,
            _ => Health::Error,
        };
        record.view.status_message = error.map_or_else(
            || "Connected. Last operation succeeded.".into(),
            ToString::to_string,
        );
        record.view.last_checked_ms = Some(now());
        write_record(&state.db, &record)
    }

    pub fn pending_approvals(&self) -> Result<Vec<ApprovalRequest>> {
        self.check_authority()?;
        let mut state = self.state.lock().map_err(|_| Error::Storage)?;
        state.approvals.retain(|_, a| a.view.expires_at_ms > now());
        Ok(state
            .approvals
            .values()
            .filter(|a| !a.approved)
            .map(|a| a.view.clone())
            .collect())
    }
    /// Trusted UI only. Calling this never executes the operation; an exact request must resume.
    pub fn approve(&self, id: &str) -> Result<()> {
        self.check_authority()?;
        let mut state = self.state.lock().map_err(|_| Error::Storage)?;
        let a = state.approvals.get_mut(id).ok_or(Error::ApprovalInvalid)?;
        if a.view.expires_at_ms <= now() || a.approved {
            return Err(Error::ApprovalInvalid);
        }
        a.approved = true;
        Ok(())
    }
    pub fn deny(&self, id: &str) -> Result<()> {
        self.state
            .lock()
            .map_err(|_| Error::Storage)?
            .approvals
            .remove(id);
        Ok(())
    }

    /// Authorization for provider-hosted tunnel calls. The adapter must honor returned approval
    /// and pass only actual approved arguments to the provider; approval IDs are single-use.
    pub fn authorize_external(
        &self,
        scope: ToolScope,
        integration_id: String,
        tool_name: String,
        arguments: Value,
        approval_id: Option<String>,
    ) -> Result<Option<ApprovalRequest>> {
        self.authorize(
            &scope,
            &integration_id,
            &tool_name,
            &arguments,
            approval_id.as_deref(),
        )
        .map(|(_, a)| a)
    }
    fn authorize(
        &self,
        scope: &ToolScope,
        id: &str,
        name: &str,
        args: &Value,
        approval_id: Option<&str>,
    ) -> Result<(Record, Option<ApprovalRequest>)> {
        self.check_authority()?;
        if args.to_string().len() > 64 * 1024 {
            return Err(Error::Invalid("Tool arguments exceed 64 KiB.".into()));
        }
        let mut state = self.state.lock().map_err(|_| Error::Storage)?;
        let record = read_record(&state.db, id)?;
        if !granted(&record, scope, name) {
            return Err(Error::AccessDenied);
        }
        let tool = record
            .view
            .capabilities
            .iter()
            .find(|t| t.name == name)
            .ok_or(Error::AccessDenied)?;
        let validator =
            jsonschema::validator_for(&tool.input_schema).map_err(|_| Error::Protocol)?;
        if !validator.is_valid(args) {
            return Err(Error::Invalid(
                "Tool arguments do not match its supported schema.".into(),
            ));
        }
        if tool.risk == Risk::Read {
            return Ok((record, None));
        }
        state.approvals.retain(|_, a| a.view.expires_at_ms > now());
        if let Some(approval_id) = approval_id {
            // Remove even on mismatch: an attacker cannot probe/reuse the same approval.
            let a = state
                .approvals
                .remove(approval_id)
                .ok_or(Error::ApprovalInvalid)?;
            if !a.approved
                || a.revision != record.view.revision
                || a.view.scope != *scope
                || a.view.integration_id != id
                || a.view.tool_name != name
                || a.arguments != *args
            {
                return Err(Error::ApprovalInvalid);
            }
            return Ok((record, None));
        }
        if state.approvals.len() >= 100 {
            return Err(Error::Invalid(
                "Review pending integration approvals before requesting more.".into(),
            ));
        }
        let preview = redact(
            args.clone(),
            self.secrets
                .get(&key(id)?)
                .map_err(|_| Error::CredentialStore)?
                .as_ref(),
        );
        let request = ApprovalRequest {
            id: uuid::Uuid::now_v7().to_string(),
            integration_id: id.into(),
            integration_name: record.view.name.clone(),
            tool_name: name.into(),
            scope: scope.clone(),
            arguments_preview: preview,
            expires_at_ms: now() + 5 * 60 * 1000,
        };
        state.approvals.insert(
            request.id.clone(),
            Approval {
                view: request.clone(),
                arguments: args.clone(),
                revision: record.view.revision,
                approved: false,
            },
        );
        Ok((record, Some(request)))
    }

    pub async fn call(
        &self,
        scope: ToolScope,
        integration_id: String,
        tool_name: String,
        arguments: Value,
        approval_id: Option<String>,
    ) -> Result<CallOutcome> {
        self.call_guarded(
            scope,
            integration_id,
            tool_name,
            arguments,
            approval_id,
            Arc::new(|| true),
        )
        .await
    }
    pub async fn call_guarded(
        &self,
        scope: ToolScope,
        integration_id: String,
        tool_name: String,
        arguments: Value,
        approval_id: Option<String>,
        guard: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<CallOutcome> {
        let authority = self.authority.clone();
        let authority: Arc<dyn Fn() -> bool + Send + Sync> =
            Arc::new(move || authority() && guard());
        if !authority() {
            return Err(Error::AccessDenied);
        }
        let (record, approval) = self.authorize(
            &scope,
            &integration_id,
            &tool_name,
            &arguments,
            approval_id.as_deref(),
        )?;
        if let Some(approval) = approval {
            return Ok(CallOutcome::ApprovalRequired { approval });
        }
        if record.view.kind == IntegrationKind::SecureMcpTunnel {
            return Err(Error::TunnelAdapterRequired);
        }
        let result = async {
            let credential = self.credential(&integration_id)?;
            let transport = Transport::new(&record.view.endpoint, credential.clone())
                .await?
                .with_authority(authority.clone());
            // Recheck revocation after DNS/network setup, immediately before dispatch.
            let current = self.record(&integration_id)?;
            if current.view.revision != record.view.revision
                || !granted(&current, &scope, &tool_name)
            {
                return Err(Error::Changed);
            }
            let content = if record.view.kind == IntegrationKind::RemoteMcp {
                let session = transport.initialize().await?;
                let current = self.record(&integration_id)?;
                if current.view.revision != record.view.revision
                    || !granted(&current, &scope, &tool_name)
                {
                    return Err(Error::Changed);
                }
                let (value, _) = transport
                    .rpc(
                        "tools/call",
                        json!({"name":tool_name,"arguments":arguments}),
                        Some(2),
                        session.as_deref(),
                    )
                    .await?;
                value
            } else {
                let tool = record
                    .tools
                    .iter()
                    .find(|t| t.name == tool_name)
                    .ok_or(Error::AccessDenied)?;
                let mut url = transport
                    .endpoint()
                    .join(&tool.path)
                    .map_err(|_| Error::Protocol)?;
                let method = reqwest::Method::from_bytes(tool.method.as_bytes())
                    .map_err(|_| Error::Protocol)?;
                let body = if method == reqwest::Method::GET {
                    let object = arguments.as_object().ok_or(Error::Protocol)?;
                    for (key, value) in object {
                        if value.is_object() || value.is_array() {
                            return Err(Error::Invalid(
                                "GET query arguments must be scalar values.".into(),
                            ));
                        }
                        let value = value
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| value.to_string());
                        url.query_pairs_mut().append_pair(key, &value);
                    }
                    None
                } else {
                    Some(&arguments)
                };
                transport.request(method, url, body, None, None).await?.0
            };
            Ok(redact(content, credential.as_ref()))
        }
        .await;
        self.finish_call(integration_id, tool_name, record.view.revision, result)
    }

    /// Records health for a dispatched call and returns its real outcome. The remote side effect
    /// has already happened, so a health-write failure (the integration's revision moved while the
    /// call was in flight, e.g. grants were saved) must never turn a completed call into an error:
    /// that would tell the agent to retry a write that already ran.
    fn finish_call(
        &self,
        integration_id: String,
        tool_name: String,
        revision: u64,
        result: Result<Value>,
    ) -> Result<CallOutcome> {
        match result {
            Ok(content) => {
                let _ = self.record_health(&integration_id, revision, None);
                Ok(CallOutcome::Completed {
                    result: ToolResult {
                        integration_id,
                        tool_name,
                        trust: "untrusted_external_data".into(),
                        persist_to_memory: false,
                        content,
                    },
                })
            }
            Err(error) => {
                let _ = self.record_health(&integration_id, revision, Some(&error));
                Err(error)
            }
        }
    }

    pub fn record_tunnel_discovery(
        &self,
        id: &str,
        tools: Vec<ToolDefinition>,
    ) -> Result<Integration> {
        let record = self.record(id)?;
        if record.view.kind != IntegrationKind::SecureMcpTunnel || tools.len() > 200 {
            return Err(Error::Invalid("Invalid tunnel discovery.".into()));
        }
        self.record_tunnel_discovery_if_revision(id, record.view.revision, tools)
    }
    pub fn record_tunnel_discovery_if_revision(
        &self,
        id: &str,
        revision: u64,
        tools: Vec<ToolDefinition>,
    ) -> Result<Integration> {
        let record = self.record(id)?;
        if record.view.kind != IntegrationKind::SecureMcpTunnel || tools.len() > 200 {
            return Err(Error::Invalid("Invalid tunnel discovery.".into()));
        }
        let credential = self.credential(id)?;
        let tools: Vec<ToolDefinition> = serde_json::from_value(redact_metadata(
            serde_json::to_value(tools).map_err(|_| Error::Protocol)?,
            credential.as_ref(),
        ))
        .map_err(|_| Error::Protocol)?;
        self.record_capabilities(id, revision, tools)
    }
    pub fn record_external_health(
        &self,
        id: &str,
        revision: u64,
        error: Option<&Error>,
    ) -> Result<Integration> {
        self.record_health(id, revision, error)?;
        Ok(self.record(id)?.view)
    }
    pub fn prepare_tunnel(&self, scope: &ToolScope, id: &str) -> Result<Integration> {
        let record = self.record(id)?;
        if record.view.kind != IntegrationKind::SecureMcpTunnel
            || !record.view.connected
            || !valid_scope(scope)
        {
            return Err(Error::AccessDenied);
        }
        let mut view = record.view.clone();
        view.capabilities
            .retain(|t| granted(&record, scope, &t.name));
        if view.capabilities.is_empty() {
            return Err(Error::AccessDenied);
        }
        Ok(view)
    }
}

fn validate_path(path: &str) -> Result<()> {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.len() > 2000
        || path.contains(['?', '#', '\\', '%'])
        || path.split('/').any(|s| s == ".." || s == ".")
        || path.chars().any(char::is_control)
    {
        return Err(Error::Invalid(
            "Tool paths must be fixed absolute paths without queries, escapes or traversal.".into(),
        ));
    }
    Ok(())
}

/// Metadata contains schema property names such as `token`; preserve schema structure while
/// scrubbing scalar text. Applying the tool-result key redactor would corrupt valid schemas.
fn redact_metadata(mut value: Value, credential: Option<&SecretString>) -> Value {
    fn walk(value: &mut Value, credential: Option<&SecretString>) {
        match value {
            Value::Object(map) => {
                for value in map.values_mut() {
                    walk(value, credential);
                }
            }
            Value::Array(array) => {
                for value in array {
                    walk(value, credential);
                }
            }
            Value::String(_) => *value = redact(value.clone(), credential),
            _ => {}
        }
    }
    walk(&mut value, credential);
    value
}

/// Redact named credentials and the exact credential used for this request. Do not log raw data.
pub fn redact(mut value: Value, credential: Option<&SecretString>) -> Value {
    fn walk(value: &mut Value, secret: Option<&str>) {
        match value {
            Value::Object(map) => {
                for (key, value) in map {
                    let normalized = key.to_lowercase().replace(['-', '_'], "");
                    if [
                        "password",
                        "secret",
                        "token",
                        "authorization",
                        "apikey",
                        "cookie",
                        "credential",
                        "privatekey",
                    ]
                    .iter()
                    .any(|k| normalized.contains(k))
                    {
                        *value = json!("[REDACTED]");
                    } else {
                        walk(value, secret);
                    }
                }
            }
            Value::Array(a) => {
                for v in a {
                    walk(v, secret);
                }
            }
            Value::String(s) => {
                if let Some(secret) = secret.filter(|s| !s.is_empty()) {
                    *s = s.replace(secret, "[REDACTED]");
                }
                *s = kalcode_core::redact::redact_log_line(s).into_owned();
            }
            _ => {}
        }
    }
    walk(&mut value, credential.map(SecretString::expose_secret));
    value
}

#[cfg(test)]
mod tests;
