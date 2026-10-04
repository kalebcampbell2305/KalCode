//! Account-owned external tools. Only the trusted main WebView can administer connections;
//! coding providers receive a separate, scoped MCP endpoint with no administration methods.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use kalcode_core::{IpcError, KalError};
use kalcode_integration_openai::OpenAiIntegrations;
use kalcode_integrations::{
    AccessGrant, IntegrationBroker, IntegrationInput, IntegrationKind, Surface, ToolScope,
};
use kalcode_secure_store::{OsSecretStore, SecretKey, SecretStore, SecretStoreError, SecretString};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State, Webview};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::AppState;
use crate::runtime_coordinator::RuntimeState;
use crate::thread_commands::ThreadsState;

struct AccountSecrets {
    prefix: String,
}
impl AccountSecrets {
    fn key(&self, key: &SecretKey) -> Result<SecretKey, SecretStoreError> {
        let digest = Sha256::digest(key.account().as_bytes());
        SecretKey::new(format!("integration:{}:{digest:x}", self.prefix))
    }
}
impl SecretStore for AccountSecrets {
    fn backend(&self) -> &'static str {
        OsSecretStore::new().backend()
    }
    fn set(&self, key: &SecretKey, value: &SecretString) -> Result<(), SecretStoreError> {
        OsSecretStore::new().set(&self.key(key)?, value)
    }
    fn get(&self, key: &SecretKey) -> Result<Option<SecretString>, SecretStoreError> {
        OsSecretStore::new().get(&self.key(key)?)
    }
    fn delete(&self, key: &SecretKey) -> Result<bool, SecretStoreError> {
        OsSecretStore::new().delete(&self.key(key)?)
    }
}

pub struct IntegrationState {
    pub broker: Arc<IntegrationBroker>,
    pub openai: Arc<OpenAiIntegrations>,
    model: Mutex<String>,
    model_path: PathBuf,
    pub bridge: Arc<crate::integration_bridge::IntegrationBridge>,
}

fn failure(message: impl Into<String>) -> IpcError {
    KalError::validation("integration_failed", message.into()).to_ipc()
}
fn encode(value: impl serde::Serialize) -> Result<Value, IpcError> {
    serde_json::to_value(value)
        .map_err(|_| failure("KalCode couldn't read the integration response. Retry."))
}

impl IntegrationState {
    pub fn start(
        state: &AppState,
        account_id: &str,
        valid: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<Self, IpcError> {
        let digest = Sha256::digest(account_id.as_bytes());
        let namespace = format!("{digest:x}");
        let dir = state.paths.data_dir.join("integrations").join(&namespace);
        std::fs::create_dir_all(&dir).map_err(|_| {
            failure("KalCode couldn't open integration storage. Check disk access.")
        })?;
        let secrets: Arc<dyn SecretStore> = Arc::new(AccountSecrets {
            prefix: namespace[..24].into(),
        });
        let broker = Arc::new(
            IntegrationBroker::open(dir.join("integrations.sqlite"), secrets.clone())
                .map_err(|e| failure(e.to_string()))?
                .with_authority(valid.clone()),
        );
        let model_path = dir.join("model.txt");
        let model = std::fs::read_to_string(&model_path)
            .ok()
            .filter(|v| valid_model(v))
            .unwrap_or_else(|| "gpt-6-astra".into());
        let bridge = Arc::new(crate::integration_bridge::IntegrationBridge::new(
            broker.clone(),
            valid,
        ));
        let weak = Arc::downgrade(&bridge);
        let core = state.core()?.clone();
        let scope_authority = Arc::new(move |scope: &ToolScope| {
            core.workspaces()
                .is_ok_and(|workspaces| workspaces.iter().any(|w| w.id == scope.workspace_id))
                && weak
                    .upgrade()
                    .is_some_and(|bridge| bridge.allows_scope(scope))
        });
        let openai = Arc::new(
            OpenAiIntegrations::new(broker.clone(), secrets)
                .map_err(|e| failure(e.to_string()))?
                .with_authority({
                    let bridge = Arc::downgrade(&bridge);
                    Arc::new(move || bridge.upgrade().is_some_and(|b| b.account_valid()))
                })
                .with_scope_authority(scope_authority),
        );
        Ok(Self {
            broker,
            openai,
            model: Mutex::new(model),
            model_path,
            bridge,
        })
    }
    fn model(&self) -> String {
        self.model
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 100
        && model
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b))
}

fn enforce_plan(
    threads: &ThreadsState,
    broker: &IntegrationBroker,
    scope: &ToolScope,
    tool: Option<(&str, &str)>,
) -> Result<(), IpcError> {
    if scope.surface != Surface::Code {
        return Ok(());
    }
    let thread = threads
        .runtime()?
        .get(&scope.session_id)
        .map_err(|e| e.to_ipc())?;
    if thread.permission_mode != kalcode_contracts::permissions::PermissionMode::Plan {
        return Ok(());
    }
    let integrations = broker.list().map_err(|e| failure(e.to_string()))?;
    let sensitive = integrations.iter().any(|integration| {
        integration
            .grants
            .iter()
            .filter(|g| {
                g.workspace_id == scope.workspace_id
                    && g.surface == scope.surface
                    && g.session_id == scope.session_id
            })
            .any(|g| {
                g.tool_names.iter().any(|name| {
                    tool.is_none_or(|(id, selected)| integration.id == id && name == selected)
                        && integration
                            .capabilities
                            .iter()
                            .any(|t| &t.name == name && t.risk != kalcode_integrations::Risk::Read)
                })
            })
    });
    if sensitive {
        return Err(failure(
            "This coding agent is in Plan mode. Limit its integration access to read tools or change the agent's mode.",
        ));
    }
    Ok(())
}

/// Only a state-matching authorization response reaches the exchange. Unrelated browser
/// requests cannot consume the one-use flow. The code is never reflected in HTML or logs.
async fn oauth_callback(
    listener: tokio::net::TcpListener,
    port: u16,
    expected_state: &str,
) -> Result<String, IpcError> {
    loop {
        let (mut stream, _) = listener
            .accept()
            .await
            .map_err(|_| failure("Browser sign-in disconnected."))?;
        let mut bytes = Vec::new();
        let read = tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let mut chunk = [0u8; 2048];
                let n = stream.read(&mut chunk).await?;
                if n == 0 {
                    return Ok::<_, std::io::Error>(());
                }
                bytes.extend_from_slice(&chunk[..n]);
                if bytes.len() > 16_384 || bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    return Ok(());
                }
            }
        })
        .await;
        if !matches!(read, Ok(Ok(()))) || bytes.len() > 16_384 {
            continue;
        }
        let code = parse_oauth_callback(&bytes, port, expected_state);
        let body = if code.is_some() {
            "Sign-in received. Return to KalCode to finish connecting."
        } else {
            "This sign-in response was not accepted. Return to KalCode and try again."
        };
        let response = format!(
            "HTTP/1.1 {}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            if code.is_some() {
                "200 OK"
            } else {
                "400 Bad Request"
            },
            body.len()
        );
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
        if let Some(code) = code {
            return Ok(code);
        }
    }
}

fn parse_oauth_callback(bytes: &[u8], port: u16, expected_state: &str) -> Option<String> {
    let request = std::str::from_utf8(bytes).ok()?;
    let mut lines = request.split("\r\n");
    let line = lines.next()?;
    let target = line.strip_prefix("GET ")?.strip_suffix(" HTTP/1.1")?;
    if !target.starts_with("/callback?") {
        return None;
    }
    let hosts: Vec<_> = lines
        .filter_map(|line| line.split_once(':'))
        .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
        .collect();
    if hosts.len() != 1 || hosts[0].1.trim() != format!("127.0.0.1:{port}") {
        return None;
    }
    let url = reqwest::Url::parse(&format!("http://127.0.0.1:{port}{target}")).ok()?;
    let pairs: Vec<_> = url.query_pairs().collect();
    let states: Vec<_> = pairs.iter().filter(|(key, _)| key == "state").collect();
    let codes: Vec<_> = pairs.iter().filter(|(key, _)| key == "code").collect();
    if states.len() != 1
        || codes.len() != 1
        || states[0].1 != expected_state
        || pairs.iter().any(|(key, _)| key == "error")
    {
        return None;
    }
    let code = codes[0].1.to_string();
    (!code.is_empty() && code.len() <= 4096 && !code.chars().any(char::is_control)).then_some(code)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oauth_callback_is_bound_to_host_state_and_single_code() {
        let request =
            "GET /callback?state=expected&code=abc HTTP/1.1\r\nHost: 127.0.0.1:5555\r\n\r\n";
        assert_eq!(
            parse_oauth_callback(request.as_bytes(), 5555, "expected"),
            Some("abc".into())
        );
        assert!(parse_oauth_callback(request.as_bytes(), 5555, "other").is_none());
        assert!(parse_oauth_callback(request.as_bytes(), 7777, "expected").is_none());
        assert!(
            parse_oauth_callback(
                request
                    .replace("&code=abc", "&code=abc&code=other")
                    .as_bytes(),
                5555,
                "expected"
            )
            .is_none()
        );
        assert!(
            parse_oauth_callback(
                request
                    .replace(
                        "Host: 127.0.0.1:5555",
                        "Host: 127.0.0.1:5555\r\nHost: evil.example"
                    )
                    .as_bytes(),
                5555,
                "expected"
            )
            .is_none()
        );
    }
}

pub(crate) fn validate_scope(
    state: &AppState,
    threads: &ThreadsState,
    scope: &ToolScope,
) -> Result<(), IpcError> {
    let exists = state
        .core()?
        .workspaces()
        .map_err(|e| e.to_ipc())?
        .iter()
        .any(|w| w.id == scope.workspace_id);
    if !exists {
        return Err(failure(
            "This workspace is unavailable. Select an existing workspace.",
        ));
    }
    match scope.surface {
        Surface::Code => {
            let thread = threads
                .runtime()?
                .get(&scope.session_id)
                .map_err(|e| e.to_ipc())?;
            // runtime_kind is stamped from the native pane marker by the IPC layer; use the same authority.
            let interactive = kalcode_providers::interactive::provider::marked_interactive_checked(
                &state.paths.data_dir.join("sessions"),
                &thread.id,
            )
            .map_err(|_| failure("Couldn't verify this coding session. Retry."))?;
            if thread.workspace_id != scope.workspace_id || !interactive {
                return Err(failure(
                    "Tool access must target a real coding agent in this workspace.",
                ));
            }
        }
        Surface::Kalvoice if scope.session_id != "kalvoice" => {
            return Err(failure("Invalid KalVoice scope."));
        }
        Surface::Brainstorm if scope.session_id != "brainstorm" => {
            return Err(failure("Invalid Brainstorm scope."));
        }
        _ => {}
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum IntegrationRequest {
    List,
    Configuration {
        id: String,
    },
    Oauth {
        id: String,
        config: kalcode_integrations::OAuthConfig,
    },
    Save {
        input: IntegrationInput,
        credential: Option<String>,
    },
    Disconnect {
        id: String,
    },
    Rename {
        id: String,
        name: String,
    },
    Grants {
        id: String,
        grants: Vec<AccessGrant>,
    },
    Refresh {
        id: String,
    },
    Discover {
        scope: ToolScope,
        query: String,
    },
    Call {
        scope: ToolScope,
        integration_id: String,
        tool_name: String,
        arguments: Value,
        approval_id: Option<String>,
    },
    Pending,
    Approve {
        approval_id: String,
    },
    OpenaiConfigure {
        credential: Option<String>,
        model: String,
    },
    OpenaiStatus,
    Query {
        scope: ToolScope,
        prompt: String,
    },
    Resume {
        scope: ToolScope,
        turn_id: String,
    },
}

#[tauri::command]
pub async fn integration_dispatch(
    app: AppHandle,
    webview: Webview,
    state: State<'_, AppState>,
    integrations: RuntimeState<IntegrationState>,
    threads: RuntimeState<ThreadsState>,
    request: IntegrationRequest,
) -> Result<Value, IpcError> {
    if webview.label() != "main" {
        return Err(failure(
            "Integrations are available only in KalCode's main window.",
        ));
    }
    integrations.revalidate()?;
    threads.revalidate()?;
    let result = match request {
        IntegrationRequest::List => encode(
            integrations
                .broker
                .list()
                .map_err(|e| failure(e.to_string()))?,
        ),
        IntegrationRequest::Configuration { id } => encode(
            integrations
                .broker
                .configuration(&id)
                .map_err(|e| failure(e.to_string()))?,
        ),
        IntegrationRequest::Oauth { id, config } => {
            let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
                .await
                .map_err(|_| failure("Couldn't start secure browser sign-in. Retry."))?;
            let port = listener
                .local_addr()
                .map_err(|_| failure("Couldn't start secure browser sign-in."))?
                .port();
            let redirect = format!("http://127.0.0.1:{port}/callback");
            let start = integrations
                .broker
                .begin_oauth(&id, config, &redirect)
                .map_err(|e| failure(e.to_string()))?;
            if app
                .opener()
                .open_url(&start.authorization_url, None::<&str>)
                .is_err()
            {
                let _ = integrations.broker.cancel_oauth(&start.state);
                return Err(failure(
                    "Couldn't open your browser. Check the default browser and reconnect.",
                ));
            }
            let callback = tokio::time::timeout(
                std::time::Duration::from_secs(180),
                oauth_callback(listener, port, &start.state),
            )
            .await;
            let code = match callback {
                Ok(Ok(code)) => code,
                _ => {
                    let _ = integrations.broker.cancel_oauth(&start.state);
                    return Err(failure(
                        "Browser sign-in was cancelled or timed out. Reconnect to try again.",
                    ));
                }
            };
            integrations.revalidate()?;
            encode(
                integrations
                    .broker
                    .complete_oauth(&start.state, &code)
                    .await
                    .map_err(|e| failure(e.to_string()))?,
            )
        }
        IntegrationRequest::Save { input, credential } => encode(
            integrations
                .broker
                .save(input, credential.map(SecretString::new))
                .map_err(|e| failure(e.to_string()))?,
        ),
        IntegrationRequest::Disconnect { id } => {
            integrations
                .broker
                .disconnect(&id)
                .map_err(|e| failure(e.to_string()))?;
            Ok(Value::Null)
        }
        IntegrationRequest::Rename { id, name } => encode(
            integrations
                .broker
                .rename(&id, &name)
                .map_err(|e| failure(e.to_string()))?,
        ),
        IntegrationRequest::Grants { id, grants } => {
            for grant in &grants {
                validate_scope(
                    &state,
                    &threads,
                    &ToolScope {
                        workspace_id: grant.workspace_id.clone(),
                        surface: grant.surface.clone(),
                        session_id: grant.session_id.clone(),
                    },
                )?;
            }
            encode(
                integrations
                    .broker
                    .set_grants(&id, grants)
                    .map_err(|e| failure(e.to_string()))?,
            )
        }
        IntegrationRequest::Refresh { id } => {
            let tunnel = integrations
                .broker
                .list()
                .map_err(|e| failure(e.to_string()))?
                .iter()
                .any(|v| v.id == id && v.kind == IntegrationKind::SecureMcpTunnel);
            if tunnel {
                encode(
                    integrations
                        .openai
                        .discover_tunnel(id, integrations.model())
                        .await
                        .map_err(|e| failure(e.to_string()))?,
                )
            } else {
                encode(
                    integrations
                        .broker
                        .refresh(&id)
                        .await
                        .map_err(|e| failure(e.to_string()))?,
                )
            }
        }
        IntegrationRequest::Discover { scope, query } => {
            validate_scope(&state, &threads, &scope)?;
            encode(
                integrations
                    .broker
                    .discover(&scope, &query)
                    .map_err(|e| failure(e.to_string()))?,
            )
        }
        IntegrationRequest::Call {
            scope,
            integration_id,
            tool_name,
            arguments,
            approval_id,
        } => {
            validate_scope(&state, &threads, &scope)?;
            enforce_plan(
                &threads,
                &integrations.broker,
                &scope,
                Some((&integration_id, &tool_name)),
            )?;
            let bridge = Arc::downgrade(&integrations.bridge);
            let core = state.core()?.clone();
            let guarded_scope = scope.clone();
            let guard = Arc::new(move || {
                core.workspaces().is_ok_and(|workspaces| {
                    workspaces
                        .iter()
                        .any(|w| w.id == guarded_scope.workspace_id)
                }) && bridge
                    .upgrade()
                    .is_some_and(|bridge| bridge.allows_scope(&guarded_scope))
            });
            encode(
                integrations
                    .broker
                    .call_guarded(
                        scope,
                        integration_id,
                        tool_name,
                        arguments,
                        approval_id,
                        guard,
                    )
                    .await
                    .map_err(|e| failure(e.to_string()))?,
            )
        }
        IntegrationRequest::Pending => encode(
            integrations
                .broker
                .pending_approvals()
                .map_err(|e| failure(e.to_string()))?,
        ),
        IntegrationRequest::Approve { approval_id } => {
            let pending = integrations
                .broker
                .pending_approvals()
                .map_err(|e| failure(e.to_string()))?;
            let approval = pending
                .iter()
                .find(|v| v.id == approval_id)
                .ok_or_else(|| failure("This approval expired. Request the action again."))?;
            validate_scope(&state, &threads, &approval.scope)?;
            let message = format!(
                "Allow {} to run {}?\n\nWorkspace: {}\n\n{}",
                approval.integration_name,
                approval.tool_name,
                approval.scope.workspace_id,
                approval.arguments_preview
            );
            let accepted = tauri::async_runtime::spawn_blocking(move || {
                app.dialog()
                    .message(message)
                    .title("Approve external action")
                    .kind(MessageDialogKind::Warning)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "Allow once".into(),
                        "Cancel".into(),
                    ))
                    .blocking_show()
            })
            .await
            .map_err(|_| failure("Approval couldn't be shown. Try again."))?;
            integrations.revalidate()?;
            if !accepted {
                let _ = integrations.broker.deny(&approval_id);
                return Err(failure("Action cancelled. Nothing was sent."));
            }
            integrations
                .broker
                .approve(&approval_id)
                .map_err(|e| failure(e.to_string()))?;
            Ok(Value::Null)
        }
        IntegrationRequest::OpenaiConfigure { credential, model } => {
            if !valid_model(&model) {
                return Err(failure("Enter a valid OpenAI model ID."));
            }
            integrations
                .openai
                .configure_key(credential.map(SecretString::new))
                .map_err(|e| failure(e.to_string()))?;
            std::fs::write(&integrations.model_path, &model)
                .map_err(|_| failure("Couldn't save the model selection. Check disk access."))?;
            *integrations
                .model
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = model;
            Ok(
                json!({"configured": integrations.openai.configured().map_err(|e| failure(e.to_string()))?, "model":integrations.model()}),
            )
        }
        IntegrationRequest::OpenaiStatus => Ok(
            json!({"configured": integrations.openai.configured().map_err(|e| failure(e.to_string()))?, "model": integrations.model()}),
        ),
        IntegrationRequest::Query { scope, prompt } => {
            validate_scope(&state, &threads, &scope)?;
            enforce_plan(&threads, &integrations.broker, &scope, None)?;
            encode(
                integrations
                    .openai
                    .query(scope, integrations.model(), prompt)
                    .await
                    .map_err(|e| failure(e.to_string()))?,
            )
        }
        IntegrationRequest::Resume { scope, turn_id } => {
            validate_scope(&state, &threads, &scope)?;
            enforce_plan(&threads, &integrations.broker, &scope, None)?;
            encode(
                integrations
                    .openai
                    .resume(scope, turn_id)
                    .await
                    .map_err(|e| failure(e.to_string()))?,
            )
        }
    };
    integrations.revalidate()?;
    result
}
