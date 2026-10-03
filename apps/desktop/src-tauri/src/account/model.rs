use std::fmt;

use kalcode_core::plans::{Limited, PlanLimit, PlanTier};
use serde::Serialize;

use super::social::{SocialProvider, valid_opaque};

const SESSION_PREFIX: &str = "kcs_";
const SESSION_BODY_LENGTH: usize = 43;
const POLL_TOKEN_LENGTH: usize = 43;
const MIN_VERIFIER_LENGTH: usize = 43;
const MAX_VERIFIER_LENGTH: usize = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountPhase {
    Bootstrapping,
    SignedOut,
    EmailPending,
    SocialPending,
    AuthenticatedUnactivated,
    ConfirmingPlan,
    Ready,
    OfflineGrace,
    Degraded,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AccountAuthority {
    Bootstrapping,
    SignedOut,
    AuthenticatedUnactivated,
    Active,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AccountTier {
    Free,
    Pro,
    Max,
    #[serde(rename = "max2x")]
    Max2x,
    Owner,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicAccount {
    pub id: String,
    pub email: String,
    pub activated_at: Option<String>,
    /// The cosmetic KalCode account display name; `None` = not set (the UI shows the email's
    /// local part). Never part of identity, authority or any signed document.
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsageSnapshot {
    pub used: u64,
    pub allowance: Option<u64>,
    pub period_start: String,
    pub resets_at: String,
}

/// `degraded_reason` of a signed-out snapshot whose session expired or was rejected (401).
pub const SESSION_EXPIRED_REASON: &str = "session_expired";

/// The complete account value available to the WebView. Secret-bearing types below deliberately
/// do not implement `Serialize`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSnapshot {
    pub phase: AccountPhase,
    pub account: Option<PublicAccount>,
    pub tier: Option<AccountTier>,
    pub session_expires_at: Option<String>,
    pub entitlement_expires_at: Option<i64>,
    pub offline_grace_until: Option<i64>,
    pub pending_email: Option<String>,
    pub pending_expires_at: Option<String>,
    pub degraded_reason: Option<String>,
}

impl AccountSnapshot {
    pub fn bootstrapping() -> Self {
        Self::for_phase(AccountPhase::Bootstrapping)
    }

    pub fn signed_out() -> Self {
        Self::for_phase(AccountPhase::SignedOut)
    }

    /// Signed out because the stored session expired or the server rejected it, not because the
    /// person signed out: the sign-in screen says so ("Your session expired").
    pub fn session_expired() -> Self {
        Self {
            degraded_reason: Some(SESSION_EXPIRED_REASON.into()),
            ..Self::signed_out()
        }
    }

    /// The plan whose limits apply: the verified plan of an active account. Without an active
    /// verified plan (signed out, bootstrapping, not yet activated, degraded) Free applies.
    pub fn plan_tier(&self) -> PlanTier {
        let tier = match self.authority() {
            AccountAuthority::Active => self.tier,
            _ => None,
        };
        match tier.unwrap_or(AccountTier::Free) {
            AccountTier::Free => PlanTier::Free,
            AccountTier::Pro => PlanTier::Pro,
            AccountTier::Max => PlanTier::Max,
            AccountTier::Max2x => PlanTier::Max2x,
            AccountTier::Owner => PlanTier::Owner,
        }
    }

    /// This account's cap on `kind` (`kalcode_core::plans`), or `None` when uncapped.
    pub fn plan_limit(&self, kind: Limited) -> Option<PlanLimit> {
        self.plan_tier().limit(kind)
    }

    /// The cap on terminals open at the same time across all of KalCode.
    pub fn terminal_limit(&self) -> Option<PlanLimit> {
        self.plan_limit(Limited::OpenTerminals)
    }

    fn for_phase(phase: AccountPhase) -> Self {
        Self {
            phase,
            account: None,
            tier: None,
            session_expires_at: None,
            entitlement_expires_at: None,
            offline_grace_until: None,
            pending_email: None,
            pending_expires_at: None,
            degraded_reason: None,
        }
    }

    pub fn authority(&self) -> AccountAuthority {
        match self.phase {
            AccountPhase::Bootstrapping => AccountAuthority::Bootstrapping,
            AccountPhase::AuthenticatedUnactivated | AccountPhase::ConfirmingPlan => {
                AccountAuthority::AuthenticatedUnactivated
            }
            AccountPhase::Ready | AccountPhase::OfflineGrace => AccountAuthority::Active,
            AccountPhase::SignedOut
            | AccountPhase::EmailPending
            | AccountPhase::SocialPending
            | AccountPhase::Degraded => AccountAuthority::SignedOut,
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SessionSecret {
    token: String,
    expires_at: i64,
}

impl SessionSecret {
    pub fn new(token: String, expires_at: i64) -> Result<Self, SecretValidationError> {
        let body = token.strip_prefix(SESSION_PREFIX).unwrap_or_default();
        if body.len() != SESSION_BODY_LENGTH || !body.bytes().all(is_base64url) || expires_at <= 0 {
            return Err(SecretValidationError);
        }
        Ok(Self { token, expires_at })
    }

    pub fn expose_token(&self) -> &str {
        &self.token
    }

    pub fn expires_at(&self) -> i64 {
        self.expires_at
    }

    pub fn is_expired_at(&self, now: i64) -> bool {
        now >= self.expires_at
    }
}

impl fmt::Debug for SessionSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SessionSecret([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum PendingAuthSecret {
    Email {
        poll_token: String,
        code_verifier: String,
        expires_at: i64,
        email: String,
    },
    Social {
        provider: SocialProvider,
        state: String,
        code_verifier: String,
        nonce: String,
        expires_at: i64,
    },
}

impl PendingAuthSecret {
    pub fn new(
        poll_token: String,
        code_verifier: String,
        expires_at: i64,
        email: String,
    ) -> Result<Self, SecretValidationError> {
        let verifier_valid = (MIN_VERIFIER_LENGTH..=MAX_VERIFIER_LENGTH)
            .contains(&code_verifier.len())
            && code_verifier.bytes().all(is_pkce_unreserved);
        let email_valid = email.len() <= 320
            && !email.trim().is_empty()
            && email == email.trim()
            && email.contains('@')
            && !email.chars().any(char::is_control);
        if poll_token.len() != POLL_TOKEN_LENGTH
            || !poll_token.bytes().all(is_base64url)
            || !verifier_valid
            || expires_at <= 0
            || !email_valid
        {
            return Err(SecretValidationError);
        }
        Ok(Self::Email {
            poll_token,
            code_verifier,
            expires_at,
            email,
        })
    }

    pub fn social(
        provider: SocialProvider,
        state: String,
        code_verifier: String,
        nonce: String,
        expires_at: i64,
    ) -> Result<Self, SecretValidationError> {
        let verifier_valid = (MIN_VERIFIER_LENGTH..=MAX_VERIFIER_LENGTH)
            .contains(&code_verifier.len())
            && code_verifier.bytes().all(is_pkce_unreserved);
        if !valid_opaque(&state) || !valid_opaque(&nonce) || !verifier_valid || expires_at <= 0 {
            return Err(SecretValidationError);
        }
        Ok(Self::Social {
            provider,
            state,
            code_verifier,
            nonce,
            expires_at,
        })
    }

    pub fn expose_poll_token(&self) -> Option<&str> {
        match self {
            Self::Email { poll_token, .. } => Some(poll_token),
            Self::Social { .. } => None,
        }
    }

    pub fn expose_code_verifier(&self) -> &str {
        match self {
            Self::Email { code_verifier, .. } | Self::Social { code_verifier, .. } => code_verifier,
        }
    }

    pub fn expires_at(&self) -> i64 {
        match self {
            Self::Email { expires_at, .. } | Self::Social { expires_at, .. } => *expires_at,
        }
    }

    pub fn email(&self) -> Option<&str> {
        match self {
            Self::Email { email, .. } => Some(email),
            Self::Social { .. } => None,
        }
    }

    pub fn social_provider(&self) -> Option<SocialProvider> {
        match self {
            Self::Social { provider, .. } => Some(*provider),
            Self::Email { .. } => None,
        }
    }

    pub fn expose_state(&self) -> Option<&str> {
        match self {
            Self::Social { state, .. } => Some(state),
            Self::Email { .. } => None,
        }
    }

    pub fn expose_nonce(&self) -> Option<&str> {
        match self {
            Self::Social { nonce, .. } => Some(nonce),
            Self::Email { .. } => None,
        }
    }

    pub fn is_email(&self) -> bool {
        matches!(self, Self::Email { .. })
    }

    pub fn is_expired_at(&self, now: i64) -> bool {
        now >= self.expires_at()
    }
}

impl fmt::Debug for PendingAuthSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PendingAuthSecret([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecretValidationError;

fn is_base64url(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')
}

fn is_pkce_unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
}
