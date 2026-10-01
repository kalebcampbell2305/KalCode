//! Credential-free managed-provider identities for the explicitly attested native E2E app.
//!
//! The fixture uses the canonical account and managed-profile authorities. It creates no provider
//! credential and never invokes a real provider login; Gemini's profile gets only an opaque
//! stand-in for its encrypted sign-in store, which KalCode checks for presence. Codex's synthetic
//! consumer-plan observation enters through the same generation-fenced observer as app-server
//! account truth.

use std::path::Path;

use kalcode_contracts::agent::{AuthState, ProviderId};
use kalcode_contracts::provider_accounts::ProviderAccount;
use kalcode_providers::account_auth::{CodexAccountState, CodexChatGptAccount};
use kalcode_providers::accounts::AccountStore;

use super::ProviderRuntimeAuthority;

const FIXTURE_LABEL: &str = "E2E fixture";
const FIXTURE_IDENTITY: &str = "kalcode-provider-e2e.invalid";
const CODEX_FIXTURE_EMAIL: &str = "kalcode-provider-e2e@invalid.example";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct E2eProviderFixtureError {
    pub(super) code: &'static str,
}

impl std::fmt::Display for E2eProviderFixtureError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("The isolated provider E2E fixture could not be prepared.")
    }
}

impl std::error::Error for E2eProviderFixtureError {}

pub(super) fn seed_from_environment(
    runtime: &ProviderRuntimeAuthority,
    data_dir: &Path,
) -> Result<(), E2eProviderFixtureError> {
    let attested = crate::account::e2e::provider_fixture_is_attested(data_dir)
        .map_err(|_| failure("provider_e2e_attestation_failed"))?;
    if !attested {
        return Ok(());
    }
    seed_attested(runtime)
}

fn seed_attested(runtime: &ProviderRuntimeAuthority) -> Result<(), E2eProviderFixtureError> {
    let store = runtime.account_store();
    for provider in [
        ProviderId::CLAUDE_CODE,
        ProviderId::CODEX,
        ProviderId::GEMINI_CLI,
    ] {
        let account = ensure_default_account(&store, provider)?;
        let home = runtime
            .managed_profiles()
            .profile_home(provider, &account.id)
            .map_err(|_| failure("provider_e2e_profile_failed"))?;
        if provider == ProviderId::GEMINI_CLI {
            mark_gemini_signed_in(&home)?;
        }
        if provider == ProviderId::CODEX {
            observe_codex_consumer(runtime, &account)?;
        } else {
            store
                .mark_authentication(
                    &account.id,
                    AuthState::Authenticated,
                    Some(FIXTURE_IDENTITY),
                    None,
                )
                .map_err(|_| failure("provider_e2e_auth_state_failed"))?;
        }
    }
    Ok(())
}

/// Managed Gemini starts only when the profile holds Gemini's encrypted sign-in store
/// (`gemini_account_auth::credential_state`), so the fixture places an opaque stand-in there,
/// exactly as the provider crate's managed-policy tests do. KalCode never reads its contents and
/// the fake provider ignores it; it holds no credential. Idempotent: an existing file is kept.
fn mark_gemini_signed_in(home: &Path) -> Result<(), E2eProviderFixtureError> {
    let directory = home.join(".gemini");
    std::fs::create_dir_all(&directory)
        .map_err(|_| failure("provider_e2e_gemini_sign_in_failed"))?;
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join(kalcode_providers::gemini_account_auth::ENCRYPTED_CREDENTIALS_FILE))
    {
        Ok(mut file) => std::io::Write::write_all(&mut file, b"kalcode-e2e-opaque\n")
            .map_err(|_| failure("provider_e2e_gemini_sign_in_failed")),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(_) => Err(failure("provider_e2e_gemini_sign_in_failed")),
    }
}

fn ensure_default_account(
    store: &AccountStore,
    provider: &str,
) -> Result<ProviderAccount, E2eProviderFixtureError> {
    if let Some(account) = store
        .default_for(provider)
        .map_err(|_| failure("provider_e2e_account_failed"))?
    {
        return Ok(account);
    }
    if !store
        .list(Some(provider))
        .map_err(|_| failure("provider_e2e_account_failed"))?
        .is_empty()
    {
        return Err(failure("provider_e2e_default_missing"));
    }
    store
        .create(provider, FIXTURE_LABEL)
        .map_err(|_| failure("provider_e2e_account_failed"))
}

fn observe_codex_consumer(
    runtime: &ProviderRuntimeAuthority,
    account: &ProviderAccount,
) -> Result<(), E2eProviderFixtureError> {
    let operation = runtime
        .begin_codex_operation(&account.id)
        .map_err(|_| failure("provider_e2e_codex_truth_failed"))?;
    let observation = Ok(CodexAccountState {
        account: Some(CodexChatGptAccount {
            email: Some(CODEX_FIXTURE_EMAIL.into()),
            plan_type: "pro".into(),
        }),
        requires_openai_auth: true,
    });
    let result = runtime
        .observe_codex(&account.id, operation.generation, &observation)
        .map_err(|_| failure("provider_e2e_codex_truth_failed"));
    drop(operation);
    result
}

const fn failure(code: &'static str) -> E2eProviderFixtureError {
    E2eProviderFixtureError { code }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use kalcode_contracts::agent::AuthState;
    use kalcode_core::flags::BuildChannel;
    use kalcode_core::{Core, CoreConfig, Paths};
    use kalcode_providers::codex::managed_policy::CloudConfigEligibility;

    use super::*;

    struct Fixture {
        _temp: tempfile::TempDir,
        runtime: ProviderRuntimeAuthority,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().expect("temp");
            let temp_root = if cfg!(target_os = "macos") {
                temp.path().canonicalize().expect("canonical temp")
            } else {
                temp.path().to_path_buf()
            };
            let core = Arc::new(
                Core::open(CoreConfig {
                    paths: Paths::new(&temp_root),
                    app_version: "0.0.0-provider-e2e-test".into(),
                    channel: BuildChannel::Development,
                })
                .expect("core"),
            );
            let test_executable = std::env::current_exe().expect("test executable");
            let helper = test_executable
                .parent()
                .and_then(|deps| deps.parent())
                .expect("Cargo target directory")
                .join(if cfg!(windows) {
                    "kalcode-provider-guardian.exe"
                } else {
                    "kalcode-provider-guardian"
                });
            let runtime = ProviderRuntimeAuthority::start_with_helper(core, &temp_root, &helper)
                .expect("runtime authority");
            Self {
                _temp: temp,
                runtime,
            }
        }
    }

    #[test]
    fn attested_seed_uses_canonical_accounts_profiles_and_codex_truth() {
        let fixture = Fixture::new();
        seed_attested(&fixture.runtime).expect("seed fixture");
        let store = fixture.runtime.account_store();

        for provider in [
            ProviderId::CLAUDE_CODE,
            ProviderId::CODEX,
            ProviderId::GEMINI_CLI,
        ] {
            let accounts = store.list(Some(provider)).expect("provider accounts");
            assert_eq!(accounts.len(), 1);
            let account = &accounts[0];
            assert!(account.is_default);
            assert_eq!(account.authentication_state, AuthState::Authenticated);
            assert!(
                fixture
                    .runtime
                    .managed_profiles()
                    .profile_home(provider, &account.id)
                    .expect("profile home")
                    .is_dir()
            );
        }

        // Managed Gemini refuses to start without its sign-in store; the seeded account must pass
        // that same check the thread launch performs.
        let gemini = store
            .default_for(ProviderId::GEMINI_CLI)
            .expect("gemini default")
            .expect("gemini account");
        assert_eq!(
            kalcode_providers::gemini_account_auth::credential_state(
                &fixture.runtime.managed_profiles(),
                &gemini.id,
            )
            .expect("gemini credential state"),
            AuthState::Authenticated
        );

        let codex = store
            .default_for(ProviderId::CODEX)
            .expect("codex default")
            .expect("codex account");
        assert_eq!(
            fixture
                .runtime
                .cached_codex_eligibility(&codex.id)
                .expect("fresh Codex truth"),
            CloudConfigEligibility::Ineligible
        );
    }

    #[test]
    fn repeated_seed_is_idempotent() {
        let fixture = Fixture::new();
        seed_attested(&fixture.runtime).expect("first seed");
        let first_ids: Vec<_> = fixture
            .runtime
            .account_store()
            .list(None)
            .expect("first accounts")
            .into_iter()
            .map(|account| account.id)
            .collect();

        seed_attested(&fixture.runtime).expect("second seed");
        let second_ids: Vec<_> = fixture
            .runtime
            .account_store()
            .list(None)
            .expect("second accounts")
            .into_iter()
            .map(|account| account.id)
            .collect();
        assert_eq!(second_ids, first_ids);
        assert_eq!(second_ids.len(), 3);
    }
}
