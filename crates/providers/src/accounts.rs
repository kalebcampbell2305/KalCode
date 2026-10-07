//! Credential-free provider account metadata and deterministic account binding resolution.
//!
//! Authentication material remains in provider-native managed profiles or the OS secure store.
//! This store persists labels, adapter-reported status metadata, defaults, and scoped bindings in
//! the canonical [`Core`] database. It never reads or deletes credentials; launch preparation may
//! repair bounded, non-secret provider setup metadata under the canonical profile lease.

use std::sync::Arc;

use kalcode_contracts::agent::{AuthState, ProviderError, ProviderId};
use kalcode_contracts::provider_accounts::{
    MAX_ACCOUNT_LABEL_CHARS, MAX_PROVIDER_ERROR_CODE_CHARS, MAX_PROVIDER_IDENTITY_CHARS,
    ProviderAccount, ProviderAccountBinding, ProviderAccountBindingKind, ProviderAccountScopes,
};
use kalcode_core::plans::PlanLimit;
use kalcode_core::time::now_rfc3339;
use kalcode_core::{Core, ErrorCategory, KalError, Result};
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::managed::{ManagedProfiles, ProfileLease, ProfileLifecycleLeaseError};

const ACCOUNT_COLUMNS: &str = "id, provider_id, display_name, provider_reported_identity, \
authentication_state, is_default, created_at, last_used_at, last_checked_at, last_error_code, \
archived_at";

#[derive(Clone)]
pub struct AccountStore {
    core: Arc<Core>,
}

impl AccountStore {
    pub fn new(core: Arc<Core>) -> Self {
        Self { core }
    }

    /// Active accounts, ordered deterministically. Archived tombstones remain available through
    /// [`Self::get`] for historical thread display but never appear here.
    pub fn list(&self, provider: Option<&str>) -> Result<Vec<ProviderAccount>> {
        let provider = provider.map(checked_provider).transpose()?;
        self.core.read(|conn| {
            let sql = match provider {
                Some(_) => format!(
                    "SELECT {ACCOUNT_COLUMNS} FROM provider_accounts
                     WHERE archived_at IS NULL AND provider_id = ?1
                     ORDER BY is_default DESC, display_name COLLATE NOCASE, id"
                ),
                None => format!(
                    "SELECT {ACCOUNT_COLUMNS} FROM provider_accounts
                     WHERE archived_at IS NULL
                     ORDER BY provider_id, is_default DESC, display_name COLLATE NOCASE, id"
                ),
            };
            let mut statement = conn.prepare(&sql)?;
            let rows = match &provider {
                Some(provider) => statement.query_map([provider.as_str()], row_to_account)?,
                None => statement.query_map([], row_to_account)?,
            };
            Ok(rows.collect::<std::result::Result<_, _>>()?)
        })
    }

    /// Gets active or archived metadata by stable account id.
    pub fn get(&self, id: &str) -> Result<ProviderAccount> {
        check_id(id)?;
        self.core.read(|conn| get_account(conn, id))
    }

    /// Gets active metadata only when the stable id belongs to the requested provider.
    ///
    /// Passive startup restoration uses this instead of [`Self::get`] so archived tombstones and
    /// cross-provider ids can never re-enter an active account surface.
    pub fn get_active_for_provider(
        &self,
        id: &str,
        provider: &ProviderId,
    ) -> Result<ProviderAccount> {
        check_id(id)?;
        self.core
            .read(|conn| get_active_account_for_provider(conn, id, provider))
    }

    pub fn create(&self, provider: &str, label: &str) -> Result<ProviderAccount> {
        self.create_limited(provider, label, None)
    }

    /// [`Self::create`] under the plan's cap on connected accounts across every provider. Only
    /// a new account is refused; existing accounts are never archived or removed.
    pub fn create_limited(
        &self,
        provider: &str,
        label: &str,
        limit: Option<PlanLimit>,
    ) -> Result<ProviderAccount> {
        let provider = checked_provider(provider)?;
        let label = checked_label(label)?;
        let id = kalcode_contracts::ids::new_id();
        let created_at = now_rfc3339();
        let (account, _) = self.core.transact(|tx| {
            if provider.as_str() == ProviderId::CURSOR {
                let exists: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM provider_accounts WHERE provider_id = 'cursor' AND archived_at IS NULL)",
                    [],
                    |row| row.get(0),
                )?;
                if exists {
                    return Err(KalError::validation(
                        "cursor_native_account_exists",
                        "Cursor uses its current native sign-in. Reconnect the existing Cursor account to switch accounts.",
                    ));
                }
            }
            if let Some(limit) = limit {
                let connected: i64 = tx.query_row(
                    "SELECT COUNT(*) FROM provider_accounts WHERE archived_at IS NULL",
                    [],
                    |row| row.get(0),
                )?;
                limit.admit(connected)?;
            }
            ensure_label_available(tx, provider.as_str(), &label, None)?;
            let is_default = tx.query_row(
                "SELECT NOT EXISTS(
                       SELECT 1 FROM provider_accounts
                       WHERE provider_id = ?1 AND archived_at IS NULL AND is_default = 1
                     )",
                [provider.as_str()],
                |row| row.get::<_, bool>(0),
            )?;
            tx.execute(
                "INSERT INTO provider_accounts (
                   id, provider_id, display_name, provider_reported_identity,
                   authentication_state, is_default, created_at, last_used_at,
                   last_checked_at, last_error_code, archived_at
                 ) VALUES (?1, ?2, ?3, NULL, 'unknown', ?4, ?5, NULL, NULL, NULL, NULL)",
                params![id, provider.as_str(), label, is_default, created_at],
            )?;
            Ok((get_account(tx, &id)?, Vec::new()))
        })?;
        Ok(account)
    }

    pub fn rename(&self, id: &str, label: &str) -> Result<ProviderAccount> {
        check_id(id)?;
        let label = checked_label(label)?;
        let (account, _) = self.core.transact(|tx| {
            let current = get_active_account(tx, id)?;
            ensure_label_available(tx, current.provider_id.as_str(), &label, Some(id))?;
            tx.execute(
                "UPDATE provider_accounts SET display_name = ?2 WHERE id = ?1",
                params![id, label],
            )?;
            Ok((get_account(tx, id)?, Vec::new()))
        })?;
        Ok(account)
    }

    pub fn set_default(&self, id: &str) -> Result<ProviderAccount> {
        check_id(id)?;
        let (account, _) = self.core.transact(|tx| {
            let current = get_active_account(tx, id)?;
            tx.execute(
                "UPDATE provider_accounts SET is_default = 0
                 WHERE provider_id = ?1 AND archived_at IS NULL AND is_default = 1",
                [current.provider_id.as_str()],
            )?;
            tx.execute(
                "UPDATE provider_accounts SET is_default = 1
                 WHERE id = ?1 AND archived_at IS NULL",
                [id],
            )?;
            Ok((get_account(tx, id)?, Vec::new()))
        })?;
        Ok(account)
    }

    pub fn default_for(&self, provider: &str) -> Result<Option<ProviderAccount>> {
        let provider = checked_provider(provider)?;
        self.core.read(|conn| {
            conn.query_row(
                &format!(
                    "SELECT {ACCOUNT_COLUMNS} FROM provider_accounts
                     WHERE provider_id = ?1 AND archived_at IS NULL AND is_default = 1"
                ),
                [provider.as_str()],
                row_to_account,
            )
            .optional()
            .map_err(Into::into)
        })
    }

    /// Archives local metadata while holding the account profile's exclusive lifecycle lease.
    /// Existing sessions and sign-in operations therefore block the archive. Provider profiles,
    /// auth files, secure-store entries, and installations are never read or removed.
    pub fn archive(&self, profiles: &ManagedProfiles, id: &str) -> Result<ProviderAccount> {
        check_id(id)?;
        let before = self.get(id)?;
        if before.archived_at.is_some() {
            return Ok(before);
        }
        let _lease = profiles
            .acquire_account_lifecycle_lease(before.provider_id.as_str(), id)
            .map_err(profile_lifecycle_error)?;
        let archived_at = now_rfc3339();
        let (account, _) = self.core.transact(|tx| {
            let current = get_account(tx, id)?;
            if current.archived_at.is_some() {
                return Ok((current, Vec::new()));
            }
            tx.execute(
                "DELETE FROM provider_account_bindings WHERE account_id = ?1",
                [id],
            )?;
            tx.execute(
                "UPDATE provider_accounts
                 SET archived_at = ?2, is_default = 0
                 WHERE id = ?1 AND archived_at IS NULL",
                params![id, archived_at],
            )?;
            ensure_provider_default(tx, current.provider_id.as_str())?;
            Ok((get_account(tx, id)?, Vec::new()))
        })?;
        Ok(account)
    }

    /// Executes one provider launch only after the selected account has been checked active and
    /// provider-matched while its shared profile lease is held. The preliminary check prevents a
    /// malformed/cross-provider id from creating profile directories; the second check is the
    /// authoritative one that closes the archive-vs-start race.
    pub fn launch_with_active_account<T>(
        &self,
        profiles: &ManagedProfiles,
        provider: &str,
        account_id: &str,
        launch: impl FnOnce(&ProviderAccount) -> std::result::Result<T, ProviderError>,
    ) -> std::result::Result<T, ProviderError> {
        let provider = checked_provider(provider).map_err(account_launch_error)?;
        check_id(account_id).map_err(account_launch_error)?;
        let initial = self
            .core
            .read(|conn| get_active_account_for_provider(conn, account_id, &provider))
            .map_err(account_launch_error)?;
        if provider.as_str() == ProviderId::CLAUDE_CODE
            && initial.authentication_state == AuthState::Authenticated
        {
            crate::claude::onboarding::prepare_connected_profile(profiles, account_id, || {
                self.authenticate_with_active_account(
                    profiles,
                    provider.as_str(),
                    account_id,
                    |current, lease| {
                        if current.authentication_state != AuthState::Authenticated {
                            return Err(ProviderError::NotAuthenticated);
                        }
                        crate::claude::onboarding::complete_with_lease(profiles, account_id, &lease)
                    },
                )
            })?;
        }
        let _lease = profiles.acquire_session_lease(provider.as_str(), account_id)?;
        let account = self
            .core
            .read(|conn| get_active_account_for_provider(conn, account_id, &provider))
            .map_err(account_launch_error)?;
        if account.authentication_state == AuthState::NotAuthenticated {
            return Err(ProviderError::NotAuthenticated);
        }
        let launched = match launch(&account) {
            Ok(launched) => launched,
            Err(ProviderError::NotAuthenticated) => {
                // A real provider launch is authoritative evidence that this exact native session
                // expired. Clear only this account; startup and transient probes never do this.
                self.mark_authentication(account_id, AuthState::NotAuthenticated, None, None)
                    .map_err(account_launch_error)?;
                return Err(ProviderError::NotAuthenticated);
            }
            Err(error) => {
                if matches!(
                    &error,
                    ProviderError::Start(_)
                        | ProviderError::Io(_)
                        | ProviderError::Protocol(_)
                        | ProviderError::SessionEnded
                ) {
                    // A failed launch is not evidence of expiry. Preserve the last safe auth and
                    // identity while surfacing a truthful transient error state.
                    self.mark_validation_error(account_id, "provider_launch_failed")
                        .map_err(account_launch_error)?;
                }
                return Err(error);
            }
        };
        if let Err(error) = self.mark_used(account_id) {
            // A successfully-created runtime must not escape when its authoritative account
            // metadata could not record the launch. Dropping it while the shared lease is still
            // held lets the adapter terminate its process before another lifecycle operation.
            drop(launched);
            return Err(account_launch_error(error));
        }
        Ok(launched)
    }

    /// Executes a credential-read-only background observer under the exact account's shared
    /// observer lease. Explicit sign-in, sign-out, and archive operations cancel and drain this
    /// lease through [`ManagedProfiles`] before taking their exclusive writer lease.
    pub fn observe_with_active_account<T>(
        &self,
        profiles: &ManagedProfiles,
        provider: &str,
        account_id: &str,
        observe: impl FnOnce(&ProviderAccount, ProfileLease) -> std::result::Result<T, ProviderError>,
    ) -> std::result::Result<T, ProviderError> {
        let provider = checked_provider(provider).map_err(account_launch_error)?;
        check_id(account_id).map_err(account_launch_error)?;
        self.core
            .read(|conn| get_active_account_for_provider(conn, account_id, &provider))
            .map_err(account_launch_error)?;
        let lease = profiles.acquire_observer_lease(provider.as_str(), account_id)?;
        let account = self
            .core
            .read(|conn| get_active_account_for_provider(conn, account_id, &provider))
            .map_err(account_launch_error)?;
        observe(&account, lease)
    }

    /// Executes one bounded authentication operation with the exact account's exclusive profile
    /// lease. The account is checked before filesystem creation and authoritatively rechecked
    /// after locking, so archive/auth and cross-provider races fail closed.
    pub fn authenticate_with_active_account<T>(
        &self,
        profiles: &ManagedProfiles,
        provider: &str,
        account_id: &str,
        authenticate: impl FnOnce(
            &ProviderAccount,
            crate::managed::ProfileLease,
        ) -> std::result::Result<T, ProviderError>,
    ) -> std::result::Result<T, ProviderError> {
        let provider = checked_provider(provider).map_err(account_launch_error)?;
        check_id(account_id).map_err(account_launch_error)?;
        self.core
            .read(|conn| get_active_account_for_provider(conn, account_id, &provider))
            .map_err(account_launch_error)?;
        let lease = profiles.acquire_sign_in_lease(provider.as_str(), account_id)?;
        let account = self
            .core
            .read(|conn| get_active_account_for_provider(conn, account_id, &provider))
            .map_err(account_launch_error)?;
        authenticate(&account, lease)
    }

    /// Trusted adapter-only status update. No provider response, identity, or credential is
    /// emitted to logs or events by this store.
    pub fn mark_authentication(
        &self,
        id: &str,
        state: AuthState,
        provider_reported_identity: Option<&str>,
        error_code: Option<&str>,
    ) -> Result<ProviderAccount> {
        check_id(id)?;
        let identity = checked_optional_text(
            provider_reported_identity,
            MAX_PROVIDER_IDENTITY_CHARS,
            "provider_account_identity_invalid",
            "The provider returned an invalid account identity.",
        )?;
        let error_code = checked_error_code(error_code)?;
        let checked_at = now_rfc3339();
        let (account, _) = self.core.transact(|tx| {
            get_active_account(tx, id)?;
            tx.execute(
                "UPDATE provider_accounts
                 SET authentication_state = ?2, provider_reported_identity = ?3,
                     last_checked_at = ?4, last_error_code = ?5
                 WHERE id = ?1 AND archived_at IS NULL",
                params![id, auth_state_str(state), identity, checked_at, error_code],
            )?;
            Ok((get_account(tx, id)?, Vec::new()))
        })?;
        Ok(account)
    }

    /// Records a failed validation attempt without discarding the last provider-confirmed
    /// authentication state or identity. A transient CLI, network, or provider failure is not
    /// evidence that a previously valid native session expired.
    pub fn mark_validation_error(&self, id: &str, error_code: &str) -> Result<ProviderAccount> {
        check_id(id)?;
        let error_code = checked_error_code(Some(error_code))?;
        let checked_at = now_rfc3339();
        let (account, _) = self.core.transact(|tx| {
            get_active_account(tx, id)?;
            tx.execute(
                "UPDATE provider_accounts
                 SET last_checked_at = ?2, last_error_code = ?3
                 WHERE id = ?1 AND archived_at IS NULL",
                params![id, checked_at, error_code],
            )?;
            Ok((get_account(tx, id)?, Vec::new()))
        })?;
        Ok(account)
    }

    /// Clears one obsolete validation error without claiming a fresh provider check or changing
    /// the last provider-confirmed authentication state and identity.
    pub fn clear_validation_error(&self, id: &str) -> Result<ProviderAccount> {
        check_id(id)?;
        let (account, _) = self.core.transact(|tx| {
            get_active_account(tx, id)?;
            tx.execute(
                "UPDATE provider_accounts SET last_error_code = NULL
                 WHERE id = ?1 AND archived_at IS NULL",
                params![id],
            )?;
            Ok((get_account(tx, id)?, Vec::new()))
        })?;
        Ok(account)
    }

    /// Repairs metadata written by KalCode builds that downgraded every authenticated account to
    /// `unknown` on startup. Those builds intentionally retained the provider-confirmed identity;
    /// a never-validated account has no identity, so it remains unknown. This restores only the
    /// last known safe UI state and never reads or changes provider-native credentials.
    pub fn restore_legacy_startup_invalidations(&self) -> Result<u64> {
        let (changed, _) = self.core.transact(|tx| {
            let changed = tx.execute(
                "UPDATE provider_accounts SET authentication_state = 'authenticated'
                 WHERE archived_at IS NULL
                   AND authentication_state = 'unknown'
                   AND provider_reported_identity IS NOT NULL",
                [],
            )?;
            // `claude_auth_failed` came only from the retired short-lived `auth status` probe,
            // which current Claude Code may exit before its OAuth refresh drains. It is no longer
            // authoritative. Preserve real launch errors and every auth/identity field.
            tx.execute(
                "UPDATE provider_accounts SET last_error_code = NULL
                 WHERE archived_at IS NULL
                   AND provider_id = 'claude-code'
                   AND last_error_code = 'claude_auth_failed'",
                [],
            )?;
            Ok((u64::try_from(changed).unwrap_or(u64::MAX), Vec::new()))
        })?;
        Ok(changed)
    }

    pub fn mark_used(&self, id: &str) -> Result<ProviderAccount> {
        check_id(id)?;
        let used_at = now_rfc3339();
        let (account, _) = self.core.transact(|tx| {
            get_active_account(tx, id)?;
            tx.execute(
                "UPDATE provider_accounts SET last_used_at = ?2, last_error_code = NULL
                 WHERE id = ?1 AND archived_at IS NULL",
                params![id, used_at],
            )?;
            Ok((get_account(tx, id)?, Vec::new()))
        })?;
        Ok(account)
    }

    pub fn bind(
        &self,
        provider: &str,
        kind: ProviderAccountBindingKind,
        scope_id: &str,
        account_id: &str,
    ) -> Result<ProviderAccountBinding> {
        let provider = checked_provider(provider)?;
        check_id(scope_id)?;
        check_id(account_id)?;
        ensure_supported_binding_kind(kind)?;
        let (binding, _) = self.core.transact(|tx| {
            let account = get_active_account(tx, account_id)?;
            if account.provider_id != provider {
                return Err(provider_error(
                    "provider_account_mismatch",
                    "That account belongs to a different provider.",
                ));
            }
            validate_binding_scope(tx, provider.as_str(), kind, scope_id)?;
            tx.execute(
                "INSERT INTO provider_account_bindings (provider_id, kind, scope_id, account_id)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(provider_id, kind, scope_id)
                 DO UPDATE SET account_id = excluded.account_id",
                params![provider.as_str(), kind.as_str(), scope_id, account_id],
            )?;
            Ok((
                ProviderAccountBinding {
                    provider_id: provider,
                    kind,
                    scope_id: scope_id.to_owned(),
                    account_id: account_id.to_owned(),
                },
                Vec::new(),
            ))
        })?;
        Ok(binding)
    }

    pub fn unbind(
        &self,
        provider: &str,
        kind: ProviderAccountBindingKind,
        scope_id: &str,
    ) -> Result<bool> {
        let provider = checked_provider(provider)?;
        check_id(scope_id)?;
        ensure_supported_binding_kind(kind)?;
        let (removed, _) = self.core.transact(|tx| {
            let removed = tx.execute(
                "DELETE FROM provider_account_bindings
                 WHERE provider_id = ?1 AND kind = ?2 AND scope_id = ?3",
                params![provider.as_str(), kind.as_str(), scope_id],
            )?;
            Ok((removed != 0, Vec::new()))
        })?;
        Ok(removed)
    }

    /// Lists scoped bindings whose account is still active, optionally narrowed by provider,
    /// kind and scope. Ordered by provider, kind, scope for stable display. Metadata only: this
    /// never resolves defaults and never touches provider profiles.
    pub fn list_bindings(
        &self,
        provider: Option<&str>,
        kind: Option<ProviderAccountBindingKind>,
        scope_id: Option<&str>,
    ) -> Result<Vec<ProviderAccountBinding>> {
        let provider = provider.map(checked_provider).transpose()?;
        if let Some(scope_id) = scope_id {
            check_id(scope_id)?;
        }
        let rows: Vec<(String, String, String, String)> = self.core.read(|conn| {
            let mut statement = conn.prepare(
                "SELECT b.provider_id, b.kind, b.scope_id, b.account_id
                 FROM provider_account_bindings b
                 JOIN provider_accounts a
                   ON a.id = b.account_id AND a.provider_id = b.provider_id
                 WHERE a.archived_at IS NULL
                   AND (?1 IS NULL OR b.provider_id = ?1)
                   AND (?2 IS NULL OR b.kind = ?2)
                   AND (?3 IS NULL OR b.scope_id = ?3)
                 ORDER BY b.provider_id, b.kind, b.scope_id",
            )?;
            let rows = statement.query_map(
                params![
                    provider.as_ref().map(ProviderId::as_str),
                    kind.map(ProviderAccountBindingKind::as_str),
                    scope_id
                ],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )?;
            Ok(rows.collect::<std::result::Result<_, _>>()?)
        })?;
        rows.into_iter()
            .map(|(provider_id, kind, scope_id, account_id)| {
                let kind = ProviderAccountBindingKind::parse(&kind).ok_or_else(|| {
                    provider_error(
                        "provider_account_binding_invalid",
                        "A stored account binding has an unknown scope.",
                    )
                })?;
                Ok(ProviderAccountBinding {
                    provider_id: ProviderId::new(provider_id),
                    kind,
                    scope_id,
                    account_id,
                })
            })
            .collect()
    }

    /// Resolves the first active owner-backed binding in this fixed order: thread, workspace,
    /// provider default. Unsupported polymorphic scopes fail closed until they have canonical
    /// owner stores. A missing scope or corrupt dangling/archived binding is an error rather than
    /// a silent fallback to a different account.
    pub fn resolve(
        &self,
        provider: &str,
        scopes: &ProviderAccountScopes,
    ) -> Result<Option<ProviderAccount>> {
        let provider = checked_provider(provider)?;
        reject_unsupported_scopes(scopes)?;
        let ordered = [
            (
                ProviderAccountBindingKind::Thread,
                scopes.thread_id.as_deref(),
            ),
            (
                ProviderAccountBindingKind::Workspace,
                scopes.workspace_id.as_deref(),
            ),
        ];
        for (_, scope_id) in ordered {
            if let Some(scope_id) = scope_id {
                check_id(scope_id)?;
            }
        }
        self.core.read(|conn| {
            for (kind, scope_id) in ordered {
                let Some(scope_id) = scope_id else {
                    continue;
                };
                validate_binding_scope(conn, provider.as_str(), kind, scope_id)?;
                if let Some(account_id) =
                    binding_account_id(conn, provider.as_str(), kind, scope_id)?
                {
                    return get_active_account(conn, &account_id).map(Some);
                }
            }
            default_account(conn, provider.as_str())
        })
    }
}

fn checked_provider(provider: &str) -> Result<ProviderId> {
    match provider {
        ProviderId::CLAUDE_CODE
        | ProviderId::CODEX
        | ProviderId::GEMINI_CLI
        | ProviderId::CURSOR => Ok(ProviderId::new(provider)),
        _ => Err(KalError::validation(
            "provider_account_provider_invalid",
            "That provider doesn't support account metadata.",
        )),
    }
}

fn check_id(id: &str) -> Result<()> {
    if uuid::Uuid::try_parse(id).is_ok_and(|parsed| parsed.hyphenated().to_string().as_str() == id)
    {
        Ok(())
    } else {
        Err(KalError::validation(
            "provider_account_id_invalid",
            "That account or binding id isn't valid.",
        ))
    }
}

fn checked_label(label: &str) -> Result<String> {
    let label = label.trim();
    if label.is_empty()
        || label.chars().count() > MAX_ACCOUNT_LABEL_CHARS
        || label.chars().any(disallowed_text_character)
    {
        return Err(KalError::validation(
            "provider_account_label_invalid",
            "Account labels must be between 1 and 80 visible characters.",
        ));
    }
    Ok(label.to_owned())
}

fn checked_optional_text(
    value: Option<&str>,
    max_chars: usize,
    code: &'static str,
    message: &'static str,
) -> Result<Option<String>> {
    value
        .map(str::trim)
        .map(|value| {
            if value.is_empty()
                || value.chars().count() > max_chars
                || value.chars().any(disallowed_text_character)
            {
                Err(KalError::validation(code, message))
            } else {
                Ok(value.to_owned())
            }
        })
        .transpose()
}

fn checked_error_code(value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_empty()
        || value.len() > MAX_PROVIDER_ERROR_CODE_CHARS
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(KalError::validation(
            "provider_account_error_code_invalid",
            "The provider returned an invalid error code.",
        ));
    }
    Ok(Some(value.to_owned()))
}

fn disallowed_text_character(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
        )
}

fn provider_error(code: &'static str, message: &'static str) -> KalError {
    KalError::new(ErrorCategory::Provider, code, message)
}

fn account_unknown() -> KalError {
    provider_error(
        "provider_account_unknown",
        "That provider account no longer exists.",
    )
}

fn account_archived() -> KalError {
    provider_error(
        "provider_account_archived",
        "That provider account has been removed from KalCode.",
    )
}

fn account_launch_error(error: KalError) -> ProviderError {
    ProviderError::Start(error.message)
}

fn profile_lifecycle_error(error: ProfileLifecycleLeaseError) -> KalError {
    match error {
        ProfileLifecycleLeaseError::InUse => provider_error(
            "provider_account_in_use",
            "Stop every session or sign-in using this provider account before removing it from KalCode.",
        )
        .retryable(),
        ProfileLifecycleLeaseError::Unavailable(error) => KalError::new(
            ErrorCategory::Provider,
            "provider_account_profile_unavailable",
            "KalCode couldn't safely open that provider account profile.",
        )
        .with_source(error),
    }
}

fn get_active_account_for_provider(
    conn: &Connection,
    id: &str,
    provider: &ProviderId,
) -> Result<ProviderAccount> {
    let account = get_active_account(conn, id)?;
    if account.provider_id != *provider {
        return Err(provider_error(
            "provider_account_mismatch",
            "That account belongs to a different provider.",
        ));
    }
    Ok(account)
}

fn ensure_supported_binding_kind(kind: ProviderAccountBindingKind) -> Result<()> {
    match kind {
        ProviderAccountBindingKind::Workspace | ProviderAccountBindingKind::Thread => Ok(()),
        ProviderAccountBindingKind::Agent
        | ProviderAccountBindingKind::Mission
        | ProviderAccountBindingKind::ProviderProfile => Err(KalError::validation(
            "provider_account_binding_kind_unsupported",
            "That account binding scope isn't available in this KalCode build.",
        )),
    }
}

fn reject_unsupported_scopes(scopes: &ProviderAccountScopes) -> Result<()> {
    if scopes.agent_id.is_some()
        || scopes.mission_id.is_some()
        || scopes.provider_profile_id.is_some()
    {
        return Err(KalError::validation(
            "provider_account_binding_kind_unsupported",
            "That account binding scope isn't available in this KalCode build.",
        ));
    }
    Ok(())
}

fn validate_binding_scope(
    conn: &Connection,
    provider: &str,
    kind: ProviderAccountBindingKind,
    scope_id: &str,
) -> Result<()> {
    match kind {
        ProviderAccountBindingKind::Workspace => {
            let exists = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
                [scope_id],
                |row| row.get::<_, bool>(0),
            )?;
            if !exists {
                return Err(KalError::validation(
                    "provider_account_scope_unknown",
                    "That account binding target no longer exists.",
                ));
            }
            Ok(())
        }
        ProviderAccountBindingKind::Thread => {
            let owner: Option<(String, Option<String>)> = conn
                .query_row(
                    "SELECT provider_id, archived_at FROM threads WHERE id = ?1",
                    [scope_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((thread_provider, archived_at)) = owner else {
                return Err(KalError::validation(
                    "provider_account_scope_unknown",
                    "That account binding target no longer exists.",
                ));
            };
            if archived_at.is_some() {
                return Err(KalError::validation(
                    "provider_account_scope_unknown",
                    "That account binding target is archived.",
                ));
            }
            if thread_provider != provider {
                return Err(KalError::validation(
                    "provider_account_scope_mismatch",
                    "That thread belongs to a different provider.",
                ));
            }
            Ok(())
        }
        ProviderAccountBindingKind::Agent
        | ProviderAccountBindingKind::Mission
        | ProviderAccountBindingKind::ProviderProfile => ensure_supported_binding_kind(kind),
    }
}

fn ensure_label_available(
    conn: &Connection,
    provider: &str,
    label: &str,
    except_id: Option<&str>,
) -> Result<()> {
    let exists = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM provider_accounts
           WHERE provider_id = ?1 AND display_name = ?2 COLLATE NOCASE
             AND archived_at IS NULL AND (?3 IS NULL OR id <> ?3)
         )",
        params![provider, label, except_id],
        |row| row.get::<_, bool>(0),
    )?;
    if exists {
        Err(KalError::validation(
            "provider_account_label_exists",
            "That provider already has an account with this label.",
        ))
    } else {
        Ok(())
    }
}

fn ensure_provider_default(conn: &Connection, provider: &str) -> Result<()> {
    let has_default = conn.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM provider_accounts
           WHERE provider_id = ?1 AND archived_at IS NULL AND is_default = 1
         )",
        [provider],
        |row| row.get::<_, bool>(0),
    )?;
    if has_default {
        return Ok(());
    }
    let survivor: Option<String> = conn
        .query_row(
            "SELECT id FROM provider_accounts
             WHERE provider_id = ?1 AND archived_at IS NULL
             ORDER BY created_at, id LIMIT 1",
            [provider],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = survivor {
        conn.execute(
            "UPDATE provider_accounts SET is_default = 1 WHERE id = ?1",
            [id],
        )?;
    }
    Ok(())
}

fn get_account(conn: &Connection, id: &str) -> Result<ProviderAccount> {
    conn.query_row(
        &format!("SELECT {ACCOUNT_COLUMNS} FROM provider_accounts WHERE id = ?1"),
        [id],
        row_to_account,
    )
    .optional()?
    .ok_or_else(account_unknown)
}

fn get_active_account(conn: &Connection, id: &str) -> Result<ProviderAccount> {
    let account = get_account(conn, id)?;
    if account.archived_at.is_some() {
        Err(account_archived())
    } else {
        Ok(account)
    }
}

fn default_account(conn: &Connection, provider: &str) -> Result<Option<ProviderAccount>> {
    conn.query_row(
        &format!(
            "SELECT {ACCOUNT_COLUMNS} FROM provider_accounts
             WHERE provider_id = ?1 AND archived_at IS NULL AND is_default = 1"
        ),
        [provider],
        row_to_account,
    )
    .optional()
    .map_err(Into::into)
}

fn binding_account_id(
    conn: &Connection,
    provider: &str,
    kind: ProviderAccountBindingKind,
    scope_id: &str,
) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT account_id FROM provider_account_bindings
             WHERE provider_id = ?1 AND kind = ?2 AND scope_id = ?3",
            params![provider, kind.as_str(), scope_id],
            |row| row.get(0),
        )
        .optional()?)
}

fn auth_state_str(state: AuthState) -> &'static str {
    match state {
        AuthState::Authenticated => "authenticated",
        AuthState::NotAuthenticated => "not_authenticated",
        AuthState::Unknown => "unknown",
    }
}

fn row_to_account(row: &Row<'_>) -> rusqlite::Result<ProviderAccount> {
    let provider_id: String = row.get(1)?;
    let authentication_state: String = row.get(4)?;
    let is_default: i64 = row.get(5)?;
    let provider_id = match provider_id.as_str() {
        ProviderId::CLAUDE_CODE
        | ProviderId::CODEX
        | ProviderId::GEMINI_CLI
        | ProviderId::CURSOR => ProviderId::new(provider_id),
        _ => return Err(corrupt_column(1, "provider_id")),
    };
    let authentication_state = match authentication_state.as_str() {
        "authenticated" => AuthState::Authenticated,
        "not_authenticated" => AuthState::NotAuthenticated,
        "unknown" => AuthState::Unknown,
        _ => return Err(corrupt_column(4, "authentication_state")),
    };
    let is_default = match is_default {
        0 => false,
        1 => true,
        _ => return Err(corrupt_column(5, "is_default")),
    };
    Ok(ProviderAccount {
        id: row.get(0)?,
        provider_id,
        display_name: row.get(2)?,
        provider_reported_identity: row.get(3)?,
        authentication_state,
        is_default,
        created_at: row.get(6)?,
        last_used_at: row.get(7)?,
        last_checked_at: row.get(8)?,
        last_error_code: row.get(9)?,
        archived_at: row.get(10)?,
    })
}

fn corrupt_column(index: usize, column: &'static str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::other(format!(
            "invalid provider account {column}"
        ))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Barrier, Condvar, Mutex, mpsc};
    use std::time::{Duration, Instant};

    use crate::managed::ManagedProfiles;
    use kalcode_contracts::agent::ProviderError;
    use kalcode_contracts::provider_accounts::ProviderAccountBindingKind as Kind;
    use kalcode_core::flags::BuildChannel;
    use kalcode_core::{CoreConfig, Paths};

    #[test]
    fn cursor_native_account_is_singleton_and_survives_store_reopen() {
        let fixture = Fixture::new();
        let account = fixture.store.create("cursor", "Cursor A").expect("account");
        let duplicate = fixture
            .store
            .create("cursor", "Cursor B")
            .expect_err("no invented isolation");
        assert_eq!(duplicate.code, "cursor_native_account_exists");
        let reopened = AccountStore::new(fixture.core.clone());
        assert_eq!(
            reopened
                .default_for("cursor")
                .expect("default")
                .expect("account")
                .id,
            account.id
        );
        let source = crate::DetectEnv {
            vars: vec![
                ("HOME".into(), "native-home".into()),
                ("CUSTOM_TOOL_CONFIG".into(), "tool-value".into()),
                ("KALCODE_PRIVATE".into(), "hidden".into()),
            ],
            ..Default::default()
        };
        let environment = fixture
            .profiles
            .launch_env("cursor", &account.id, &source)
            .expect("native environment");
        assert_eq!(
            environment
                .get(std::ffi::OsStr::new("HOME"))
                .expect("native home"),
            "native-home"
        );
        assert_eq!(
            environment
                .get(std::ffi::OsStr::new("CUSTOM_TOOL_CONFIG"))
                .expect("tool config"),
            "tool-value"
        );
        assert!(!environment.contains_key(std::ffi::OsStr::new("KALCODE_PRIVATE")));
        let first = fixture
            .profiles
            .acquire_session_lease("cursor", &account.id)
            .expect("first terminal");
        let second = fixture
            .profiles
            .acquire_session_lease("cursor", &account.id)
            .expect("independent terminal");
        assert!(
            fixture
                .profiles
                .acquire_sign_in_lease("cursor", &account.id)
                .is_err()
        );
        drop((first, second));
        let _sign_in = fixture
            .profiles
            .acquire_sign_in_lease("cursor", &account.id)
            .expect("sign in after terminals end");
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        core: Arc<Core>,
        store: AccountStore,
        profiles: ManagedProfiles,
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
                    app_version: "0.0.0-test".into(),
                    channel: BuildChannel::Development,
                })
                .expect("core"),
            );
            let store = AccountStore::new(core.clone());
            let profiles = ManagedProfiles::for_data_dir(&temp_root).expect("managed profiles");
            Self {
                _temp: temp,
                core,
                store,
                profiles,
            }
        }
    }

    fn insert_workspace(fixture: &Fixture, workspace_id: &str) {
        fixture
            .core
            .transact(|tx| {
                tx.execute(
                    "INSERT INTO workspaces (
                       id, name, root_path, created_at, last_opened_at
                     ) VALUES (?1, 'Fixture', ?2, ?3, ?3)",
                    params![
                        workspace_id,
                        format!("C:/fixture/{workspace_id}"),
                        now_rfc3339()
                    ],
                )?;
                Ok(((), Vec::new()))
            })
            .expect("workspace fixture");
    }

    fn insert_thread(fixture: &Fixture, thread_id: &str, provider: &str, workspace_id: &str) {
        fixture
            .core
            .transact(|tx| {
                tx.execute(
                    "INSERT INTO threads (
                       id, name, provider_id, provider_name, workspace_id, workspace_name, cwd,
                       permission_mode, status, created_at, last_activity_at
                     ) VALUES (
                       ?1, 'Fixture', ?2, ?2, ?3, 'Fixture', 'C:/fixture', 'approve', 'idle',
                       ?4, ?4
                     )",
                    params![thread_id, provider, workspace_id, now_rfc3339()],
                )?;
                Ok(((), Vec::new()))
            })
            .expect("thread fixture");
    }

    fn scopes() -> ProviderAccountScopes {
        ProviderAccountScopes {
            workspace_id: Some(kalcode_contracts::ids::new_id()),
            agent_id: None,
            mission_id: None,
            thread_id: Some(kalcode_contracts::ids::new_id()),
            provider_profile_id: None,
        }
    }

    #[test]
    fn a_limited_plan_bounds_connected_accounts_across_providers() {
        use kalcode_core::plans::{Limited, PlanTier};
        let fixture = Fixture::new();
        let limit = PlanTier::Free.limit(Limited::ProviderAccounts);
        let codex = fixture
            .store
            .create_limited("codex", "Personal", limit)
            .expect("first");
        fixture
            .store
            .create_limited("gemini-cli", "Work", limit)
            .expect("second, another provider");
        let refused = fixture
            .store
            .create_limited("codex", "Team", limit)
            .expect_err("a third account");
        assert_eq!(refused.code, "too_many_provider_accounts");
        assert_eq!(
            refused.message,
            "The Free plan allows 2 connected provider accounts. Remove one to connect another, or upgrade to Pro for 6."
        );
        assert_eq!(fixture.store.list(None).expect("list").len(), 2);
        // Removing (archiving) an account frees a slot; an uncapped plan never refuses.
        fixture
            .store
            .archive(&fixture.profiles, &codex.id)
            .expect("archive");
        fixture
            .store
            .create_limited("codex", "Team", limit)
            .expect("an archived account frees a slot");
        fixture
            .store
            .create_limited("codex", "Extra", None)
            .expect("uncapped");
        assert_eq!(fixture.store.list(None).expect("list").len(), 3);
    }

    #[test]
    fn defaults_are_atomic_and_case_insensitive_labels_are_unique() {
        let fixture = Fixture::new();
        let first = fixture.store.create("codex", "Personal").expect("first");
        let second = fixture.store.create("codex", "Work").expect("second");
        let third = fixture.store.create("codex", "Team").expect("third");
        assert!(first.is_default);
        assert!(!second.is_default);
        assert_eq!(
            fixture
                .store
                .create("codex", "personal")
                .expect_err("case duplicate")
                .code,
            "provider_account_label_exists"
        );
        assert_eq!(
            fixture
                .store
                .rename(&second.id, "PERSONAL")
                .expect_err("rename duplicate")
                .code,
            "provider_account_label_exists"
        );
        let renamed = fixture.store.rename(&second.id, "Office").expect("rename");
        assert_eq!(renamed.display_name, "Office");
        assert!(
            fixture
                .store
                .mark_used(&second.id)
                .expect("mark used")
                .last_used_at
                .is_some()
        );
        let claude = fixture
            .store
            .create("claude-code", "Claude")
            .expect("supported provider");
        assert!(claude.is_default);
        assert_eq!(
            fixture
                .store
                .create("unknown", "Unknown")
                .expect_err("unknown provider")
                .code,
            "provider_account_provider_invalid"
        );

        let barrier = Arc::new(Barrier::new(3));
        let handles: Vec<_> = [second.id.clone(), third.id.clone()]
            .into_iter()
            .map(|id| {
                let store = fixture.store.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    store.set_default(&id).expect("set default")
                })
            })
            .collect();
        barrier.wait();
        for handle in handles {
            handle.join().expect("default thread");
        }

        let accounts = fixture.store.list(Some("codex")).expect("list");
        assert_eq!(
            accounts.iter().filter(|account| account.is_default).count(),
            1
        );
        assert!(!fixture.store.get(&first.id).expect("first").is_default);
        let selected = fixture
            .store
            .default_for("codex")
            .expect("default")
            .expect("selected default");
        assert_eq!(
            accounts
                .iter()
                .find(|account| account.is_default)
                .map(|account| &account.id),
            Some(&selected.id)
        );
        assert_eq!(fixture.store.list(None).expect("all providers").len(), 4);
    }

    #[test]
    fn list_bindings_filters_by_provider_kind_and_scope() {
        let fixture = Fixture::new();
        let codex = fixture.store.create("codex", "Work").expect("codex");
        let gemini = fixture
            .store
            .create("gemini-cli", "Gemini A")
            .expect("gemini");
        let first = kalcode_contracts::ids::new_id();
        let second = kalcode_contracts::ids::new_id();
        insert_workspace(&fixture, &first);
        insert_workspace(&fixture, &second);
        fixture
            .store
            .bind("codex", Kind::Workspace, &first, &codex.id)
            .expect("codex binding");
        fixture
            .store
            .bind("gemini-cli", Kind::Workspace, &first, &gemini.id)
            .expect("gemini first");
        fixture
            .store
            .bind("gemini-cli", Kind::Workspace, &second, &gemini.id)
            .expect("gemini second");

        let all = fixture.store.list_bindings(None, None, None).expect("all");
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].provider_id.as_str(), "codex");
        let gemini_only = fixture
            .store
            .list_bindings(Some("gemini-cli"), Some(Kind::Workspace), None)
            .expect("gemini");
        assert_eq!(gemini_only.len(), 2);
        assert!(gemini_only.iter().all(|b| b.account_id == gemini.id));
        let scoped = fixture
            .store
            .list_bindings(None, Some(Kind::Workspace), Some(&first))
            .expect("scoped");
        assert_eq!(scoped.len(), 2);
        assert!(
            fixture
                .store
                .list_bindings(None, Some(Kind::Thread), None)
                .expect("threads")
                .is_empty()
        );
        assert_eq!(
            fixture
                .store
                .list_bindings(Some("unknown"), None, None)
                .expect_err("provider")
                .code,
            "provider_account_provider_invalid"
        );
        assert_eq!(
            fixture
                .store
                .list_bindings(None, None, Some("../x"))
                .expect_err("scope")
                .code,
            "provider_account_id_invalid"
        );
    }

    #[test]
    fn provider_binding_must_match_and_resolution_uses_fixed_precedence() {
        let fixture = Fixture::new();
        let codex_a = fixture.store.create("codex", "A").expect("codex A");
        let codex_b = fixture.store.create("codex", "B").expect("codex B");
        let gemini = fixture
            .store
            .create("gemini-cli", "Gemini")
            .expect("gemini");
        let scopes = scopes();
        insert_workspace(&fixture, scopes.workspace_id.as_deref().expect("workspace"));
        insert_thread(
            &fixture,
            scopes.thread_id.as_deref().expect("thread"),
            "codex",
            scopes.workspace_id.as_deref().expect("workspace"),
        );

        let mismatch = fixture
            .store
            .bind(
                "codex",
                Kind::Thread,
                scopes.thread_id.as_deref().expect("thread"),
                &gemini.id,
            )
            .expect_err("provider mismatch");
        assert_eq!(mismatch.code, "provider_account_mismatch");

        let ordered = [
            (Kind::Workspace, scopes.workspace_id.as_deref(), &codex_b.id),
            (Kind::Thread, scopes.thread_id.as_deref(), &codex_a.id),
        ];
        for (kind, scope, account) in ordered {
            fixture
                .store
                .bind("codex", kind, scope.expect("scope"), account)
                .expect("bind");
        }
        let expected = [(Kind::Thread, &codex_a.id), (Kind::Workspace, &codex_b.id)];
        for (kind, account_id) in expected {
            assert_eq!(
                fixture
                    .store
                    .resolve("codex", &scopes)
                    .expect("resolve")
                    .expect("account")
                    .id,
                *account_id
            );
            let scope_id = match kind {
                Kind::Thread => scopes.thread_id.as_deref(),
                Kind::Workspace => scopes.workspace_id.as_deref(),
                Kind::Agent | Kind::Mission | Kind::ProviderProfile => unreachable!(),
            };
            fixture
                .store
                .unbind("codex", kind, scope_id.expect("scope"))
                .expect("unbind");
        }
        assert_eq!(
            fixture
                .store
                .resolve("codex", &scopes)
                .expect("default resolve")
                .expect("default")
                .id,
            codex_a.id
        );
    }

    #[test]
    fn bindings_require_real_supported_scope_owners_and_matching_thread_provider() {
        let fixture = Fixture::new();
        let codex = fixture.store.create("codex", "Codex").expect("codex");
        let workspace_id = kalcode_contracts::ids::new_id();
        let thread_id = kalcode_contracts::ids::new_id();

        assert_eq!(
            fixture
                .store
                .bind("codex", Kind::Workspace, &workspace_id, &codex.id)
                .expect_err("missing workspace")
                .code,
            "provider_account_scope_unknown"
        );
        insert_workspace(&fixture, &workspace_id);
        insert_thread(&fixture, &thread_id, "gemini-cli", &workspace_id);
        assert_eq!(
            fixture
                .store
                .bind("codex", Kind::Thread, &thread_id, &codex.id)
                .expect_err("cross-provider thread")
                .code,
            "provider_account_scope_mismatch"
        );

        for kind in [Kind::Agent, Kind::Mission, Kind::ProviderProfile] {
            assert_eq!(
                fixture
                    .store
                    .bind("codex", kind, &kalcode_contracts::ids::new_id(), &codex.id)
                    .expect_err("unsupported binding owner")
                    .code,
                "provider_account_binding_kind_unsupported"
            );
        }
    }

    #[test]
    fn launch_validation_is_held_under_the_shared_profile_lease() {
        let fixture = Fixture::new();
        let account = fixture.store.create("codex", "Personal").expect("account");
        let invoked = AtomicBool::new(false);

        fixture
            .store
            .launch_with_active_account(&fixture.profiles, "codex", &account.id, |validated| {
                invoked.store(true, Ordering::SeqCst);
                assert_eq!(validated.id, account.id);
                assert!(
                    fixture
                        .profiles
                        .acquire_account_lifecycle_lease("codex", &account.id)
                        .is_err(),
                    "archive/sign-in must be excluded while launch is validating and starting"
                );
                Ok(())
            })
            .expect("validated launch");
        assert!(invoked.load(Ordering::SeqCst));
        assert!(
            fixture
                .store
                .get(&account.id)
                .expect("used account")
                .last_used_at
                .is_some(),
            "only a successful launch records account use"
        );
        let _exclusive = fixture
            .profiles
            .acquire_account_lifecycle_lease("codex", &account.id)
            .expect("launch released its temporary guard");
    }

    #[test]
    fn authenticated_claude_launch_repairs_legacy_onboarding_before_shared_lease() {
        let fixture = Fixture::new();
        let account = fixture
            .store
            .create("claude-code", "Personal")
            .expect("account");
        fixture
            .store
            .mark_authentication(
                &account.id,
                AuthState::Authenticated,
                Some("person@example.test"),
                None,
            )
            .expect("connected");
        let home = fixture
            .profiles
            .profile_home("claude-code", &account.id)
            .expect("profile home");
        let config = home.join(".claude.json");
        std::fs::write(
            &config,
            serde_json::to_vec(&serde_json::json!({
                "oauthAccount": { "accountUuid": "account-native-id" },
                "hasCompletedOnboarding": false,
                "nativeField": { "preserved": true }
            }))
            .expect("fixture json"),
        )
        .expect("legacy config");

        fixture
            .store
            .launch_with_active_account(&fixture.profiles, "claude-code", &account.id, |_| {
                let value: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&config).expect("read migrated config"))
                        .expect("migrated json");
                assert_eq!(value["hasCompletedOnboarding"], true);
                assert_eq!(value["nativeField"]["preserved"], true);
                assert!(
                    fixture
                        .profiles
                        .acquire_sign_in_lease("claude-code", &account.id)
                        .is_err(),
                    "launch callback must run under the shared session lease"
                );
                Ok(())
            })
            .expect("Claude launch");
    }

    #[test]
    fn six_concurrent_claude_launches_share_one_completed_legacy_profile() {
        let fixture = Fixture::new();
        let account = fixture
            .store
            .create("claude-code", "Personal")
            .expect("account");
        fixture
            .store
            .mark_authentication(
                &account.id,
                AuthState::Authenticated,
                Some("person@example.test"),
                None,
            )
            .expect("connected");
        let config = fixture
            .profiles
            .profile_home("claude-code", &account.id)
            .expect("profile home")
            .join(".claude.json");
        std::fs::write(
            &config,
            serde_json::to_vec(&serde_json::json!({
                "oauthAccount": { "accountUuid": "account-native-id" },
                "hasCompletedOnboarding": false
            }))
            .expect("fixture json"),
        )
        .expect("legacy config");
        let (arrived_tx, arrived_rx) = mpsc::channel();
        let release = Arc::new((Mutex::new(false), Condvar::new()));

        std::thread::scope(|scope| {
            let launches = (0..6)
                .map(|_| {
                    let arrived_tx = arrived_tx.clone();
                    let release = Arc::clone(&release);
                    let store = &fixture.store;
                    let profiles = &fixture.profiles;
                    let account_id = account.id.clone();
                    let config = config.clone();
                    scope.spawn(move || {
                        store.launch_with_active_account(
                            profiles,
                            "claude-code",
                            &account_id,
                            |_| {
                                arrived_tx.send(()).expect("record callback arrival");
                                let (released, changed) = &*release;
                                let released = released.lock().unwrap();
                                let (released, timeout) = changed
                                    .wait_timeout_while(released, Duration::from_secs(5), |ready| {
                                        !*ready
                                    })
                                    .unwrap();
                                assert!(
                                    !timeout.timed_out() && *released,
                                    "callback release timed out"
                                );
                                let value: serde_json::Value = serde_json::from_slice(
                                    &std::fs::read(&config).expect("read migrated config"),
                                )
                                .expect("migrated json");
                                assert_eq!(value["hasCompletedOnboarding"], true);
                                Ok(())
                            },
                        )
                    })
                })
                .collect::<Vec<_>>();
            let arrivals = (0..6)
                .map(|_| arrived_rx.recv_timeout(Duration::from_secs(5)))
                .collect::<Vec<_>>();
            {
                let (released, changed) = &*release;
                *released.lock().unwrap() = true;
                changed.notify_all();
            }
            for launch in launches {
                launch
                    .join()
                    .expect("launch thread")
                    .expect("Claude launch");
            }
            assert!(
                arrivals.iter().all(std::result::Result::is_ok),
                "all six launches must acquire coexisting shared leases: {arrivals:?}"
            );
        });
    }

    #[test]
    fn completed_fast_path_waits_for_inflight_onboarding_migration_lease() {
        let fixture = Fixture::new();
        let account = fixture
            .store
            .create("claude-code", "Personal")
            .expect("account");
        fixture
            .store
            .mark_authentication(
                &account.id,
                AuthState::Authenticated,
                Some("person@example.test"),
                None,
            )
            .expect("connected");
        let config = fixture
            .profiles
            .profile_home("claude-code", &account.id)
            .expect("profile home")
            .join(".claude.json");
        std::fs::write(
            &config,
            serde_json::to_vec(&serde_json::json!({
                "oauthAccount": { "accountUuid": "account-native-id" },
                "hasCompletedOnboarding": false
            }))
            .expect("fixture json"),
        )
        .expect("legacy config");
        // Hang guards only: the ordering is asserted below (launch waits for the release). A
        // loaded gate machine took over 5 s to reach the post-write pause.
        const HANG_GUARD: Duration = Duration::from_secs(30);
        let (written_tx, written_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();

        std::thread::scope(|scope| {
            let migration_store = &fixture.store;
            let migration_profiles = &fixture.profiles;
            let migration_account_id = account.id.clone();
            let migration = scope.spawn(move || {
                crate::claude::onboarding::prepare_connected_profile(
                    migration_profiles,
                    &migration_account_id,
                    || {
                        migration_store.authenticate_with_active_account(
                            migration_profiles,
                            "claude-code",
                            &migration_account_id,
                            |current, lease| {
                                assert_eq!(current.authentication_state, AuthState::Authenticated);
                                crate::claude::onboarding::complete_with_lease(
                                    migration_profiles,
                                    &migration_account_id,
                                    &lease,
                                )?;
                                written_tx.send(()).expect("migration wrote marker");
                                release_rx
                                    .recv_timeout(HANG_GUARD)
                                    .expect("release migration");
                                Ok(())
                            },
                        )
                    },
                )
            });
            written_rx
                .recv_timeout(HANG_GUARD)
                .expect("migration reached post-write pause");

            let release = scope.spawn(move || {
                std::thread::sleep(Duration::from_millis(250));
                release_tx.send(()).expect("release migration");
            });
            let started = Instant::now();
            let result = fixture.store.launch_with_active_account(
                &fixture.profiles,
                "claude-code",
                &account.id,
                |_| Ok(()),
            );
            let elapsed = started.elapsed();
            release.join().expect("release thread");
            migration
                .join()
                .expect("migration thread")
                .expect("migration");
            assert!(
                elapsed >= Duration::from_millis(150),
                "launch escaped before migration released its exclusive lease: {result:?}"
            );
            result.expect("launch waits for migration handoff");
        });
    }

    #[test]
    fn claude_launch_never_synthesizes_onboarding_without_connected_metadata() {
        let fixture = Fixture::new();
        let account = fixture
            .store
            .create("claude-code", "Personal")
            .expect("account");
        fixture
            .store
            .mark_authentication(
                &account.id,
                AuthState::Authenticated,
                Some("person@example.test"),
                None,
            )
            .expect("connected");
        let config = fixture
            .profiles
            .profile_home("claude-code", &account.id)
            .expect("profile home")
            .join(".claude.json");
        let original = serde_json::to_vec(&serde_json::json!({
            "oauthAccount": { "emailAddress": "person@example.test" },
            "hasCompletedOnboarding": false
        }))
        .expect("fixture json");
        std::fs::write(&config, &original).expect("config");

        fixture
            .store
            .launch_with_active_account(&fixture.profiles, "claude-code", &account.id, |_| Ok(()))
            .expect("provider handles incomplete setup");
        assert_eq!(
            std::fs::read(&config).expect("config after launch"),
            original
        );

        fixture
            .store
            .mark_authentication(&account.id, AuthState::NotAuthenticated, None, None)
            .expect("signed out");
        let invoked = AtomicBool::new(false);
        assert_eq!(
            fixture.store.launch_with_active_account(
                &fixture.profiles,
                "claude-code",
                &account.id,
                |_| {
                    invoked.store(true, Ordering::SeqCst);
                    Ok(())
                },
            ),
            Err(ProviderError::NotAuthenticated)
        );
        assert!(!invoked.load(Ordering::SeqCst));
        assert_eq!(std::fs::read(&config).expect("signed-out config"), original);
    }

    #[test]
    fn launch_proceeds_during_read_only_observation_and_lifecycle_stays_exclusive() {
        let fixture = Fixture::new();
        let account = fixture.store.create("codex", "Personal").expect("account");
        fixture
            .store
            .mark_authentication(
                &account.id,
                AuthState::Authenticated,
                Some("person@example.test"),
                None,
            )
            .expect("connected");
        let observation = fixture
            .profiles
            .acquire_observer_lease("codex", &account.id)
            .expect("observer lease");
        let started = Instant::now();
        fixture
            .store
            .launch_with_active_account(&fixture.profiles, "codex", &account.id, |_| Ok(()))
            .expect("launch during observer");
        assert!(started.elapsed() < Duration::from_millis(100));
        assert!(
            fixture
                .profiles
                .acquire_account_lifecycle_lease("codex", &account.id)
                .is_err()
        );
        drop(observation);
    }

    #[test]
    fn authoritative_expiry_clears_auth_but_transient_launch_failure_preserves_it() {
        let fixture = Fixture::new();
        let account = fixture
            .store
            .create("claude-code", "Claude")
            .expect("account");
        fixture
            .store
            .mark_authentication(
                &account.id,
                AuthState::Authenticated,
                Some("claude@example.test"),
                Some("claude_auth_failed"),
            )
            .expect("connected");
        assert_eq!(
            fixture.store.launch_with_active_account(
                &fixture.profiles,
                "claude-code",
                &account.id,
                |_| Err::<(), _>(ProviderError::NotAuthenticated),
            ),
            Err(ProviderError::NotAuthenticated)
        );
        let expired = fixture.store.get(&account.id).expect("expired");
        assert_eq!(expired.authentication_state, AuthState::NotAuthenticated);
        assert_eq!(expired.provider_reported_identity, None);

        fixture
            .store
            .mark_authentication(
                &account.id,
                AuthState::Authenticated,
                Some("claude@example.test"),
                None,
            )
            .expect("reconnected");
        assert!(matches!(
            fixture.store.launch_with_active_account(
                &fixture.profiles,
                "claude-code",
                &account.id,
                |_| Err::<(), _>(ProviderError::Io("offline".into())),
            ),
            Err(ProviderError::Io(_))
        ));
        let preserved = fixture.store.get(&account.id).expect("preserved");
        assert_eq!(preserved.authentication_state, AuthState::Authenticated);
        assert_eq!(
            preserved.provider_reported_identity.as_deref(),
            Some("claude@example.test")
        );
        assert_eq!(
            preserved.last_error_code.as_deref(),
            Some("provider_launch_failed")
        );
        fixture
            .store
            .launch_with_active_account(&fixture.profiles, "claude-code", &account.id, |_| Ok(()))
            .expect("native session launched");
        let launched = fixture.store.get(&account.id).expect("launched");
        assert_eq!(launched.authentication_state, AuthState::Authenticated);
        assert_eq!(
            launched.provider_reported_identity.as_deref(),
            Some("claude@example.test")
        );
        assert_eq!(launched.last_error_code, None);
    }

    #[test]
    fn every_provider_launches_after_metadata_failure_but_rejects_confirmed_expiry() {
        let fixture = Fixture::new();
        for provider in ["claude-code", "codex", "cursor", "gemini-cli"] {
            let account = fixture.store.create(provider, "Work").expect("account");
            fixture
                .store
                .mark_authentication(
                    &account.id,
                    AuthState::Authenticated,
                    Some("work@example.test"),
                    None,
                )
                .expect("provider confirmed authentication");
            fixture
                .store
                .mark_validation_error(&account.id, "metadata_unavailable")
                .expect("metadata request failed");
            fixture
                .store
                .launch_with_active_account(&fixture.profiles, provider, &account.id, |selected| {
                    assert_eq!(selected.id, account.id);
                    assert_eq!(selected.authentication_state, AuthState::Authenticated);
                    assert_eq!(
                        selected.provider_reported_identity.as_deref(),
                        Some("work@example.test")
                    );
                    Ok(())
                })
                .expect("valid provider session launches without metadata");
            assert_eq!(
                fixture.store.launch_with_active_account(
                    &fixture.profiles,
                    provider,
                    &account.id,
                    |_| Err::<(), _>(ProviderError::NotAuthenticated),
                ),
                Err(ProviderError::NotAuthenticated)
            );
            let invoked = AtomicBool::new(false);
            assert_eq!(
                fixture.store.launch_with_active_account(
                    &fixture.profiles,
                    provider,
                    &account.id,
                    |_| {
                        invoked.store(true, Ordering::SeqCst);
                        Ok(())
                    },
                ),
                Err(ProviderError::NotAuthenticated)
            );
            assert!(
                !invoked.load(Ordering::SeqCst),
                "confirmed expiry requires reconnect"
            );
            fixture
                .store
                .mark_authentication(
                    &account.id,
                    AuthState::Authenticated,
                    Some("work@example.test"),
                    None,
                )
                .expect("provider confirmed reconnect");
            fixture
                .store
                .launch_with_active_account(&fixture.profiles, provider, &account.id, |_| Ok(()))
                .expect("reconnected account launches");
        }
    }

    #[test]
    fn launch_rejects_cross_provider_and_archived_accounts_before_callback() {
        let fixture = Fixture::new();
        let gemini = fixture
            .store
            .create("gemini-cli", "School")
            .expect("gemini");
        let invoked = AtomicBool::new(false);
        let mismatch = fixture
            .store
            .launch_with_active_account(&fixture.profiles, "codex", &gemini.id, |_| {
                invoked.store(true, Ordering::SeqCst);
                Ok(())
            })
            .expect_err("provider mismatch");
        assert!(matches!(mismatch, ProviderError::Start(_)));
        assert!(!invoked.load(Ordering::SeqCst));

        let codex = fixture.store.create("codex", "Old").expect("codex");
        fixture
            .store
            .archive(&fixture.profiles, &codex.id)
            .expect("archive");
        let archived = fixture
            .store
            .launch_with_active_account(&fixture.profiles, "codex", &codex.id, |_| {
                invoked.store(true, Ordering::SeqCst);
                Ok(())
            })
            .expect_err("archived account");
        assert!(matches!(archived, ProviderError::Start(_)));
        assert!(!invoked.load(Ordering::SeqCst));
    }

    #[test]
    fn failed_provider_launch_does_not_mark_the_account_used() {
        let fixture = Fixture::new();
        let account = fixture.store.create("codex", "Personal").expect("account");
        let result: std::result::Result<(), ProviderError> = fixture
            .store
            .launch_with_active_account(&fixture.profiles, "codex", &account.id, |_| {
                Err(ProviderError::Start("synthetic launch failure".into()))
            });

        assert!(result.is_err());
        assert!(
            fixture
                .store
                .get(&account.id)
                .expect("account")
                .last_used_at
                .is_none()
        );
    }

    #[test]
    fn authentication_validation_holds_the_matching_exclusive_profile_lease() {
        let fixture = Fixture::new();
        let account = fixture.store.create("codex", "Personal").expect("account");
        let invoked = AtomicBool::new(false);

        fixture
            .store
            .authenticate_with_active_account(
                &fixture.profiles,
                "codex",
                &account.id,
                |validated, lease| {
                    invoked.store(true, Ordering::SeqCst);
                    assert_eq!(validated.id, account.id);
                    assert!(
                        fixture
                            .profiles
                            .acquire_session_lease("codex", &account.id)
                            .is_err(),
                        "a provider session must not overlap account authentication"
                    );
                    drop(lease);
                    Ok(())
                },
            )
            .expect("validated authentication");
        assert!(invoked.load(Ordering::SeqCst));

        let other = fixture.store.create("gemini-cli", "Other").expect("other");
        let mismatch = fixture.store.authenticate_with_active_account(
            &fixture.profiles,
            "codex",
            &other.id,
            |_, _| {
                invoked.store(false, Ordering::SeqCst);
                Ok(())
            },
        );
        assert!(matches!(mismatch, Err(ProviderError::Start(_))));
        assert!(invoked.load(Ordering::SeqCst));
    }

    #[test]
    fn archive_is_excluded_by_a_session_lease_and_never_deletes_the_profile() {
        let fixture = Fixture::new();
        let account = fixture.store.create("codex", "Personal").expect("account");
        let profile = fixture
            .profiles
            .profile_home("codex", &account.id)
            .expect("profile");
        let sentinel = profile.join("auth-sentinel");
        std::fs::write(&sentinel, b"must-remain").expect("sentinel");
        let session = fixture
            .profiles
            .acquire_session_lease("codex", &account.id)
            .expect("session lease");

        assert_eq!(
            fixture
                .store
                .archive(&fixture.profiles, &account.id)
                .expect_err("active lease blocks archive")
                .code,
            "provider_account_in_use"
        );
        assert!(
            fixture
                .store
                .get(&account.id)
                .expect("still active")
                .archived_at
                .is_none()
        );
        drop(session);
        assert!(
            fixture
                .store
                .archive(&fixture.profiles, &account.id)
                .expect("archive")
                .archived_at
                .is_some()
        );
        assert_eq!(
            std::fs::read(sentinel).expect("profile remains"),
            b"must-remain"
        );
    }

    #[test]
    fn removal_tombstones_clears_bindings_and_selects_a_surviving_default() {
        let fixture = Fixture::new();
        let first = fixture.store.create("codex", "First").expect("first");
        let second = fixture.store.create("codex", "Second").expect("second");
        let mut scopes = scopes();
        let historical_thread = kalcode_contracts::ids::new_id();
        scopes.thread_id = Some(historical_thread.clone());
        scopes.workspace_id = None;
        fixture
            .core
            .transact(|tx| {
                tx.execute(
                    "INSERT INTO threads (
                       id, name, provider_id, provider_name, account_label, provider_account_id,
                       workspace_id, workspace_name, cwd, permission_mode, status,
                       created_at, last_activity_at
                     ) VALUES (
                       ?1, 'Historical', 'codex', 'Codex', 'First', ?2,
                       'workspace', 'Workspace', 'C:/workspace', 'approve', 'idle',
                       '2026-09-24T10:00:00.000Z', '2026-09-24T10:00:00.000Z'
                     )",
                    params![historical_thread, first.id],
                )?;
                Ok(((), Vec::new()))
            })
            .expect("historical thread");
        fixture
            .store
            .bind("codex", Kind::Thread, &historical_thread, &first.id)
            .expect("bind");

        let removed = fixture
            .store
            .archive(&fixture.profiles, &first.id)
            .expect("remove");
        assert!(removed.archived_at.is_some());
        assert_eq!(fixture.store.get(&first.id).expect("tombstone"), removed);
        let active = fixture.store.list(Some("codex")).expect("list");
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].id, second.id);
        assert!(active[0].is_default);
        let historical_account_id: Option<String> = fixture
            .core
            .read(|conn| {
                Ok(conn.query_row(
                    "SELECT provider_account_id FROM threads WHERE id = ?1",
                    [&historical_thread],
                    |row| row.get(0),
                )?)
            })
            .expect("historical account id");
        assert_eq!(historical_account_id.as_deref(), Some(first.id.as_str()));
        assert_eq!(
            fixture
                .store
                .resolve("codex", &scopes)
                .expect("resolve")
                .expect("survivor")
                .id,
            second.id
        );
        fixture
            .store
            .create("codex", "FIRST")
            .expect("archived label reusable");
    }

    /// Switch accounts: archiving an account drops every workspace default that selected it.
    /// That workspace then resolves to the provider default (documented behaviour the Accounts
    /// UI shows by no longer listing the workspace under "Default in"), while an explicit id of
    /// the archived account is refused rather than swapped for another account.
    #[test]
    fn archive_drops_workspace_defaults_and_resolution_falls_back_to_the_provider_default() {
        let fixture = Fixture::new();
        let default = fixture.store.create("gemini-cli", "Gemini A").expect("a");
        let chosen = fixture.store.create("gemini-cli", "Gemini B").expect("b");
        let (workspace, other) = (
            kalcode_contracts::ids::new_id(),
            kalcode_contracts::ids::new_id(),
        );
        insert_workspace(&fixture, &workspace);
        insert_workspace(&fixture, &other);
        for scope in [&workspace, &other] {
            fixture
                .store
                .bind("gemini-cli", Kind::Workspace, scope, &chosen.id)
                .expect("bind");
        }
        let scopes = ProviderAccountScopes {
            workspace_id: Some(workspace.clone()),
            ..ProviderAccountScopes::default()
        };
        assert_eq!(
            fixture
                .store
                .resolve("gemini-cli", &scopes)
                .expect("resolve")
                .expect("bound")
                .id,
            chosen.id
        );

        fixture
            .store
            .archive(&fixture.profiles, &chosen.id)
            .expect("archive");
        assert!(
            fixture
                .store
                .list_bindings(Some("gemini-cli"), Some(Kind::Workspace), None)
                .expect("bindings")
                .is_empty()
        );
        let raw: i64 = fixture
            .core
            .read(|conn| {
                Ok(conn.query_row(
                    "SELECT COUNT(*) FROM provider_account_bindings WHERE account_id = ?1",
                    [&chosen.id],
                    |row| row.get(0),
                )?)
            })
            .expect("count");
        assert_eq!(raw, 0, "no dangling rows for the archived account");
        assert_eq!(
            fixture
                .store
                .resolve("gemini-cli", &scopes)
                .expect("resolve")
                .expect("default")
                .id,
            default.id
        );
        assert!(
            fixture
                .store
                .get(&chosen.id)
                .expect("tombstone")
                .archived_at
                .is_some(),
            "the tombstone stays readable so threads bound to it can say so"
        );
    }

    #[test]
    fn corrupt_rows_return_an_error_instead_of_empty_or_unknown_state() {
        let fixture = Fixture::new();
        let account = fixture.store.create("codex", "Corrupt").expect("account");
        fixture
            .core
            .transact(|tx| {
                tx.pragma_update(None, "ignore_check_constraints", true)?;
                tx.execute(
                    "UPDATE provider_accounts SET authentication_state = 'future' WHERE id = ?1",
                    [&account.id],
                )?;
                tx.pragma_update(None, "ignore_check_constraints", false)?;
                Ok(((), Vec::new()))
            })
            .expect("inject corrupt fixture");

        let error = fixture.store.get(&account.id).expect_err("corruption");
        assert_eq!(error.code, "database_error");
    }

    #[test]
    fn transient_validation_error_preserves_last_known_safe_auth_and_identity() {
        let fixture = Fixture::new();
        let account = fixture.store.create("codex", "Work").expect("account");
        let connected = fixture
            .store
            .mark_authentication(
                &account.id,
                AuthState::Authenticated,
                Some("fixture-identity"),
                None,
            )
            .expect("connected");

        let failed = fixture
            .store
            .mark_validation_error(&account.id, "codex_auth_failed")
            .expect("validation error");

        assert_eq!(failed.authentication_state, AuthState::Authenticated);
        assert_eq!(
            failed.provider_reported_identity,
            connected.provider_reported_identity
        );
        assert_eq!(failed.last_error_code.as_deref(), Some("codex_auth_failed"));
        assert!(failed.last_checked_at >= connected.last_checked_at);
    }

    #[test]
    fn legacy_startup_unknown_with_confirmed_identity_restores_last_safe_auth_once() {
        let fixture = Fixture::new();
        let never_checked = fixture.store.create("claude-code", "New").expect("new");
        let connected = fixture
            .store
            .create("claude-code", "Existing")
            .expect("existing");
        fixture
            .store
            .mark_authentication(
                &connected.id,
                AuthState::Authenticated,
                Some("person@example.test"),
                Some("claude_auth_failed"),
            )
            .expect("connected");
        fixture
            .core
            .transact(|tx| {
                tx.execute(
                    "UPDATE provider_accounts SET authentication_state = 'unknown' WHERE id = ?1",
                    params![connected.id],
                )?;
                Ok(((), Vec::new()))
            })
            .expect("simulate legacy startup invalidation");

        assert_eq!(
            fixture
                .store
                .restore_legacy_startup_invalidations()
                .unwrap(),
            1
        );
        let restored = fixture.store.get(&connected.id).expect("restored");
        assert_eq!(restored.authentication_state, AuthState::Authenticated);
        assert_eq!(
            restored.provider_reported_identity.as_deref(),
            Some("person@example.test")
        );
        assert_eq!(restored.last_error_code, None);
        assert_eq!(
            fixture
                .store
                .get(&never_checked.id)
                .expect("never checked")
                .authentication_state,
            AuthState::Unknown
        );
        assert_eq!(
            fixture
                .store
                .restore_legacy_startup_invalidations()
                .unwrap(),
            0
        );
    }

    #[test]
    fn restart_restores_multiple_accounts_without_losing_safe_state() {
        let temp = tempfile::tempdir().expect("temp");
        let temp_root = if cfg!(target_os = "macos") {
            temp.path().canonicalize().expect("canonical temp")
        } else {
            temp.path().to_path_buf()
        };
        let config = || CoreConfig {
            paths: Paths::new(&temp_root),
            app_version: "0.0.0-test".into(),
            channel: BuildChannel::Development,
        };
        let (before, ordered_ids, bindings) = {
            let core = Arc::new(Core::open(config()).expect("first core"));
            let store = AccountStore::new(core.clone());
            let connect = |provider: &str, label: &str, identity: &str| {
                let account = store.create(provider, label).expect("account");
                store
                    .mark_authentication(
                        &account.id,
                        AuthState::Authenticated,
                        Some(identity),
                        None,
                    )
                    .expect("authenticated")
            };
            let claude_a = connect("claude-code", "Claude A", "claude-a");
            let claude_b = connect("claude-code", "Claude B", "claude-b");
            let codex_a = connect("codex", "Codex A", "codex-a");
            let codex_b = connect("codex", "Codex B", "codex-b");
            let gemini = connect("gemini-cli", "Gemini", "gemini");
            let cursor = connect("cursor", "Cursor", "cursor");
            store
                .mark_validation_error(&codex_b.id, "metadata_unavailable")
                .expect("transient failure before restart");
            let expired = store
                .create("gemini-cli", "Expired")
                .expect("expired account");
            let expired = store
                .mark_authentication(&expired.id, AuthState::NotAuthenticated, None, None)
                .expect("expired");

            let claude_b = store.set_default(&claude_b.id).expect("Claude B default");
            let codex_b = store.set_default(&codex_b.id).expect("Codex B default");
            let workspace_id = kalcode_contracts::ids::new_id();
            core.transact(|tx| {
                tx.execute(
                    "INSERT INTO workspaces (
                       id, name, root_path, created_at, last_opened_at
                     ) VALUES (?1, 'Restart', 'C:/fixture/restart', ?2, ?2)",
                    params![workspace_id, now_rfc3339()],
                )?;
                Ok(((), Vec::new()))
            })
            .expect("workspace");
            store
                .bind("claude-code", Kind::Workspace, &workspace_id, &claude_b.id)
                .expect("Claude binding");
            store
                .bind("codex", Kind::Workspace, &workspace_id, &codex_b.id)
                .expect("Codex binding");

            let expected_ids = [
                claude_a.id,
                claude_b.id,
                codex_a.id,
                codex_b.id,
                gemini.id,
                cursor.id,
                expired.id,
            ];
            let accounts = store.list(None).expect("ordered accounts");
            assert!(
                accounts
                    .iter()
                    .all(|account| expected_ids.contains(&account.id))
            );
            let ordered_ids = accounts
                .iter()
                .map(|account| account.id.clone())
                .collect::<Vec<_>>();
            let bindings = store.list_bindings(None, None, None).expect("bindings");
            core.shutdown();
            (accounts, ordered_ids, bindings)
        };

        let core = Arc::new(Core::open(config()).expect("second core"));
        let store = AccountStore::new(core.clone());
        let profiles = ManagedProfiles::new(temp_root.join("profiles")).expect("profiles");
        for expected in before {
            let after = store.get(&expected.id).expect("after restart");
            assert_eq!(after.authentication_state, expected.authentication_state);
            assert_eq!(after.display_name, expected.display_name);
            assert_eq!(
                after.provider_reported_identity,
                expected.provider_reported_identity
            );
            assert_eq!(after.is_default, expected.is_default);
            assert_eq!(after.created_at, expected.created_at);
            assert_eq!(after.last_checked_at, expected.last_checked_at);
            assert_eq!(after.last_error_code, expected.last_error_code);
            let launched = store.launch_with_active_account(
                &profiles,
                after.provider_id.as_str(),
                &after.id,
                |_| Ok(()),
            );
            if after.authentication_state == AuthState::Authenticated {
                launched.expect("persisted session launches immediately after restart");
            } else {
                assert_eq!(launched, Err(ProviderError::NotAuthenticated));
            }
        }
        assert_eq!(
            store
                .list(None)
                .expect("restored order")
                .into_iter()
                .map(|account| account.id)
                .collect::<Vec<_>>(),
            ordered_ids
        );
        assert_eq!(
            store.list_bindings(None, None, None).expect("bindings"),
            bindings
        );
        core.shutdown();
    }
}
