//! Codex adapter (headless `codex exec --json`, one supervised process per turn).
//!
//! See [`crate::turns`] for the session model and [`argv`] for the launch mapping. `codex
//! app-server` (JSON-RPC with approval requests to the host) is the long-term surface once it
//! leaves "experimental" in the CLI's own help; the plan is in docs/PROVIDERS.md §8b.

pub mod argv;
mod stream;

use std::ffi::OsString;

use kalcode_contracts::agent::{
    AgentEventSink, AgentProvider, AgentSession, AuthState, DetectionState, ProviderCapabilities,
    ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::ids::new_id;
use kalcode_contracts::permissions::{ActionKind, NormalizedAction, PermissionMode};
use serde_json::Value;

use crate::catalog;
use crate::claude::actions::{ActionContext, classify};
use crate::claude::argv::working_directory;
use crate::detect::{DetectEnv, DetectionSpec, detect};
use crate::turns::{TurnAdapter, TurnLaunch, TurnNormalizer, TurnSession};

/// [`AgentProvider`] for Codex.
pub struct CodexProvider {
    env: DetectEnv,
}

impl CodexProvider {
    pub fn new(env: DetectEnv) -> Self {
        Self { env }
    }
}

struct CodexTurns {
    mode: PermissionMode,
    model: Option<String>,
    cwd: String,
}

impl TurnAdapter for CodexTurns {
    fn provider_id(&self) -> &'static str {
        ProviderId::CODEX
    }

    fn display_name(&self) -> &'static str {
        "Codex"
    }

    fn turn_args(&self, resume: Option<&str>) -> Result<Vec<OsString>, ProviderError> {
        argv::exec_args(self.mode, self.model.as_deref(), resume)
            .map_err(|e| ProviderError::Start(e.to_string()))
    }

    fn normalizer(&self) -> Box<dyn TurnNormalizer> {
        Box::new(stream::CodexNormalizer::new(self.cwd.clone()))
    }
}

/// Resolves a usable executable for a turn-based provider, refusing the same states as Claude
/// Code (not installed, outdated, detection error, signed out).
pub(crate) fn usable_executable(
    spec: &DetectionSpec,
    env: &DetectEnv,
) -> Result<std::path::PathBuf, ProviderError> {
    let detected = detect(spec, env);
    match (detected.detection.state, detected.executable) {
        (DetectionState::Installed, Some(exe))
            if detected.detection.auth != AuthState::NotAuthenticated =>
        {
            Ok(exe)
        }
        (DetectionState::Installed, Some(_)) => Err(ProviderError::NotAuthenticated),
        (DetectionState::NotInstalled, _) => Err(ProviderError::NotInstalled),
        _ => Err(ProviderError::Start(
            detected
                .detection
                .message
                .unwrap_or_else(|| format!("{} couldn't be checked.", spec.display_name)),
        )),
    }
}

impl AgentProvider for CodexProvider {
    fn id(&self) -> ProviderId {
        ProviderId::new(ProviderId::CODEX)
    }

    fn display_name(&self) -> &str {
        "Codex"
    }

    fn detect(&self) -> ProviderDetection {
        detect(&catalog::codex_spec(), &self.env).detection
    }

    fn capabilities(&self) -> ProviderCapabilities {
        catalog::codex_capabilities()
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        if config.secret_ref.is_some() {
            // API-key accounts are a later campaign; sessions use the user's own Codex sign-in.
            return Err(ProviderError::Unsupported);
        }
        let spec = catalog::codex_spec();
        let executable = usable_executable(&spec, &self.env)?;
        let cwd = working_directory(&config.working_directory)
            .map_err(|e| ProviderError::Start(e.to_string()))?;
        let adapter = CodexTurns {
            mode: config.permission_mode,
            model: config.model,
            cwd: config.working_directory,
        };
        // Validate the argv once before anything runs, so a bad model or resume id fails the
        // start instead of the first message.
        adapter.turn_args(config.resume_session_id.as_deref())?;
        Ok(Box::new(TurnSession::start(
            Box::new(adapter),
            TurnLaunch {
                executable,
                env: self.env.provider_env(&spec.env_policy),
                cwd,
                resume_session_id: config.resume_session_id,
            },
            sink,
        )))
    }
}

/// Builds the [`NormalizedAction`] for a Codex item (`command_execution`, `file_change`,
/// `web_search`, `mcp_tool_call`), for the one policy engine (Z4). `None` for items that are
/// not actions (messages, reasoning, plans).
pub fn normalize_item(
    ctx: &ActionContext,
    item: &Value,
    requested_at: String,
) -> Option<NormalizedAction> {
    let field = |key| item.get(key).and_then(Value::as_str);
    let (action, summary) = match field("type")? {
        "command_execution" => classify(
            "Bash",
            &serde_json::json!({ "command": field("command").unwrap_or("") }),
            &ctx.working_directory,
        ),
        "web_search" => classify(
            "WebSearch",
            &serde_json::json!({ "query": field("query").unwrap_or("") }),
            &ctx.working_directory,
        ),
        "file_change" => {
            let path = item
                .get("changes")
                .and_then(Value::as_array)
                .and_then(|c| c.first())
                .and_then(|c| c.get("path"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            (
                ActionKind::FileWrite { path: path.clone() },
                format!("Edit {path}"),
            )
        }
        "mcp_tool_call" => {
            let tool = format!(
                "mcp:{}/{}",
                field("server").unwrap_or("mcp"),
                field("tool").unwrap_or("tool")
            );
            (
                ActionKind::Tool {
                    tool: tool.clone(),
                    input_summary: "MCP arguments".into(),
                },
                format!("Use {tool}"),
            )
        }
        _ => return None,
    };
    Some(NormalizedAction {
        id: new_id(),
        thread_id: ctx.thread_id.clone(),
        workspace_id: ctx.workspace_id.clone(),
        provider_id: ProviderId::new(ProviderId::CODEX),
        action,
        summary,
        requested_at,
        origin: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::permissions::GitOperation;

    fn ctx() -> ActionContext {
        ActionContext {
            thread_id: new_id(),
            workspace_id: new_id(),
            working_directory: "/work".into(),
        }
    }

    #[test]
    fn codex_items_become_normalized_actions() {
        let push = normalize_item(
            &ctx(),
            &serde_json::json!({"type": "command_execution", "command": "git push origin main"}),
            "t".into(),
        )
        .expect("action");
        assert!(matches!(
            push.action,
            ActionKind::Git {
                operation: GitOperation::Push,
                ..
            }
        ));
        assert_eq!(push.provider_id.as_str(), "codex");
        let edit = normalize_item(
            &ctx(),
            &serde_json::json!({"type": "file_change", "changes": [{"path": "a.rs", "kind": "update"}], "status": "completed"}),
            "t".into(),
        )
        .expect("action");
        assert_eq!(
            edit.action,
            ActionKind::FileWrite {
                path: "a.rs".into()
            }
        );
        assert!(
            normalize_item(
                &ctx(),
                &serde_json::json!({"type": "agent_message", "text": "x"}),
                "t".into()
            )
            .is_none()
        );
    }
}
