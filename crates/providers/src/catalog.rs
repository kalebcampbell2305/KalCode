//! The providers KalCode knows, with their documented detection, sign-in and permission facts.
//! Sources are cited in docs/PROVIDERS.md; every fact here was checked against the provider's
//! current official documentation and the installed CLI's `--help` (September 2026).

use kalcode_contracts::agent::{
    MappingFidelity, ModelInfo, PermissionMapping, ProviderCapabilities, ProviderId,
};
use kalcode_contracts::permissions::PermissionMode;

use crate::claude::argv as claude_argv;
use crate::detect::{AuthProbe, AuthSignal, DetectionSpec};
use crate::env::EnvPolicy;
use crate::model::{AdapterState, ModelSource, ProviderStatus};

/// Homebrew prefixes (Apple silicon and Intel) — GUI apps on macOS don't inherit the shell
/// `PATH`, so these are checked explicitly.
const HOMEBREW: [&str; 2] = ["/opt/homebrew/bin", "/usr/local/bin"];

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
        // CLI reference: "Show authentication status as JSON ... Exits with code 0 if logged
        // in, 1 if not." Only the exit code is used; the output (account details) is discarded.
        auth: Some(AuthProbe {
            args: &["auth", "status"],
            signal: AuthSignal::ExitCode,
        }),
        env_policy: EnvPolicy {
            provider_prefixes: &["ANTHROPIC_", "CLAUDE_"],
            provider_names: &[],
        },
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
        // Set when the Codex adapter is built.
        minimum_version: None,
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
        env_policy: EnvPolicy {
            provider_prefixes: &["OPENAI_", "CODEX_"],
            provider_names: &[],
        },
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
        minimum_version: None,
        // Gemini CLI documents no side-effect-free sign-in status command.
        auth: None,
        env_policy: EnvPolicy {
            provider_prefixes: &["GEMINI_", "GOOGLE_"],
            provider_names: &[],
        },
    }
}

pub fn specs() -> Vec<DetectionSpec> {
    vec![claude_spec(), codex_spec(), gemini_spec()]
}

fn mapping(
    mode: PermissionMode,
    fidelity: MappingFidelity,
    setting: &str,
    notes: &str,
) -> PermissionMapping {
    PermissionMapping {
        mode,
        fidelity,
        provider_setting: setting.to_owned(),
        notes: notes.to_owned(),
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
        interactive: None,
    }
}

pub fn codex_capabilities() -> ProviderCapabilities {
    use MappingFidelity::ApproximateStricter as Stricter;
    use PermissionMode::*;
    let read_only = "--sandbox read-only --ask-for-approval never";
    ProviderCapabilities {
        streaming: false,
        interrupt: false,
        resume: false,
        host_approvals: false,
        models: Vec::new(),
        permission_mappings: vec![
            mapping(
                Plan,
                Stricter,
                read_only,
                "Reads and commands run inside Codex's read-only sandbox; anything that needs \
                 more is refused.",
            ),
            mapping(
                Approve,
                Stricter,
                read_only,
                "Edits are refused instead of asking until KalCode can answer Codex approval \
                 requests.",
            ),
            mapping(
                Auto,
                Stricter,
                read_only,
                "Runs like Approve until KalCode's policy engine can answer Codex approval \
                 requests.",
            ),
            mapping(
                Bypass,
                Stricter,
                "--sandbox workspace-write --ask-for-approval never",
                "Edits and commands inside the workspace, with network access off (Codex's \
                 default). danger-full-access is never used.",
            ),
        ],
        interactive: None,
    }
}

pub fn gemini_capabilities() -> ProviderCapabilities {
    use MappingFidelity::ApproximateStricter as Stricter;
    use PermissionMode::*;
    ProviderCapabilities {
        streaming: false,
        interrupt: false,
        resume: false,
        host_approvals: false,
        models: Vec::new(),
        permission_mappings: vec![
            mapping(
                Plan,
                Stricter,
                "--approval-mode plan",
                "Gemini CLI's read-only plan mode.",
            ),
            mapping(
                Approve,
                Stricter,
                "--approval-mode default",
                "Tool calls that need confirmation can't be answered in headless mode, so they \
                 don't run.",
            ),
            mapping(
                Auto,
                Stricter,
                "--approval-mode default",
                "Runs like Approve until KalCode's policy engine exists.",
            ),
            mapping(
                Bypass,
                Stricter,
                "--approval-mode auto_edit",
                "File edits are approved automatically; other tools don't run. yolo mode is \
                 never used.",
            ),
        ],
        interactive: None,
    }
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
            adapter: AdapterState::Planned,
            model_source: ModelSource::NotDiscoverable,
            integration: "codex exec --json (JSON Lines events), or codex app-server (JSON-RPC \
                          with host approvals)"
                .into(),
            sign_in_command: "codex login".into(),
            install_command: "npm install -g @openai/codex".into(),
            docs_url: "https://github.com/openai/codex".into(),
        },
        ProviderStatus {
            id: ProviderId::new(gemini.provider_id),
            display_name: gemini.display_name.into(),
            detection: None,
            detection_error_code: None,
            auth_check: gemini.auth_check_command(),
            capabilities: gemini_capabilities(),
            adapter: AdapterState::Planned,
            model_source: ModelSource::NotDiscoverable,
            integration: "Headless mode (gemini -p) with --output-format stream-json".into(),
            sign_in_command: "gemini".into(),
            install_command: "npm install -g @google/gemini-cli".into(),
            docs_url: "https://geminicli.com/docs/".into(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_maps_every_builtin_mode_never_as_exact_without_host_approvals() {
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
                for broad in [
                    "bypassPermissions",
                    "dangerously",
                    "danger-full-access",
                    "yolo",
                    "--approval-mode=yolo",
                ] {
                    assert!(
                        !mapping.provider_setting.contains(broad),
                        "{}: {}",
                        status.id,
                        mapping.provider_setting
                    );
                }
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
                Some("claude auth status".to_owned()),
                Some("codex login status".to_owned()),
                None
            ]
        );
    }
}
