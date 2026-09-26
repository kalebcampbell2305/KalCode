//! Provider diagnostics consume the canonical Provider Health snapshot. The Doctor never starts,
//! detects, signs in to, or otherwise contacts a provider.

use kalcode_contracts::health::{HealthState, Recoverability};

use super::{CheckDef, CheckOutput, FindingExt, clean, def, finding, show_command};
use crate::context::{ProviderFacts, RunContext};
use crate::types::{DoctorArea, FindingSeverity};

pub fn checks(ctx: &RunContext) -> Vec<CheckDef> {
    let Some(source) = ctx.providers.clone() else {
        return vec![def(
            "providers.health",
            DoctorArea::Providers,
            "Providers",
            |_| CheckOutput::could_not_check("Provider Health isn't running in this session."),
        )];
    };
    match source.providers() {
        Ok(list) if !list.is_empty() => list
            .into_iter()
            .map(|provider| {
                let id = format!("providers.{}", safe_id(&provider.id));
                let title = provider.display_name.clone();
                def(id, DoctorArea::Providers, title, move |_| {
                    check_provider(&provider)
                })
            })
            .collect(),
        Ok(_) => vec![def(
            "providers.health",
            DoctorArea::Providers,
            "Providers",
            |_| CheckOutput::skipped("KalCode knows no providers in this build."),
        )],
        Err(_) => vec![def(
            "providers.health",
            DoctorArea::Providers,
            "Providers",
            |_| CheckOutput::could_not_check("Provider Health couldn't provide a snapshot."),
        )],
    }
}

fn safe_id(id: &str) -> String {
    id.chars()
        .take(40)
        .map(|c| {
            if c.is_ascii_lowercase() || c.is_ascii_digit() || "-_".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn recovery_fix(provider: &ProviderFacts) -> Option<crate::types::FixOption> {
    let (code, label, description, command) = match provider.health.recoverability {
        Recoverability::Install | Recoverability::Update
            if !provider.install_command.is_empty() =>
        {
            (
                "show.install",
                "Show the install command",
                "Shows the provider's documented command. KalCode never installs or updates software itself.",
                provider.install_command.clone(),
            )
        }
        Recoverability::SignIn if !provider.sign_in_command.is_empty() => (
            "show.sign_in",
            "Show how to sign in",
            "Shows the provider's own sign-in command. KalCode never handles provider credentials.",
            provider.sign_in_command.clone(),
        ),
        _ => return None,
    };
    Some(show_command(
        code,
        label,
        description,
        command,
        "Your terminal",
    ))
}

fn check_provider(provider: &ProviderFacts) -> CheckOutput {
    let health = &provider.health;
    let code = |suffix: &str| format!("providers.{}.{suffix}", safe_id(&provider.id));
    let version = health.version.as_deref().unwrap_or("version unknown");
    if !provider.adapter_implemented {
        return CheckOutput::with(
            "Adapter unavailable",
            vec![finding(
                code("adapter_unavailable"),
                FindingSeverity::Info,
                format!("{} isn't supported by this build", provider.display_name),
                "The provider may be installed, but this KalCode build has no executable adapter for it.",
            )],
        );
    }
    match health.state {
        HealthState::Healthy => CheckOutput::passed(format!("{version} · healthy")),
        HealthState::Unknown => CheckOutput::could_not_check(
            "Provider Health has not observed enough current state to classify this provider.",
        ),
        HealthState::Degraded | HealthState::Unavailable => {
            let severity = if health.state == HealthState::Unavailable {
                FindingSeverity::Warning
            } else {
                FindingSeverity::Info
            };
            let reason_code = health.reason_code.as_deref().unwrap_or(
                if health.state == HealthState::Unavailable {
                    "unavailable"
                } else {
                    "degraded"
                },
            );
            let explanation = health
                .reason
                .as_deref()
                .map(|reason| clean(reason, 300))
                .unwrap_or_else(|| {
                    "Provider Health reported that this provider isn't ready for normal work."
                        .into()
                });
            let mut finding = finding(
                code(reason_code),
                severity,
                format!(
                    "{} is {}",
                    provider.display_name,
                    if health.state == HealthState::Unavailable {
                        "unavailable"
                    } else {
                        "degraded"
                    }
                ),
                explanation,
            )
            .detail("State code", reason_code)
            .detail("Version", version);
            if let Some(minimum) = &health.minimum_version {
                finding = finding.detail("Minimum supported", minimum);
            }
            if let Some(fix) = recovery_fix(provider) {
                finding = finding.fix(fix);
            }
            CheckOutput::with(
                if health.state == HealthState::Unavailable {
                    "Unavailable"
                } else {
                    "Degraded"
                },
                vec![finding],
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kalcode_contracts::agent::{AuthState, DetectionState, ProviderId};
    use kalcode_contracts::health::{CapacityState, HealthTrend, ProviderHealth};

    fn facts(state: HealthState, recoverability: Recoverability) -> ProviderFacts {
        ProviderFacts {
            id: "codex".into(),
            display_name: "Codex".into(),
            health: ProviderHealth {
                provider_id: ProviderId::new("codex"),
                display_name: "Codex".into(),
                state,
                detection: Some(DetectionState::Installed),
                auth: AuthState::Authenticated,
                account_label: None,
                version: Some("1.2.3".into()),
                minimum_version: Some("1.0.0".into()),
                models: Vec::new(),
                process_running: false,
                active_sessions: 0,
                latency_p50_ms: None,
                latency_p95_ms: None,
                latency_samples: 0,
                recent_failures: 0,
                last_failure: None,
                capacity: CapacityState::Available,
                backoff_until: None,
                trend: HealthTrend::InsufficientData,
                recoverability,
                reason_code: (state != HealthState::Healthy).then(|| "signed_out".into()),
                reason: (state != HealthState::Healthy)
                    .then(|| "Sign in with the provider's own program.".into()),
                checked_at: Some("2026-09-25T00:00:00Z".into()),
                observed_at: "2026-09-25T00:00:00Z".into(),
            },
            sign_in_command: "codex login".into(),
            install_command: "npm install --global @openai/codex".into(),
            adapter_implemented: true,
        }
    }

    #[test]
    fn canonical_health_states_become_truthful_results() {
        assert!(
            check_provider(&facts(HealthState::Healthy, Recoverability::None))
                .findings
                .is_empty()
        );
        let unavailable = check_provider(&facts(HealthState::Unavailable, Recoverability::SignIn));
        assert_eq!(unavailable.findings[0].code, "providers.codex.signed_out");
        assert!(unavailable.findings[0].fixes[0].show_command_only);
        let unknown = check_provider(&facts(HealthState::Unknown, Recoverability::Unknown));
        assert!(matches!(
            unknown.ended,
            super::super::Ended::CouldNotCheck(_)
        ));
    }
}
