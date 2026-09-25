//! Gemini CLI adapter (headless `--output-format stream-json`, one supervised process per
//! turn; see [`crate::turns`]).
//!
//! Sources (docs/PROVIDERS.md §11 [9][10][15][16]): the headless-mode guide and CLI reference
//! (geminicli.com), and the stream-JSON event types the CLI defines in
//! `packages/core/src/output/types.ts` (github.com/google-gemini/gemini-cli). Gemini CLI is not
//! installed on the verification machine: everything here is exercised against the fake
//! provider and recorded official-format fixtures, and re-verified by the owner-approved smoke
//! script (`tooling/smoke/gemini-headless-smoke.ps1`).
//!
//! argv (the prompt is written to stdin; headless mode applies to non-TTY input):
//!
//! ```text
//! gemini --output-format stream-json --approval-mode <plan|default|auto_edit>
//!        [--model <alias>] [--resume <session uuid>]
//! ```
//!
//! Never passed: `yolo` / `--yolo`, `--allowed-tools` (deprecated), `--skip-trust` (would trust
//! the workspace and load its settings), `--sandbox` is left to the user's settings.

pub mod stream;

use std::ffi::OsString;

use kalcode_contracts::agent::{
    AgentEventSink, AgentProvider, AgentSession, MappingFidelity, PermissionMapping,
    ProviderCapabilities, ProviderDetection, ProviderError, ProviderId, SessionConfig,
};
use kalcode_contracts::permissions::PermissionMode;

use crate::catalog;
use crate::claude::argv::working_directory;
use crate::codex::usable_executable;
use crate::detect::{DetectEnv, detect};
use crate::turns::{TurnAdapter, TurnLaunch, TurnNormalizer, TurnSession};

/// Flags and values KalCode never passes to Gemini CLI.
pub const FORBIDDEN: &[&str] = &[
    "yolo",
    "--yolo",
    "-y",
    "--approval-mode=yolo",
    "--allowed-tools",
    "--skip-trust",
    "--include-directories",
    "--experimental-acp",
];

/// Gemini CLI's approval mode for a KalCode mode. Custom runs as Approve.
pub fn approval_mode(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Plan => "plan",
        PermissionMode::Bypass => "auto_edit",
        PermissionMode::Approve | PermissionMode::Auto | PermissionMode::Custom => "default",
    }
}

pub fn permission_setting(mode: PermissionMode) -> String {
    format!("--approval-mode {}", approval_mode(mode))
}

const NOT_ENFORCED: &str = "Gemini CLI has no deny-rule flag KalCode can pass per session: \
                            reads of credential files aren't blocked by KalCode, and settings \
                            of a folder you trusted in Gemini CLI still apply.";

pub fn permission_mappings() -> Vec<PermissionMapping> {
    let map = |mode, notes: &str| PermissionMapping {
        mode,
        fidelity: MappingFidelity::ApproximateStricter,
        provider_setting: permission_setting(mode),
        notes: format!("{notes} {NOT_ENFORCED}"),
    };
    vec![
        map(PermissionMode::Plan, "Gemini CLI's read-only plan mode."),
        map(
            PermissionMode::Approve,
            "Tool calls that need confirmation can't be answered in headless mode, so they \
             don't run.",
        ),
        map(PermissionMode::Auto, "Runs like Approve."),
        map(
            PermissionMode::Bypass,
            "File edits are approved automatically; other tools that need confirmation don't \
             run. yolo mode is never used.",
        ),
    ]
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GeminiArgsError {
    #[error("the model name is not valid")]
    InvalidModel,
    #[error("the session id is not valid")]
    InvalidSessionId,
}

/// The argv (after the program) for one headless turn.
pub fn headless_args(
    mode: PermissionMode,
    model: Option<&str>,
    resume: Option<&str>,
) -> Result<Vec<OsString>, GeminiArgsError> {
    let mut out: Vec<OsString> = vec![
        "--output-format".into(),
        "stream-json".into(),
        "--approval-mode".into(),
        approval_mode(mode).into(),
    ];
    if let Some(model) = model {
        if !crate::claude::argv::valid_model_name(model) {
            return Err(GeminiArgsError::InvalidModel);
        }
        out.push("--model".into());
        out.push(model.into());
    }
    if let Some(id) = resume {
        // Only a full session UUID (never `latest` or an index, which could pick another
        // session).
        if !kalcode_contracts::ids::is_valid_id(id) {
            return Err(GeminiArgsError::InvalidSessionId);
        }
        out.push("--resume".into());
        out.push(id.into());
    }
    Ok(out)
}

/// The argv for an interactive Gemini CLI pane (process state only; approvals in Gemini CLI's
/// own prompt).
pub fn interactive_args(
    mode: PermissionMode,
    model: Option<&str>,
    resume: Option<&str>,
) -> Result<Vec<OsString>, GeminiArgsError> {
    let mut out = headless_args(mode, model, resume)?;
    // Interactive: no stream-JSON output format.
    out.drain(0..2);
    Ok(out)
}

/// [`AgentProvider`] for Gemini CLI.
pub struct GeminiProvider {
    env: DetectEnv,
}

impl GeminiProvider {
    pub fn new(env: DetectEnv) -> Self {
        Self { env }
    }
}

struct GeminiTurns {
    mode: PermissionMode,
    model: Option<String>,
    cwd: String,
}

impl TurnAdapter for GeminiTurns {
    fn provider_id(&self) -> &'static str {
        ProviderId::GEMINI_CLI
    }

    fn display_name(&self) -> &'static str {
        "Gemini CLI"
    }

    fn turn_args(&self, resume: Option<&str>) -> Result<Vec<OsString>, ProviderError> {
        headless_args(self.mode, self.model.as_deref(), resume)
            .map_err(|e| ProviderError::Start(e.to_string()))
    }

    fn normalizer(&self) -> Box<dyn TurnNormalizer> {
        Box::new(stream::GeminiNormalizer::new(self.cwd.clone()))
    }
}

impl AgentProvider for GeminiProvider {
    fn id(&self) -> ProviderId {
        ProviderId::new(ProviderId::GEMINI_CLI)
    }

    fn display_name(&self) -> &str {
        "Gemini CLI"
    }

    fn detect(&self) -> ProviderDetection {
        detect(&catalog::gemini_spec(), &self.env).detection
    }

    fn capabilities(&self) -> ProviderCapabilities {
        catalog::gemini_capabilities()
    }

    fn start_session(
        &self,
        config: SessionConfig,
        sink: Box<dyn AgentEventSink>,
    ) -> Result<Box<dyn AgentSession>, ProviderError> {
        if config.secret_ref.is_some() {
            return Err(ProviderError::Unsupported);
        }
        let spec = catalog::gemini_spec();
        let executable = usable_executable(&spec, &self.env)?;
        let cwd = working_directory(&config.working_directory)
            .map_err(|e| ProviderError::Start(e.to_string()))?;
        let adapter = GeminiTurns {
            mode: config.permission_mode,
            model: config.model,
            cwd: config.working_directory,
        };
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

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [PermissionMode; 5] = [
        PermissionMode::Plan,
        PermissionMode::Approve,
        PermissionMode::Auto,
        PermissionMode::Bypass,
        PermissionMode::Custom,
    ];

    fn strings(args: Vec<OsString>) -> Vec<String> {
        args.into_iter()
            .map(|a| a.into_string().expect("utf8"))
            .collect()
    }

    #[test]
    fn no_mode_is_ever_broader_than_its_kalcode_mode() {
        let rank = |m: &str| match m {
            "plan" => 0,
            "default" => 1,
            "auto_edit" => 2,
            other => panic!("unexpected approval mode {other}"),
        };
        for mode in ALL {
            for args in [
                strings(headless_args(mode, Some("flash"), None).expect("args")),
                strings(interactive_args(mode, Some("flash"), None).expect("args")),
            ] {
                for forbidden in FORBIDDEN {
                    assert!(!args.iter().any(|a| a == forbidden), "{mode:?}: {args:?}");
                }
                let at = args
                    .iter()
                    .position(|a| a == "--approval-mode")
                    .expect("mode");
                let cap = match mode {
                    PermissionMode::Plan => 0,
                    PermissionMode::Bypass => 2,
                    _ => 1,
                };
                assert!(rank(&args[at + 1]) <= cap, "{mode:?}");
            }
        }
        assert_eq!(
            strings(headless_args(PermissionMode::Plan, None, None).expect("args")),
            ["--output-format", "stream-json", "--approval-mode", "plan"]
        );
    }

    #[test]
    fn resume_takes_only_a_session_uuid() {
        let id = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
        let args = strings(headless_args(PermissionMode::Approve, None, Some(id)).expect("args"));
        assert_eq!(&args[args.len() - 2..], ["--resume", id]);
        for bad in ["latest", "5", "--yolo"] {
            assert_eq!(
                headless_args(PermissionMode::Approve, None, Some(bad)),
                Err(GeminiArgsError::InvalidSessionId)
            );
        }
        assert_eq!(
            headless_args(PermissionMode::Approve, Some("--yolo"), None),
            Err(GeminiArgsError::InvalidModel)
        );
    }

    #[test]
    fn mappings_are_stricter_and_match_the_argv() {
        for mapping in permission_mappings() {
            assert_eq!(mapping.fidelity, MappingFidelity::ApproximateStricter);
            let argv = strings(headless_args(mapping.mode, None, None).expect("args")).join(" ");
            assert!(argv.contains(&mapping.provider_setting), "{argv}");
        }
    }
}
