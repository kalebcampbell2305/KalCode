//! The providers KalCode knows, with their documented detection, sign-in and permission facts.
//! Sources are cited in docs/PROVIDERS.md; every fact here was checked against the provider's
//! current official documentation and the installed CLI's `--help` (September 2026).

use kalcode_contracts::agent::{
    ModelInfo, ProviderCapabilities, ProviderId, ToolAvailability, ToolCapability, ToolKind,
};

use crate::claude::argv as claude_argv;
use crate::detect::{AuthProbe, AuthSignal, DetectionSpec};
use crate::env::EnvPolicy;
use crate::model::{AdapterState, ModelSource, ProviderStatus};

/// Homebrew prefixes (Apple silicon and Intel) — GUI apps on macOS don't inherit the shell
/// `PATH`, so these are checked explicitly.
pub(crate) const HOMEBREW: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

pub fn claude_spec() -> DetectionSpec {
    DetectionSpec {
        provider_id: ProviderId::CLAUDE_CODE,
        display_name: "Claude Code",
        executable: "claude",
        // Native installer launcher (`~/.local/bin/claude`, `%USERPROFILE%\.local\bin\claude.exe`
        // per the setup guide), then Homebrew.
        install_dirs: &[".local/bin", HOMEBREW[0], HOMEBREW[1]],
        appdata_dirs: &["npm"],
        local_appdata_dirs: &["Microsoft/WinGet/Links"],
        minimum_version: Some(claude_argv::MINIMUM_VERSION),
        // `claude auth status` is not a passive probe: Claude Code 2.1.x can begin an OAuth
        // refresh during startup and let this short-lived command exit before the rotated
        // credentials are durably written. Detect only installation/version here. Managed
        // accounts restore their persisted safe state; a real coding session is authoritative.
        auth: None,
        // The user's own environment, as in a native terminal (native provider parity).
        env_policy: EnvPolicy::NATIVE,
    }
}

pub fn codex_spec() -> DetectionSpec {
    DetectionSpec {
        provider_id: ProviderId::CODEX,
        display_name: "Codex",
        executable: "codex",
        install_dirs: &[HOMEBREW[0], HOMEBREW[1]],
        appdata_dirs: &["npm"],
        local_appdata_dirs: &[],
        // The headless adapter (exec --json, exec resume) was verified against codex-cli 0.155.1.
        minimum_version: Some(crate::codex::argv::MINIMUM_VERSION),
        // "Run `codex login status` to see the active authentication method." Exit codes aren't
        // documented, so only a leading "Logged in" (with exit 0) or "Not logged in" counts;
        // anything else is unknown.
        auth: Some(AuthProbe {
            args: &["login", "status"],
            signal: AuthSignal::StatusLine {
                signed_in: "Logged in",
                signed_out: "Not logged in",
            },
        }),
        // The user's own environment, as in a native terminal (native provider parity).
        env_policy: EnvPolicy::NATIVE,
    }
}

pub fn gemini_spec() -> DetectionSpec {
    DetectionSpec {
        provider_id: ProviderId::GEMINI_CLI,
        display_name: "Gemini CLI",
        executable: "gemini",
        install_dirs: &[HOMEBREW[0], HOMEBREW[1]],
        appdata_dirs: &["npm"],
        local_appdata_dirs: &[],
        // Not installed on the verification machine: no minimum is declared rather than a
        // guessed one. An older CLI that rejects a flag fails the turn visibly (never broader).
        minimum_version: None,
        // Gemini CLI documents no side-effect-free sign-in status command.
        auth: None,
        // The user's own environment, as in a native terminal (native provider parity).
        env_policy: EnvPolicy::NATIVE,
    }
}

pub fn specs() -> Vec<DetectionSpec> {
    vec![claude_spec(), codex_spec(), gemini_spec(), cursor_spec()]
}

pub fn cursor_spec() -> DetectionSpec {
    DetectionSpec {
        provider_id: ProviderId::CURSOR,
        display_name: "Cursor",
        // The official installer provides both agent and cursor-agent. Prefer the
        // unambiguous provider-specific name over unrelated programs called agent.
        executable: "cursor-agent",
        install_dirs: &[".local/bin"],
        appdata_dirs: &[],
        local_appdata_dirs: &["cursor-agent"],
        // Native Windows launcher, additive plugins and post-onboarding sessionStart
        // ordering were verified against official Cursor Agent 2026.10.01-e373342.
        minimum_version: Some(crate::version::Version::new(2026, 10, 1)),
        // The supported status command can refresh API-key credentials in its
        // dashboard middleware. Run it only for explicit account operations, never
        // as a short-lived passive/background installation probe.
        auth: None,
        env_policy: EnvPolicy::NATIVE,
    }
}

pub fn claude_capabilities() -> ProviderCapabilities {
    let model = |id: &str, name: &str, is_default| ModelInfo {
        id: id.to_owned(),
        display_name: name.to_owned(),
        is_default,
    };
    ProviderCapabilities {
        streaming: true,
        interrupt: true,
        resume: true,
        // Claude Code can route prompts to a host; KalCode answers them from Z4.
        host_approvals: false,
        // Documented aliases (model configuration guide); Claude Code resolves each to the
        // current model for the account.
        models: vec![
            model("default", "Account default", true),
            model("opus", "Opus", false),
            model("sonnet", "Sonnet", false),
            model("haiku", "Haiku", false),
            model("fable", "Fable", false),
        ],
        permission_mappings: claude_argv::permission_mappings(),
        // Provider panes (Z7-W4): how Claude Code runs interactively with the routing shipped
        // builds use. Codex and Gemini CLI declare theirs when their panes are wired.
        interactive: Some(crate::interactive::claude::interactive_support(
            crate::interactive::DEFAULT_DECISION_ROUTING,
        )),
        tools: claude_tools(),
    }
}

pub fn codex_capabilities() -> ProviderCapabilities {
    ProviderCapabilities {
        streaming: true,
        // Interrupt stops the running turn's process; the next message resumes the thread.
        interrupt: true,
        resume: true,
        // `codex exec` can't hand approvals to a host; app-server can (the planned surface).
        host_approvals: false,
        // Codex lists models only through app-server (`model/list`): none are shown.
        models: Vec::new(),
        permission_mappings: crate::codex::argv::permission_mappings(),
        interactive: Some(crate::interactive::codex::interactive_support()),
        tools: codex_tools(),
    }
}

pub fn gemini_capabilities() -> ProviderCapabilities {
    let model = |id: &str, name: &str, is_default| ModelInfo {
        id: id.to_owned(),
        display_name: name.to_owned(),
        is_default,
    };
    ProviderCapabilities {
        streaming: true,
        interrupt: true,
        resume: true,
        host_approvals: false,
        // Documented `--model` aliases (CLI reference); Gemini CLI resolves each.
        models: vec![
            model("auto", "Auto (default)", true),
            model("pro", "Pro", false),
            model("flash", "Flash", false),
            model("flash-lite", "Flash-Lite", false),
        ],
        permission_mappings: crate::gemini::permission_mappings(),
        interactive: Some(crate::interactive::gemini_interactive_support()),
        tools: gemini_tools(),
    }
}

fn tool(kind: ToolKind, name: &str, note: Option<&str>) -> ToolCapability {
    ToolCapability {
        kind,
        availability: ToolAvailability::Native,
        provider_name: Some(name.to_owned()),
        note: note.map(str::to_owned),
    }
}

fn needs_setup(kind: ToolKind, name: &str, detail: &str) -> ToolCapability {
    ToolCapability {
        kind,
        availability: ToolAvailability::NeedsSetup {
            detail: detail.to_owned(),
        },
        provider_name: Some(name.to_owned()),
        note: None,
    }
}

const PLAN_READS: &str = "Plan reads, researches and plans; it makes no edits.";

/// Claude Code's native tools inside KalCode (AGENTS.md "Permanent provider tool capability
/// rule"). Credential files stay unreadable in every mode.
pub fn claude_tools() -> Vec<ToolCapability> {
    vec![
        tool(ToolKind::Shell, "Bash / PowerShell", None),
        tool(
            ToolKind::FileRead,
            "Read",
            Some("Credential files such as .env and SSH keys stay unreadable."),
        ),
        tool(
            ToolKind::FileEdit,
            "Edit / Write",
            Some(
                "Plan makes no edits. In an Approve thread nobody can answer Claude Code's \
                 prompt, so edits are refused there; panes ask in Claude Code.",
            ),
        ),
        tool(ToolKind::RepoSearch, "Grep / Glob", None),
        tool(
            ToolKind::WebSearch,
            "WebSearch",
            Some("Available in every mode, Plan included."),
        ),
        tool(
            ToolKind::WebFetch,
            "WebFetch",
            Some("Available in every mode, Plan included."),
        ),
        tool(
            ToolKind::Mcp,
            "MCP",
            Some(
                "Your own MCP servers load as in your terminal. A repository's .mcp.json \
                 servers ask for trust in a pane and never start unasked in a headless thread.",
            ),
        ),
        tool(ToolKind::Subagents, "Agent", None),
        tool(ToolKind::Extensions, "Plugins / skills", None),
    ]
}

/// Codex's native tools inside KalCode: the person's own Codex config decides MCP servers, web
/// search, plugins and features, as in their terminal.
pub fn codex_tools() -> Vec<ToolCapability> {
    vec![
        tool(
            ToolKind::Shell,
            "exec_command",
            Some("Runs in Codex's sandbox for the selected mode."),
        ),
        tool(ToolKind::FileRead, "exec_command", None),
        tool(ToolKind::FileEdit, "apply_patch", Some(PLAN_READS)),
        tool(ToolKind::RepoSearch, "exec_command (rg)", None),
        tool(
            ToolKind::WebSearch,
            "web_search",
            Some("Follows the web_search setting in your Codex config."),
        ),
        ToolCapability {
            kind: ToolKind::WebFetch,
            availability: ToolAvailability::Unavailable {
                reason: "Codex has no page-fetch tool; it uses web_search, or the shell where \
                         the sandbox allows network access."
                    .into(),
            },
            provider_name: None,
            note: None,
        },
        tool(
            ToolKind::Mcp,
            "mcp_servers",
            Some("The MCP servers in your Codex config.toml load as in your terminal."),
        ),
        needs_setup(
            ToolKind::Subagents,
            "multi_agent",
            "Turn on Codex's multi-agent feature in your Codex config.",
        ),
        tool(ToolKind::Extensions, "plugins / skills", None),
    ]
}

/// Gemini CLI's native tools inside KalCode.
pub fn gemini_tools() -> Vec<ToolCapability> {
    vec![
        tool(ToolKind::Shell, "run_shell_command", None),
        tool(ToolKind::FileRead, "read_file", None),
        tool(ToolKind::FileEdit, "write_file / replace", Some(PLAN_READS)),
        tool(ToolKind::RepoSearch, "glob / search_file_content", None),
        tool(ToolKind::WebSearch, "google_web_search", None),
        tool(ToolKind::WebFetch, "web_fetch", None),
        tool(
            ToolKind::Mcp,
            "mcpServers",
            Some("The MCP servers in your Gemini settings load as in your terminal."),
        ),
        needs_setup(
            ToolKind::Subagents,
            "agents",
            "Gemini CLI's subagents are experimental; turn them on in your Gemini settings.",
        ),
        tool(ToolKind::Extensions, "extensions", None),
    ]
}

fn install_claude() -> &'static str {
    if cfg!(windows) {
        "irm https://claude.ai/install.ps1 | iex"
    } else {
        "curl -fsSL https://claude.ai/install.sh | bash"
    }
}

/// The static part of each provider's status (no detection yet).
pub fn statuses() -> Vec<ProviderStatus> {
    let claude = claude_spec();
    let codex = codex_spec();
    let gemini = gemini_spec();
    vec![
        ProviderStatus {
            id: ProviderId::new(claude.provider_id),
            display_name: claude.display_name.into(),
            detection: None,
            detection_error_code: None,
            auth_check: claude.auth_check_command(),
            capabilities: claude_capabilities(),
            adapter: AdapterState::Implemented,
            model_source: ModelSource::DocumentedAliases,
            integration: "Headless mode (claude -p) with stream-JSON input and output".into(),
            sign_in_command: "claude auth login".into(),
            install_command: install_claude().into(),
            docs_url: "https://code.claude.com/docs/en/setup".into(),
        },
        ProviderStatus {
            id: ProviderId::new(codex.provider_id),
            display_name: codex.display_name.into(),
            detection: None,
            detection_error_code: None,
            auth_check: codex.auth_check_command(),
            capabilities: codex_capabilities(),
            adapter: AdapterState::Implemented,
            model_source: ModelSource::NotDiscoverable,
            integration: "Headless mode (codex exec --json) with JSON Lines events, one process \
                          per turn resumed by thread id"
                .into(),
            sign_in_command: "codex login".into(),
            install_command: crate::codex::MANAGED_VERSIONS
                .install_command()
                .unwrap_or_else(|| "npm install -g @openai/codex".into()),
            docs_url: "https://github.com/openai/codex".into(),
        },
        ProviderStatus {
            id: ProviderId::new(gemini.provider_id),
            display_name: gemini.display_name.into(),
            detection: None,
            detection_error_code: None,
            auth_check: gemini.auth_check_command(),
            capabilities: gemini_capabilities(),
            adapter: AdapterState::Implemented,
            model_source: ModelSource::DocumentedAliases,
            integration: "Headless mode with --output-format stream-json, one process per turn \
                          resumed by session id"
                .into(),
            sign_in_command: "gemini".into(),
            install_command: crate::gemini::MANAGED_VERSIONS
                .install_command()
                .unwrap_or_else(|| "npm install -g @google/gemini-cli".into()),
            docs_url: "https://geminicli.com/docs/".into(),
        },
        ProviderStatus {
            id: ProviderId::new(ProviderId::CURSOR),
            display_name: "Cursor".into(),
            detection: None,
            detection_error_code: None,
            auth_check: Some("cursor-agent status --format json".into()),
            capabilities: crate::cursor::capabilities(),
            adapter: AdapterState::Implemented,
            model_source: ModelSource::Runtime,
            integration: "Native Cursor Agent in an interactive terminal; models discovered from the current account using agent models".into(),
            sign_in_command: "agent login".into(),
            install_command: if cfg!(windows) { "irm 'https://cursor.com/install?win32=true' | iex" } else { "curl https://cursor.com/install -fsS | bash" }.into(),
            docs_url: "https://cursor.com/docs/cli/installation".into(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::agent::MappingFidelity;
    use kalcode_contracts::permissions::PermissionMode;

    #[test]
    fn every_provider_maps_every_builtin_mode_without_hidden_bypass_flags() {
        for status in statuses() {
            let modes: Vec<_> = status
                .capabilities
                .permission_mappings
                .iter()
                .map(|m| m.mode)
                .collect();
            assert_eq!(
                modes,
                [
                    PermissionMode::Plan,
                    PermissionMode::Approve,
                    PermissionMode::Auto,
                    PermissionMode::Bypass
                ],
                "{}",
                status.id
            );
            for mapping in &status.capabilities.permission_mappings {
                assert_eq!(mapping.fidelity, MappingFidelity::ApproximateStricter);
                for broad in ["dangerously", "--approval-mode=yolo"] {
                    assert!(
                        !mapping.provider_setting.contains(broad),
                        "{}: {}",
                        status.id,
                        mapping.provider_setting
                    );
                }
                // Bypass runs without approvals (owner directive 2026-10-03); no other mode
                // uses a provider's no-prompt setting.
                if mapping.mode != PermissionMode::Bypass {
                    for broad in ["bypassPermissions", "yolo"] {
                        assert!(
                            !mapping.provider_setting.contains(broad),
                            "{}: {}",
                            status.id,
                            mapping.provider_setting
                        );
                    }
                }
                let codex_native_bypass = status.id.as_str() == ProviderId::CODEX
                    && mapping.mode == PermissionMode::Bypass;
                assert_eq!(
                    mapping.provider_setting.contains("danger-full-access"),
                    codex_native_bypass,
                    "danger-full-access is the documented Codex Bypass mapping only: {} {:?}",
                    status.id,
                    mapping.mode
                );
            }
        }
    }

    #[test]
    fn capabilities_are_only_claimed_for_implemented_adapters() {
        for status in statuses() {
            let caps = &status.capabilities;
            if status.adapter == AdapterState::Planned {
                assert!(
                    !(caps.streaming || caps.interrupt || caps.resume || caps.host_approvals),
                    "{}",
                    status.id
                );
            }
            assert!(!caps.host_approvals, "host approvals arrive in Z4");
        }
    }

    #[test]
    fn auth_checks_are_documented_commands() {
        let checks: Vec<_> = statuses().into_iter().map(|s| s.auth_check).collect();
        assert_eq!(
            checks,
            [
                None,
                Some("codex login status".to_owned()),
                None,
                Some("cursor-agent status --format json".to_owned())
            ]
        );
    }
}
