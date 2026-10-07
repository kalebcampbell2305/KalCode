//! Cursor's supported native CLI surface. No credential copies, inferred quota, model
//! catalog, or terminal-prose lifecycle parsing. Sources: cursor.com/docs/cli/reference/
//! parameters.md and official CLI 2026.10.01-e373342 (`status --format json`, `models`).

use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

use kalcode_contracts::agent::{
    AuthState, InteractiveSupport, MappingFidelity, ModelInfo, PermissionMapping,
    ProviderCapabilities, ProviderError, StatusChannel, ToolAvailability, ToolCapability, ToolKind,
};
use kalcode_contracts::permissions::PermissionMode;

use crate::detect::DetectEnv;
use crate::guardian::ProviderProbeGuardian;
use crate::process::{ProbeOutput, ProcessError, ProcessSpec, run_probe, run_probe_guarded};
use crate::version::Version;

/// Cursor's native CLI uses a calendar release plus source revision such as
/// `2026.10.01-e373342`. The zero-padded day is intentionally provider-specific rather than
/// weakening strict SemVer parsing for Codex and other CLIs. The source revision is build
/// identity, not a prerelease channel, so normalize it as SemVer build metadata.
pub(crate) fn parse_cli_version(output: &str) -> Option<Version> {
    output
        .split_ascii_whitespace()
        .find_map(parse_calendar_version)
        .or_else(|| Version::find_in(output))
}

fn parse_calendar_version(token: &str) -> Option<Version> {
    let token = token.trim_matches(|character: char| {
        !character.is_ascii_alphanumeric() && !matches!(character, '.' | '-' | '_')
    });
    let (date, revision) = token.split_once('-')?;
    if revision.is_empty()
        || revision
            .bytes()
            .any(|byte| !(byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')))
    {
        return None;
    }
    let mut parts = date.split('.');
    let (year, month, day) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some()
        || year.len() != 4
        || month.len() != 2
        || day.len() != 2
        || !year.bytes().all(|byte| byte.is_ascii_digit())
        || !month.bytes().all(|byte| byte.is_ascii_digit())
        || !day.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let (year, month, day) = (
        year.parse::<u64>().ok()?,
        month.parse::<u64>().ok()?,
        day.parse::<u64>().ok()?,
    );
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Version::parse(&format!("{year}.{month}.{day}+{revision}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorAuthStatus {
    /// Cursor reports native credential presence, not a guaranteed live server validation.
    pub auth: AuthState,
    pub identity: Option<String>,
}

/// Explicit connection check, not a passive startup observer: Cursor's dashboard
/// middleware may refresh provider-managed API-key credentials during this command.
pub fn auth_status(env: &DetectEnv) -> Result<CursorAuthStatus, ProviderError> {
    auth_status_guarded(env, None)
}

pub fn auth_status_guarded(
    env: &DetectEnv,
    guardian: Option<&ProviderProbeGuardian>,
) -> Result<CursorAuthStatus, ProviderError> {
    // `status` alone does not initialize documented environment authentication.
    // Let Cursor validate it using its supported authenticated command. This is
    // an explicit account operation; no background probe invokes this path.
    let environment_authenticated = has_environment_auth(env);
    if environment_authenticated {
        discover_models_guarded(env, guardian)?;
    }
    let output = probe(
        env,
        &["status", "--format", "json"],
        Duration::from_secs(30),
        guardian,
    )?;
    if !output.status.success() {
        return Err(probe_failure(
            &output,
            "Cursor could not check its native sign-in.",
        ));
    }
    let mut status = parse_auth_status(&output.stdout)?;
    if environment_authenticated {
        // The authenticated model request succeeded even if Cursor could not
        // persist the environment credential. Future native sessions inherit it.
        status.auth = AuthState::Authenticated;
    }
    Ok(status)
}

/// Explicit user-initiated native browser login; the provider owns credential persistence.
pub fn login(env: &DetectEnv) -> Result<CursorAuthStatus, ProviderError> {
    login_guarded(env, None)
}

pub fn login_guarded(
    env: &DetectEnv,
    guardian: Option<&ProviderProbeGuardian>,
) -> Result<CursorAuthStatus, ProviderError> {
    if has_environment_auth(env) {
        return auth_status_guarded(env, guardian);
    }
    let existing = auth_status_guarded(env, guardian)?;
    if existing.auth == AuthState::Authenticated {
        // Native `status` can report cached credential presence even after expiry.
        // Reuse the sign-in only after a supported authenticated request succeeds.
        match discover_models_guarded(env, guardian) {
            Ok(_) => return Ok(existing),
            Err(ProviderError::NotAuthenticated) => {}
            Err(ProviderError::Refused { ref code, .. })
                if code == "cursor_not_authenticated" || code == "cursor_session_expired" => {}
            Err(error) => return Err(error),
        }
    }
    let output = probe(env, &["login"], Duration::from_secs(300), guardian)?;
    if !output.status.success() {
        return Err(probe_failure(
            &output,
            "Cursor sign-in did not finish. Reconnect to try again.",
        ));
    }
    auth_status_guarded(env, guardian)
}

fn has_environment_auth(env: &DetectEnv) -> bool {
    env.vars.iter().any(|(name, value)| {
        !value.is_empty()
            && name.to_str().is_some_and(|name| {
                ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"]
                    .iter()
                    .any(|expected| {
                        if env.windows {
                            name.eq_ignore_ascii_case(expected)
                        } else {
                            name == *expected
                        }
                    })
            })
    })
}

pub fn discover_models(env: &DetectEnv) -> Result<Vec<ModelInfo>, ProviderError> {
    discover_models_guarded(env, None)
}

pub fn discover_models_guarded(
    env: &DetectEnv,
    guardian: Option<&ProviderProbeGuardian>,
) -> Result<Vec<ModelInfo>, ProviderError> {
    let output = probe(env, &["models"], Duration::from_secs(45), guardian)?;
    if !output.status.success() {
        return Err(probe_failure(
            &output,
            "Cursor could not load available models. Retry or use /model in its terminal.",
        ));
    }
    parse_models(&output.stdout)
}

fn probe(
    env: &DetectEnv,
    args: &[&str],
    timeout: Duration,
    guardian: Option<&ProviderProbeGuardian>,
) -> Result<ProbeOutput, ProviderError> {
    let spec = crate::catalog::cursor_spec();
    let program = env
        .resolve_executable_only(&spec)
        .ok_or_else(|| ProviderError::Refused {
            code: "cursor_not_installed".into(),
            message:
                "Cursor integration not installed/configured. Install Cursor Agent to continue."
                    .into(),
        })?;
    let mut variables = env.provider_env(&spec.env_policy);
    variables.insert("NO_COLOR".into(), "1".into());
    // Probes must not inherit a caller's forced ANSI styling.
    variables.retain(|key, _| !key.to_string_lossy().eq_ignore_ascii_case("FORCE_COLOR"));
    let process = ProcessSpec {
        program,
        args: args.iter().map(OsString::from).collect(),
        cwd: None,
        env: variables,
    };
    let timeout = env.probe_timeout.unwrap_or(timeout);
    match guardian {
        Some(guardian) => run_probe_guarded(
            &process,
            guardian
                .prepare_job("cursor-native-probe")
                .map_err(|error| ProviderError::Start(error.to_string()))?,
            timeout,
            true,
            256 * 1024,
        ),
        None => run_probe(&process, timeout, true, 256 * 1024),
    }
    .map_err(|error| match error {
        ProcessError::TimedOut(_) => ProviderError::Refused {
            code: match args[0] {
                "login" => "cursor_login_timed_out",
                "models" => "cursor_models_timed_out",
                _ => "cursor_status_timed_out",
            }.into(),
            message: match args[0] {
                "login" => "Cursor sign-in timed out. Reconnect and finish signing in in your browser.",
                "models" => "Cursor model discovery timed out. Retry when Cursor can reach its service.",
                _ => "Cursor sign-in check timed out. Your saved connection has been kept; retry the check.",
            }.into(),
        },
        ProcessError::Canceled => ProviderError::Refused {
            code: "cursor_operation_canceled".into(),
            message: "Cursor connection check was canceled by another account operation. Retry when it finishes.".into(),
        },
        ProcessError::Spawn(_) => ProviderError::Refused {
            code: "cursor_launch_failed".into(),
            message: "Cursor Agent could not start. Check its installation and try agent --version in a terminal.".into(),
        },
        _ => ProviderError::Refused {
            code: "cursor_runtime_unavailable".into(),
            message: "KalCode lost the connection to the Cursor command. Retry the connection check.".into(),
        },
    })
}

fn probe_failure(output: &ProbeOutput, fallback: &str) -> ProviderError {
    let (code, message) = classify_probe_failure(&output.stderr, fallback);
    ProviderError::Refused {
        code: code.into(),
        message: message.into(),
    }
}

/// Only Cursor's own sign-in wording proves the native session is gone. A proxy that wants
/// credentials ("407 Proxy Authentication Required") or an expired TLS certificate on the way to
/// Cursor's service is a connection failure: it must never sign out a working account.
fn classify_probe_failure<'a>(stderr: &str, fallback: &'a str) -> (&'static str, &'a str) {
    let lines = stderr.to_lowercase();
    let cursor_lines = || {
        lines.lines().filter(|line| {
            !["proxy", "certificate", "tls", "ssl"]
                .iter()
                .any(|network| line.contains(network))
        })
    };
    if cursor_lines()
        .any(|line| line.contains("authentication required") || line.contains("not logged in"))
    {
        (
            "cursor_not_authenticated",
            "Cursor is not signed in. Reconnect to continue.",
        )
    } else if cursor_lines().any(|line| {
        line.contains("authentication failed")
            || line.contains("invalid token")
            || [
                "session expired",
                "session has expired",
                "token expired",
                "token has expired",
                "login expired",
                "credentials expired",
                "credentials have expired",
            ]
            .iter()
            .any(|expired| line.contains(expired))
    }) {
        (
            "cursor_session_expired",
            "Cursor session expired. Reconnect to continue.",
        )
    } else {
        ("cursor_runtime_unavailable", fallback)
    }
}

pub(crate) fn parse_auth_status(text: &str) -> Result<CursorAuthStatus, ProviderError> {
    let value: serde_json::Value = serde_json::from_str(text).map_err(|_| {
        ProviderError::Protocol(
            "Cursor returned an unrecognized sign-in response. Update Cursor Agent and retry."
                .into(),
        )
    })?;
    let auth =
        match (value["status"].as_str(), value["isAuthenticated"].as_bool()) {
            (Some("authenticated"), Some(true)) => AuthState::Authenticated,
            (Some("unauthenticated" | "partially-authenticated"), Some(false)) => {
                AuthState::NotAuthenticated
            }
            _ => return Err(ProviderError::Protocol(
                "Cursor could not determine its native sign-in status. Retry the connection check."
                    .into(),
            )),
        };
    let identity = value
        .pointer("/userInfo/email")
        .and_then(serde_json::Value::as_str)
        .filter(|email| {
            !email.is_empty() && email.len() <= 256 && !email.chars().any(char::is_control)
        })
        .map(str::to_owned);
    Ok(CursorAuthStatus { auth, identity })
}

/// Parse the actual CLI's bounded human-readable model listing. Only rows between its
/// header and footer count; unknown output is an error, never a guessed catalog.
pub fn parse_models(text: &str) -> Result<Vec<ModelInfo>, ProviderError> {
    let mut found_header = false;
    let mut found_footer = false;
    let mut models = Vec::new();
    for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if line == "No models available for this account." {
            return Ok(Vec::new());
        }
        if line == "Available models" {
            found_header = true;
            continue;
        }
        if !found_header {
            continue;
        }
        if line.starts_with("Tip:") {
            found_footer = true;
            break;
        }
        let (row, is_default) = if let Some(row) = line.strip_suffix(" (current, default)") {
            (row, true)
        } else if let Some(row) = line.strip_suffix(" (default)") {
            (row, true)
        } else {
            (line.strip_suffix(" (current)").unwrap_or(line), false)
        };
        let named_row = row.split_once(" - ");
        let (id, name) = named_row.unwrap_or((row, row));
        if !valid_argument(id)
            || (named_row.is_none() && id.contains(char::is_whitespace))
            || name.chars().any(char::is_control)
        {
            return Err(ProviderError::Protocol(
                "Cursor returned an unrecognized model listing. Use /model in its terminal.".into(),
            ));
        }
        if !models.iter().any(|model: &ModelInfo| model.id == id) {
            models.push(ModelInfo {
                id: id.into(),
                display_name: if name == id {
                    id.into()
                } else {
                    format!("{name} ({id})")
                },
                is_default,
            });
        }
    }
    if !found_header || !found_footer || models.is_empty() {
        return Err(ProviderError::Protocol(
            "Cursor returned no recognizable models. Retry or use /model in its terminal.".into(),
        ));
    }
    Ok(models)
}

fn valid_argument(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 512
        && !value.starts_with('-')
        && !value.chars().any(char::is_control)
}

pub fn interactive_args(
    mode: PermissionMode,
    workspace: &Path,
    model: Option<&str>,
    resume: Option<&str>,
) -> Result<Vec<OsString>, ProviderError> {
    let mut args = vec![
        OsString::from("--workspace"),
        workspace.as_os_str().to_owned(),
    ];
    match mode {
        PermissionMode::Plan => args.extend(["--mode".into(), "plan".into()]),
        PermissionMode::Bypass => args.push("--force".into()),
        _ => {}
    }
    for (flag, value) in [("--model", model), ("--resume", resume)] {
        if let Some(value) = value {
            if !valid_argument(value)
                || (flag == "--resume" && !kalcode_contracts::ids::is_valid_id(value))
            {
                return Err(ProviderError::Start(format!(
                    "Cursor {flag} value is invalid."
                )));
            }
            args.extend([flag.into(), value.into()]);
        }
    }
    Ok(args)
}

pub fn permission_mappings() -> Vec<PermissionMapping> {
    [PermissionMode::Plan, PermissionMode::Approve, PermissionMode::Auto, PermissionMode::Bypass].into_iter().map(|mode| PermissionMapping {
        mode, fidelity: MappingFidelity::ApproximateStricter,
        provider_setting: match mode { PermissionMode::Plan => "--mode plan", PermissionMode::Bypass => "--force", _ => "Cursor native approvals" }.into(),
        notes: "Cursor owns its native permissions and explicit deny rules. KalCode does not answer its prompts.".into(),
    }).collect()
}

pub fn capabilities() -> ProviderCapabilities {
    ProviderCapabilities {
        streaming: true,
        interrupt: true,
        resume: true,
        host_approvals: false,
        models: Vec::new(),
        permission_mappings: permission_mappings(),
        interactive: Some(InteractiveSupport {
            launch_mappings: permission_mappings(),
            status_channels: vec![StatusChannel::Hooks, StatusChannel::ProcessOnly],
            kalcode_answers_approvals: false,
            resume: Some("agent --resume <chatId>".into()),
        }),
        tools: tools(),
    }
}

/// Cursor's native agent tools, as far as Cursor's CLI documentation states them. Tools Cursor
/// hasn't documented for its CLI are left out rather than claimed.
pub fn tools() -> Vec<ToolCapability> {
    let native = |kind, note: Option<&str>| ToolCapability {
        kind,
        availability: ToolAvailability::Native,
        provider_name: None,
        note: note.map(str::to_owned),
    };
    vec![
        native(
            ToolKind::Shell,
            Some("Cursor's own approvals and sandbox decide."),
        ),
        native(ToolKind::FileRead, None),
        native(ToolKind::FileEdit, Some("Plan makes no edits.")),
        native(ToolKind::RepoSearch, None),
        native(
            ToolKind::Mcp,
            Some("The MCP servers in your Cursor mcp.json load as in your terminal."),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_calendar_version_is_stable_build_identity_without_weakening_semver() {
        let found = parse_cli_version("Cursor Agent 2026.10.01-e373342\n").expect("version");
        assert_eq!(found.to_string(), "2026.10.1+e373342");
        assert!(!found.is_prerelease());
        assert!(found >= Version::new(2026, 10, 1));
        assert!(parse_cli_version("Cursor Agent 2026.13.01-e373342").is_none());
        assert!(parse_cli_version("Cursor Agent 2026.10.00-e373342").is_none());
        assert!(parse_cli_version("other2026.10.01-e373342").is_none());
        let double_digit_day =
            parse_cli_version("Cursor Agent 2026.10.11-e373342").expect("version");
        assert_eq!(double_digit_day.to_string(), "2026.10.11+e373342");
        assert!(!double_digit_day.is_prerelease());
        assert_eq!(
            parse_cli_version("cursor-agent 0.61.0")
                .expect("ordinary SemVer")
                .to_string(),
            "0.61.0"
        );
    }

    #[test]
    fn only_cursor_sign_in_wording_marks_a_session_signed_out() {
        let classify = |stderr| super::classify_probe_failure(stderr, "fallback").0;
        // Network failures on the way to Cursor's service keep the account signed in.
        for stderr in [
            "Error: request failed: certificate has expired",
            "fetch failed: unable to verify the first certificate (CERT_HAS_EXPIRED: expired)",
            "HTTP 407 Proxy Authentication Required",
            "proxy authentication failed for 10.0.0.1:8080",
            "SSL routines: tls session ticket expired",
        ] {
            assert_eq!(classify(stderr), "cursor_runtime_unavailable", "{stderr}");
        }
        // Cursor's own sign-in messages still require reconnecting.
        assert_eq!(
            classify("Error: Authentication required. Please run 'agent login' first."),
            "cursor_not_authenticated"
        );
        assert_eq!(
            classify("You are not logged in."),
            "cursor_not_authenticated"
        );
        for stderr in [
            "Error: Your session expired. Run agent login.",
            "Authentication failed: invalid token",
            "access token has expired",
        ] {
            assert_eq!(classify(stderr), "cursor_session_expired", "{stderr}");
        }
    }
    #[test]
    fn runtime_models_preserve_exact_ids_and_have_no_vendor_allowlist() {
        let models = parse_models("Available models\n\ncustom-deepseek-9 - Custom DeepSeek 9\nclaude-opus-4-8[effort=high] - Claude Opus 4.8 (current, default)\nTip: use --model <id>\n").expect("models");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "custom-deepseek-9");
        assert_eq!(models[1].id, "claude-opus-4-8[effort=high]");
        assert!(models[1].is_default);
        assert!(models[1].display_name.contains("4.8"));
        assert!(parse_models("Error: failed to load models").is_err());
        assert!(parse_models("Available models\nUnexpected output from server").is_err());
        assert!(
            parse_models("No models available for this account.")
                .expect("empty")
                .is_empty()
        );
        assert!(capabilities().models.is_empty());
    }

    #[test]
    fn status_parser_never_mistakes_unknown_or_failed_checks_for_logout() {
        assert_eq!(parse_auth_status(r#"{"status":"authenticated","isAuthenticated":true,"userInfo":{"email":"cursor@example.test"}}"#).expect("status").identity.as_deref(), Some("cursor@example.test"));
        assert_eq!(
            parse_auth_status(r#"{"status":"unauthenticated","isAuthenticated":false}"#)
                .expect("status")
                .auth,
            AuthState::NotAuthenticated
        );
        assert!(parse_auth_status(r#"{"status":"error"}"#).is_err());
        assert!(parse_auth_status(r#"{"loggedIn":true}"#).is_err());
    }

    #[test]
    fn launch_preserves_workspace_model_and_explicit_resume_without_headless_flags() {
        let id = "b2ae33ee-b39b-4e3b-87f4-bbdc859de9c8";
        let args = interactive_args(
            PermissionMode::Bypass,
            Path::new("workspace with spaces"),
            Some("custom-v9[effort=high]"),
            Some(id),
        )
        .expect("args");
        assert_eq!(
            args,
            [
                "--workspace",
                "workspace with spaces",
                "--force",
                "--model",
                "custom-v9[effort=high]",
                "--resume",
                id
            ]
            .map(OsString::from)
        );
        assert!(
            interactive_args(
                PermissionMode::Plan,
                Path::new("work"),
                Some("--force"),
                None
            )
            .is_err()
        );
        assert!(
            interactive_args(
                PermissionMode::Plan,
                Path::new("work"),
                None,
                Some("latest")
            )
            .is_err()
        );
    }
}
