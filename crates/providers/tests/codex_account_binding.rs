//! Account-binding regressions for the headless CLI adapters.
//!
//! These tests use only synthetic configuration and never invoke a provider.

#![allow(clippy::expect_used, clippy::panic)]

use kalcode_contracts::agent::{AgentProvider, ProviderError, SessionConfig};
use kalcode_contracts::permissions::PermissionMode;
use kalcode_providers::{CodexProvider, DetectEnv, GeminiProvider};

#[test]
fn unmanaged_codex_rejects_an_explicit_account_before_standalone_detection() {
    let workspace = tempfile::tempdir().expect("workspace");
    let provider = CodexProvider::new(DetectEnv::default());

    let result = provider.start_session(
        SessionConfig {
            thread_id: kalcode_contracts::ids::new_id(),
            workspace_id: kalcode_contracts::ids::new_id(),
            provider_account_id: Some(kalcode_contracts::ids::new_id()),
            working_directory: workspace.path().display().to_string(),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Approve,
            resume_session_id: None,
            secret_ref: None,
        },
        Box::new(|_| {}),
    );

    let error = match result {
        Ok(_) => panic!("an account-bound session must not inherit standalone Codex state"),
        Err(error) => error,
    };
    assert_eq!(
        error,
        ProviderError::Start("A managed provider profile is required for this account.".into())
    );
}

#[test]
fn unmanaged_gemini_rejects_an_explicit_account_before_standalone_detection() {
    let workspace = tempfile::tempdir().expect("workspace");
    let provider = GeminiProvider::new(DetectEnv::default());

    let result = provider.start_session(
        SessionConfig {
            thread_id: kalcode_contracts::ids::new_id(),
            workspace_id: kalcode_contracts::ids::new_id(),
            provider_account_id: Some(kalcode_contracts::ids::new_id()),
            working_directory: workspace.path().display().to_string(),
            model: None,
            effort: None,
            permission_mode: PermissionMode::Approve,
            resume_session_id: None,
            secret_ref: None,
        },
        Box::new(|_| {}),
    );

    let error = match result {
        Ok(_) => panic!("an account-bound session must not inherit standalone Gemini state"),
        Err(error) => error,
    };
    assert_eq!(
        error,
        ProviderError::Start("A managed provider profile is required for this account.".into())
    );
}
