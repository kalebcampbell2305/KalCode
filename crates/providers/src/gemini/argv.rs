use std::ffi::OsString;

use kalcode_contracts::permissions::PermissionMode;

/// Flags and values KalCode never passes to Gemini CLI.
pub const FORBIDDEN: &[&str] = &[
    "yolo",
    "--yolo",
    "-y",
    "--approval-mode=yolo",
    "--allowed-tools",
    "--acp",
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

/// The argv for an interactive Gemini CLI pane (process state only; approvals stay in Gemini's
/// own prompt). Managed callers append `ManagedGeminiLaunch::security_args` before spawning.
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
