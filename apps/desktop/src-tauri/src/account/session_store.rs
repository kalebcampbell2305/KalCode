use std::fmt;

use kalcode_secure_store::{SecretKey, SecretStore, SecretString};
use serde::{Deserialize, Serialize};

use super::api::{BillingInterval, PaidTier};
use super::model::{PendingAuthSecret, PublicAccount, SessionSecret};
use super::social::SocialProvider;

const MAX_SIGNED_TOKEN_LENGTH: usize = 8192;

pub const ACCOUNT_SESSION_KEY: &str = "kalcode-account-session";
pub const ACCOUNT_USAGE_RECEIPT_KEY: &str = "kalcode-account-usage-receipt";
/// A yearly pending checkout's interval lives beside the session envelope, never inside it.
/// Every shipped 0.1.8 build parses the envelope with `deny_unknown_fields` and clears the
/// whole signed-in session when it cannot, so an extra checkout field would sign people out
/// after an updater rollback. Older builds never read this item; it is bound to the checkout's
/// request id, so a stale or orphaned value can never apply to another checkout.
pub const ACCOUNT_CHECKOUT_INTERVAL_KEY: &str = "kalcode-account-checkout-interval";
/// The cached account's display name, beside the envelope for the same rollback reason: an
/// extra envelope field would sign people out on an older build. Bound to the account id.
pub const ACCOUNT_DISPLAY_NAME_KEY: &str = "kalcode-account-display-name";
const ENVELOPE_VERSION: u32 = 2;
const LEGACY_ENVELOPE_VERSION: u32 = 1;

pub struct AccountSessionStore<'a> {
    backend: &'a dyn SecretStore,
    key: SecretKey,
    usage_key: SecretKey,
    interval_key: SecretKey,
    display_name_key: SecretKey,
}

impl<'a> AccountSessionStore<'a> {
    pub fn new(backend: &'a dyn SecretStore) -> Result<Self, SessionStoreError> {
        let key = SecretKey::new(ACCOUNT_SESSION_KEY).map_err(|_| SessionStoreError::Backend)?;
        let usage_key =
            SecretKey::new(ACCOUNT_USAGE_RECEIPT_KEY).map_err(|_| SessionStoreError::Backend)?;
        let interval_key = SecretKey::new(ACCOUNT_CHECKOUT_INTERVAL_KEY)
            .map_err(|_| SessionStoreError::Backend)?;
        let display_name_key =
            SecretKey::new(ACCOUNT_DISPLAY_NAME_KEY).map_err(|_| SessionStoreError::Backend)?;
        Ok(Self {
            backend,
            key,
            usage_key,
            interval_key,
            display_name_key,
        })
    }

    pub fn load(&self) -> Result<Option<StoredSession>, SessionStoreError> {
        let Some(secret) = self
            .backend
            .get(&self.key)
            .map_err(|_| SessionStoreError::Backend)?
        else {
            return Ok(None);
        };
        let raw: RawEnvelope =
            serde_json::from_str(secret.expose_secret()).map_err(|_| SessionStoreError::Corrupt)?;
        if !matches!(raw.version, LEGACY_ENVELOPE_VERSION | ENVELOPE_VERSION)
            || (raw.session.is_none() && raw.pending.is_none())
            || ((raw.cached.is_some() || raw.usage_receipt.is_some() || raw.checkout.is_some())
                && raw.session.is_none())
        {
            return Err(SessionStoreError::Corrupt);
        }
        let session = raw
            .session
            .map(|value| SessionSecret::new(value.token, value.expires_at))
            .transpose()
            .map_err(|_| SessionStoreError::Corrupt)?;
        let pending = raw
            .pending
            .map(|value| value.into_secret(raw.version))
            .transpose()
            .map_err(|_| SessionStoreError::Corrupt)?;
        let cached = raw
            .cached
            .map(|value| {
                let display_name = self.display_name(&value.account_id);
                CachedAccountSecret::new(
                    value.entitlement_token,
                    PublicAccount {
                        id: value.account_id,
                        email: value.email,
                        activated_at: value.activated_at,
                        display_name,
                    },
                )
            })
            .transpose()
            .map_err(|_| SessionStoreError::Corrupt)?;
        let usage_receipt = raw
            .usage_receipt
            .map(SignedUsageReceipt::new)
            .transpose()
            .map_err(|_| SessionStoreError::Corrupt)?;
        let checkout = raw
            .checkout
            .map(|value| {
                let tier = match value.tier.as_str() {
                    "pro" => PaidTier::Pro,
                    "max" => PaidTier::Max,
                    "max2x" => PaidTier::Max2x,
                    _ => return Err(SecretValidationError),
                };
                let interval = self.checkout_interval(&value.request_id);
                PendingCheckoutSecret::new(value.request_id, tier, interval)
            })
            .transpose()
            .map_err(|_| SessionStoreError::Corrupt)?;
        if usage_receipt.is_some() && cached.is_none() {
            return Err(SessionStoreError::Corrupt);
        }
        // Legacy envelopes retain their inline receipt until the next successful save.
        // The separate receipt is only a cache: absence, corruption, or an interrupted
        // account switch cannot invalidate the independently verified login authority.
        let usage_receipt = usage_receipt.or_else(|| {
            let account = cached.as_ref()?.account();
            let secret = self.backend.get(&self.usage_key).ok()??;
            let receipt: StoredUsageReceipt = serde_json::from_str(secret.expose_secret()).ok()?;
            if receipt.version != 1 || receipt.account_id != account.id {
                return None;
            }
            SignedUsageReceipt::new(receipt.receipt).ok()
        });
        Ok(Some(StoredSession {
            session,
            pending,
            cached,
            usage_receipt,
            checkout,
        }))
    }

    pub fn save(
        &self,
        session: Option<&SessionSecret>,
        pending: Option<&PendingAuthSecret>,
    ) -> Result<(), SessionStoreError> {
        self.save_full(session, pending, None, None)
    }

    pub fn save_full(
        &self,
        session: Option<&SessionSecret>,
        pending: Option<&PendingAuthSecret>,
        cached: Option<&CachedAccountSecret>,
        usage_receipt: Option<&SignedUsageReceipt>,
    ) -> Result<(), SessionStoreError> {
        self.save_complete(session, pending, cached, usage_receipt, None)
    }

    pub fn save_complete(
        &self,
        session: Option<&SessionSecret>,
        pending: Option<&PendingAuthSecret>,
        cached: Option<&CachedAccountSecret>,
        usage_receipt: Option<&SignedUsageReceipt>,
        checkout: Option<&PendingCheckoutSecret>,
    ) -> Result<(), SessionStoreError> {
        if (cached.is_some() || usage_receipt.is_some()) && session.is_none()
            || usage_receipt.is_some() && cached.is_none()
            || checkout.is_some() && session.is_none()
        {
            return Err(SessionStoreError::Corrupt);
        }
        if session.is_none()
            && pending.is_none()
            && cached.is_none()
            && usage_receipt.is_none()
            && checkout.is_none()
        {
            self.clear()?;
            return Ok(());
        }
        let envelope = WriteEnvelope {
            version: ENVELOPE_VERSION,
            session: session.map(|value| WriteSession {
                token: value.expose_token(),
                expires_at: value.expires_at(),
            }),
            pending: pending.map(WritePending::from),
            cached: cached.map(|value| WriteCached {
                entitlement_token: value.entitlement_token(),
                account_id: &value.account().id,
                email: &value.account().email,
                activated_at: value.account().activated_at.as_deref(),
            }),
            usage_receipt: None,
            checkout: checkout.map(|value| WriteCheckout {
                request_id: value.request_id(),
                tier: value.tier().as_str(),
            }),
        };
        let json = serde_json::to_string(&envelope).map_err(|_| SessionStoreError::Corrupt)?;
        // Windows passwords are UTF-16 and limited to 2560 bytes per credential.
        // A social account's session + entitlement + receipt exceeds that limit.
        // Write the account-bound cache first; a failed envelope write leaves the old
        // session authoritative and cannot apply another account's cached receipt.
        if let (Some(receipt), Some(cached)) = (usage_receipt, cached) {
            let receipt = StoredUsageReceipt {
                version: 1,
                account_id: cached.account().id.clone(),
                receipt: receipt.expose_receipt().to_owned(),
            };
            let receipt_json =
                serde_json::to_string(&receipt).map_err(|_| SessionStoreError::Corrupt)?;
            self.backend
                .set(&self.usage_key, &SecretString::new(receipt_json))
                .map_err(|_| SessionStoreError::Backend)?;
        } else {
            self.backend
                .delete(&self.usage_key)
                .map_err(|_| SessionStoreError::Backend)?;
        }
        // Best effort: a display name is cosmetic and never blocks saving the session. The item
        // is bound to the account id, so a stale one can never name another account.
        match cached.and_then(|value| {
            let account = value.account();
            account
                .display_name
                .as_deref()
                .map(|name| (account.id.as_str(), name))
        }) {
            Some((account_id, display_name)) => {
                let stored = StoredDisplayName {
                    version: 1,
                    account_id: account_id.to_owned(),
                    display_name: display_name.to_owned(),
                };
                if let Ok(json) = serde_json::to_string(&stored) {
                    let _ = self
                        .backend
                        .set(&self.display_name_key, &SecretString::new(json));
                }
            }
            None => {
                let _ = self.backend.delete(&self.display_name_key);
            }
        }
        // Written before the envelope: an interrupted save leaves only an orphan bound to a
        // request id the envelope does not hold. Monthly checkouts write nothing here.
        if let Some(checkout) = checkout.filter(|value| value.interval() == BillingInterval::Year) {
            let marker = StoredCheckoutInterval {
                version: 1,
                request_id: checkout.request_id().to_owned(),
                interval: BillingInterval::Year,
            };
            let marker_json =
                serde_json::to_string(&marker).map_err(|_| SessionStoreError::Corrupt)?;
            self.backend
                .set(&self.interval_key, &SecretString::new(marker_json))
                .map_err(|_| SessionStoreError::Backend)?;
        }
        self.backend
            .set(&self.key, &SecretString::new(json))
            .map_err(|_| SessionStoreError::Backend)
    }

    pub fn clear(&self) -> Result<bool, SessionStoreError> {
        let session = self.backend.delete(&self.key);
        let receipt = self.backend.delete(&self.usage_key);
        // Best effort: the marker is request-bound, so a leftover can never apply elsewhere.
        let _ = self.backend.delete(&self.interval_key);
        // Best effort: the name is account-bound, so a leftover can never name another account.
        let _ = self.backend.delete(&self.display_name_key);
        Ok(session.map_err(|_| SessionStoreError::Backend)?
            | receipt.map_err(|_| SessionStoreError::Backend)?)
    }

    /// The cached display name of `account_id`. Absent, unreadable, invalid or another
    /// account's name means none: the UI then shows the email's local part until the next
    /// verified account read.
    fn display_name(&self, account_id: &str) -> Option<String> {
        let secret = self.backend.get(&self.display_name_key).ok()??;
        let stored: StoredDisplayName = serde_json::from_str(secret.expose_secret()).ok()?;
        let count = stored.display_name.chars().count();
        (stored.version == 1
            && stored.account_id == account_id
            && (1..=64).contains(&count)
            && stored.display_name == stored.display_name.trim()
            && !stored.display_name.chars().any(char::is_control))
        .then_some(stored.display_name)
    }

    /// The interval of the stored pending checkout. Absent, unreadable, or stale markers mean
    /// monthly; the server keys reservations by (tier, interval, request id), so a misread can
    /// only be refused as `checkout_in_progress`, never charged at the other interval.
    fn checkout_interval(&self, request_id: &str) -> BillingInterval {
        let Ok(Some(secret)) = self.backend.get(&self.interval_key) else {
            return BillingInterval::Month;
        };
        match serde_json::from_str::<StoredCheckoutInterval>(secret.expose_secret()) {
            Ok(marker) if marker.version == 1 && marker.request_id == request_id => marker.interval,
            _ => BillingInterval::Month,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredCheckoutInterval {
    version: u32,
    request_id: String,
    interval: BillingInterval,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredDisplayName {
    version: u32,
    account_id: String,
    display_name: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredUsageReceipt {
    version: u32,
    account_id: String,
    receipt: String,
}

pub struct StoredSession {
    session: Option<SessionSecret>,
    pending: Option<PendingAuthSecret>,
    cached: Option<CachedAccountSecret>,
    usage_receipt: Option<SignedUsageReceipt>,
    checkout: Option<PendingCheckoutSecret>,
}

impl StoredSession {
    pub fn session(&self) -> Option<&SessionSecret> {
        self.session.as_ref()
    }

    pub fn pending(&self) -> Option<&PendingAuthSecret> {
        self.pending.as_ref()
    }

    pub fn cached(&self) -> Option<&CachedAccountSecret> {
        self.cached.as_ref()
    }

    pub fn usage_receipt(&self) -> Option<&SignedUsageReceipt> {
        self.usage_receipt.as_ref()
    }

    pub fn checkout(&self) -> Option<&PendingCheckoutSecret> {
        self.checkout.as_ref()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct PendingCheckoutSecret {
    request_id: String,
    tier: PaidTier,
    interval: BillingInterval,
}

impl PendingCheckoutSecret {
    pub fn new(
        request_id: String,
        tier: PaidTier,
        interval: BillingInterval,
    ) -> Result<Self, SecretValidationError> {
        let valid = (8..=128).contains(&request_id.len())
            && request_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'));
        if !valid {
            return Err(SecretValidationError);
        }
        Ok(Self {
            request_id,
            tier,
            interval,
        })
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn tier(&self) -> PaidTier {
        self.tier
    }

    pub fn interval(&self) -> BillingInterval {
        self.interval
    }
}

impl fmt::Debug for PendingCheckoutSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingCheckoutSecret")
            .field("tier", &self.tier)
            .field("interval", &self.interval)
            .field("request_id", &"[IDEMPOTENCY_KEY]")
            .finish()
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct CachedAccountSecret {
    entitlement_token: String,
    account: PublicAccount,
}

impl CachedAccountSecret {
    pub fn new(
        entitlement_token: String,
        account: PublicAccount,
    ) -> Result<Self, SecretValidationError> {
        if !valid_signed_token(&entitlement_token) || !valid_public_account(&account) {
            return Err(SecretValidationError);
        }
        Ok(Self {
            entitlement_token,
            account,
        })
    }

    pub fn entitlement_token(&self) -> &str {
        &self.entitlement_token
    }

    pub fn account(&self) -> &PublicAccount {
        &self.account
    }
}

impl fmt::Debug for CachedAccountSecret {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("CachedAccountSecret([SIGNED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SignedUsageReceipt(String);

impl SignedUsageReceipt {
    pub fn new(receipt: String) -> Result<Self, SecretValidationError> {
        if !valid_signed_token(&receipt) {
            return Err(SecretValidationError);
        }
        Ok(Self(receipt))
    }

    pub fn expose_receipt(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for SignedUsageReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SignedUsageReceipt([SIGNED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecretValidationError;

fn valid_signed_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_SIGNED_TOKEN_LENGTH
        && value.split('.').count() == 3
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_public_account(account: &PublicAccount) -> bool {
    !account.id.is_empty()
        && account.id.len() <= 128
        && account.email.len() <= 320
        && account.email.contains('@')
        && account.email == account.email.trim()
        && !account.email.chars().any(char::is_control)
        && account
            .activated_at
            .as_ref()
            .is_some_and(|value| valid_iso_millis(value))
}

fn valid_iso_millis(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 24
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            10 => *byte == b'T',
            13 | 16 => *byte == b':',
            19 => *byte == b'.',
            23 => *byte == b'Z',
            _ => byte.is_ascii_digit(),
        })
}

impl fmt::Debug for StoredSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("StoredSession([REDACTED])")
    }
}

#[derive(Debug)]
pub enum SessionStoreError {
    Backend,
    Corrupt,
}

impl fmt::Display for SessionStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Backend => formatter.write_str("the system credential store is unavailable"),
            Self::Corrupt => formatter.write_str("the stored account session is invalid"),
        }
    }
}

impl std::error::Error for SessionStoreError {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteEnvelope<'a> {
    version: u32,
    session: Option<WriteSession<'a>>,
    pending: Option<WritePending<'a>>,
    cached: Option<WriteCached<'a>>,
    usage_receipt: Option<&'a str>,
    checkout: Option<WriteCheckout<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteSession<'a> {
    token: &'a str,
    expires_at: i64,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum WritePending<'a> {
    Email {
        poll_token: &'a str,
        code_verifier: &'a str,
        expires_at: i64,
        email: &'a str,
    },
    Social {
        provider: SocialProvider,
        state: &'a str,
        code_verifier: &'a str,
        nonce: &'a str,
        expires_at: i64,
    },
}

impl<'a> From<&'a PendingAuthSecret> for WritePending<'a> {
    fn from(value: &'a PendingAuthSecret) -> Self {
        match value {
            PendingAuthSecret::Email {
                poll_token,
                code_verifier,
                expires_at,
                email,
            } => Self::Email {
                poll_token,
                code_verifier,
                expires_at: *expires_at,
                email,
            },
            PendingAuthSecret::Social {
                provider,
                state,
                code_verifier,
                nonce,
                expires_at,
            } => Self::Social {
                provider: *provider,
                state,
                code_verifier,
                nonce,
                expires_at: *expires_at,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteCached<'a> {
    entitlement_token: &'a str,
    account_id: &'a str,
    email: &'a str,
    activated_at: Option<&'a str>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WriteCheckout<'a> {
    request_id: &'a str,
    tier: &'static str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawEnvelope {
    version: u32,
    session: Option<RawSession>,
    pending: Option<RawPending>,
    #[serde(default)]
    cached: Option<RawCached>,
    #[serde(default)]
    usage_receipt: Option<String>,
    #[serde(default)]
    checkout: Option<RawCheckout>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawSession {
    token: String,
    expires_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawPending {
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    poll_token: Option<String>,
    code_verifier: String,
    expires_at: i64,
    #[serde(default)]
    email: Option<String>,
    #[serde(default)]
    provider: Option<SocialProvider>,
    #[serde(default)]
    state: Option<String>,
    #[serde(default)]
    nonce: Option<String>,
}

impl RawPending {
    fn into_secret(self, version: u32) -> Result<PendingAuthSecret, SecretValidationError> {
        match self.kind.as_deref() {
            None if version == LEGACY_ENVELOPE_VERSION => {
                if self.provider.is_some() || self.state.is_some() || self.nonce.is_some() {
                    return Err(SecretValidationError);
                }
                PendingAuthSecret::new(
                    self.poll_token.ok_or(SecretValidationError)?,
                    self.code_verifier,
                    self.expires_at,
                    self.email.ok_or(SecretValidationError)?,
                )
                .map_err(|_| SecretValidationError)
            }
            Some("email") if version == ENVELOPE_VERSION => {
                if self.provider.is_some() || self.state.is_some() || self.nonce.is_some() {
                    return Err(SecretValidationError);
                }
                PendingAuthSecret::new(
                    self.poll_token.ok_or(SecretValidationError)?,
                    self.code_verifier,
                    self.expires_at,
                    self.email.ok_or(SecretValidationError)?,
                )
                .map_err(|_| SecretValidationError)
            }
            Some("social") if version == ENVELOPE_VERSION => {
                if self.poll_token.is_some() || self.email.is_some() {
                    return Err(SecretValidationError);
                }
                PendingAuthSecret::social(
                    self.provider.ok_or(SecretValidationError)?,
                    self.state.ok_or(SecretValidationError)?,
                    self.code_verifier,
                    self.nonce.ok_or(SecretValidationError)?,
                    self.expires_at,
                )
                .map_err(|_| SecretValidationError)
            }
            _ => Err(SecretValidationError),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCached {
    entitlement_token: String,
    account_id: String,
    email: String,
    activated_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RawCheckout {
    request_id: String,
    tier: String,
}
