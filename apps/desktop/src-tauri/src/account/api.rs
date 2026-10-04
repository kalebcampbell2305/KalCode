use std::fmt;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use url::Url;

use super::model::AccountUsageSnapshot;
use super::social::SocialProvider;

pub const API_ORIGIN: &str = "https://api.kalcoded.com";
const MAX_RESPONSE_BYTES: u64 = 256 * 1024;
const MAX_ATTEMPTS: u8 = 3;
const MAX_RETRY_AFTER_SECONDS: u64 = 15;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, PartialEq, Eq)]
pub struct PkcePair {
    verifier: String,
    challenge: String,
}

impl PkcePair {
    pub fn generate() -> Result<Self, ApiError> {
        let mut entropy = [0_u8; 32];
        getrandom::fill(&mut entropy).map_err(|_| ApiError::Local("randomness_unavailable"))?;
        Self::from_verifier(URL_SAFE_NO_PAD.encode(entropy))
    }

    pub fn from_verifier(verifier: String) -> Result<Self, ApiError> {
        let valid = (43..=128).contains(&verifier.len())
            && verifier.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~')
            });
        if !valid {
            return Err(ApiError::Local("invalid_pkce_verifier"));
        }
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Ok(Self {
            verifier,
            challenge,
        })
    }

    pub fn expose_verifier(&self) -> &str {
        &self.verifier
    }

    pub fn challenge(&self) -> &str {
        &self.challenge
    }
}

impl fmt::Debug for PkcePair {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("PkcePair([REDACTED])")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserDestination {
    Checkout,
    Portal,
}

pub fn validate_browser_destination(value: &str) -> Result<BrowserDestination, ApiError> {
    let url = Url::parse(value).map_err(|_| ApiError::InvalidResponse)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return Err(ApiError::InvalidResponse);
    }
    match url.host_str() {
        Some("checkout.stripe.com") => Ok(BrowserDestination::Checkout),
        Some("billing.stripe.com") => Ok(BrowserDestination::Portal),
        _ => Err(ApiError::InvalidResponse),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetryClass {
    Read,
    CheckoutSameRequest,
    EmailSend,
}

pub fn retry_delay(
    class: RetryClass,
    completed_attempts: u8,
    retry_after_seconds: Option<u64>,
) -> Option<Duration> {
    if class == RetryClass::EmailSend || completed_attempts.saturating_add(1) >= MAX_ATTEMPTS {
        return None;
    }
    let seconds = retry_after_seconds
        .unwrap_or_else(|| 1_u64 << completed_attempts.min(3))
        .clamp(1, MAX_RETRY_AFTER_SECONDS);
    Some(Duration::from_secs(seconds))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    Transport,
    InvalidResponse,
    Http {
        status: u16,
        code: String,
        retry_after_seconds: Option<u64>,
    },
    Local(&'static str),
}

impl ApiError {
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Http { status, .. } => Some(*status),
            _ => None,
        }
    }

    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Http { code, .. } => Some(code),
            Self::Local(code) => Some(code),
            _ => None,
        }
    }

    pub fn retry_after_seconds(&self) -> Option<u64> {
        match self {
            Self::Http {
                retry_after_seconds,
                ..
            } => *retry_after_seconds,
            _ => None,
        }
    }

    pub fn is_retryable(&self) -> bool {
        matches!(self, Self::Transport)
            || matches!(
                self,
                Self::Http {
                    status: 429 | 503,
                    ..
                }
            )
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::Transport => "the KalCode account service could not be reached",
            Self::InvalidResponse => "the KalCode account service returned an invalid response",
            Self::Http { .. } => "the KalCode account request was rejected",
            Self::Local(_) => "the KalCode account request could not be prepared",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for ApiError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmailStartResponse {
    pub expires_at: String,
    pub poll_token: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SocialStartResponse {
    pub authorize_url: String,
    pub nonce: String,
    pub expires_at: String,
}

impl fmt::Debug for SocialStartResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SocialStartResponse([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SocialCompleteResponse {
    pub token: String,
    pub account_id: String,
    pub expires_at: String,
}

impl fmt::Debug for SocialCompleteResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SocialCompleteResponse([REDACTED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct SignedInResponse {
    pub token: String,
    pub expires_at: String,
}

impl fmt::Debug for SignedInResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("SignedInResponse([REDACTED])")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PollResponse {
    Pending,
    SignedIn(SignedInResponse),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiAccount {
    pub id: String,
    pub email: String,
    pub activated_at: Option<String>,
    pub display_name: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct EntitlementResponse {
    pub token: String,
}

impl fmt::Debug for EntitlementResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("EntitlementResponse([SIGNED])")
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct UsageResponse {
    pub usage: AccountUsageSnapshot,
    pub receipt: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestUsageResponse {
    pub allowed: bool,
    pub usage: UsageResponse,
}

impl fmt::Debug for UsageResponse {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("UsageResponse")
            .field("usage", &self.usage)
            .field("receipt", &"[SIGNED]")
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserUrlResponse {
    pub url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaidTier {
    Pro,
    Max,
    Max2x,
}

impl PaidTier {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pro => "pro",
            Self::Max => "max",
            Self::Max2x => "max2x",
        }
    }
}

/// How often a paid plan bills. The server chooses the Stripe price from (tier, interval);
/// the desktop never sends a price id.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BillingInterval {
    #[default]
    Month,
    Year,
}

impl BillingInterval {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Month => "month",
            Self::Year => "year",
        }
    }
}

pub trait AccountApi: Send + Sync {
    fn start_email(
        &self,
        email: &str,
        code_challenge: &str,
    ) -> Result<EmailStartResponse, ApiError>;
    fn poll_email(&self, poll_token: &str, code_verifier: &str) -> Result<PollResponse, ApiError>;
    fn start_social(
        &self,
        provider: SocialProvider,
        code_challenge: &str,
    ) -> Result<SocialStartResponse, ApiError> {
        let _ = (provider, code_challenge);
        Err(ApiError::Local("social_sign_in_unavailable"))
    }
    fn complete_social(
        &self,
        provider: SocialProvider,
        state: &str,
        code: &str,
        code_verifier: &str,
        nonce: &str,
    ) -> Result<SocialCompleteResponse, ApiError> {
        let _ = (provider, state, code, code_verifier, nonce);
        Err(ApiError::Local("social_sign_in_unavailable"))
    }
    fn refresh_session(&self, bearer: &str) -> Result<SignedInResponse, ApiError>;
    fn logout(&self, bearer: &str) -> Result<(), ApiError>;
    fn account(&self, bearer: &str) -> Result<ApiAccount, ApiError>;
    fn billing_interval(&self, _bearer: &str) -> Result<Option<BillingInterval>, ApiError> {
        Ok(None)
    }
    /// Sets (`Some`) or clears (`None`) the account's cosmetic display name and returns the
    /// updated account. The server trims, validates and normalizes the name.
    fn set_display_name(
        &self,
        bearer: &str,
        display_name: Option<&str>,
    ) -> Result<ApiAccount, ApiError>;
    fn activate_free(&self, bearer: &str) -> Result<(), ApiError>;
    fn checkout(
        &self,
        bearer: &str,
        tier: PaidTier,
        interval: BillingInterval,
        request_id: &str,
    ) -> Result<BrowserUrlResponse, ApiError>;
    fn portal(&self, bearer: &str, request_id: &str) -> Result<BrowserUrlResponse, ApiError>;
    fn entitlement(&self, bearer: &str) -> Result<EntitlementResponse, ApiError>;
    fn usage(&self, bearer: &str) -> Result<UsageResponse, ApiError>;
    fn record_kalvoice(
        &self,
        bearer: &str,
        request_id: &str,
        offline: bool,
    ) -> Result<RequestUsageResponse, ApiError> {
        let _ = (bearer, request_id, offline);
        Err(ApiError::Local("kalvoice_meter_unavailable"))
    }
}

#[derive(Clone)]
pub struct HttpAccountApi {
    agent: ureq::Agent,
}

impl HttpAccountApi {
    pub fn new() -> Self {
        let config = ureq::Agent::config_builder()
            .timeout_global(Some(REQUEST_TIMEOUT))
            .timeout_connect(Some(CONNECT_TIMEOUT))
            .max_redirects(0)
            .http_status_as_error(false)
            .build();
        Self {
            agent: config.into(),
        }
    }

    fn url(path: &str) -> String {
        debug_assert!(path.starts_with('/'));
        format!("{API_ORIGIN}{path}")
    }

    fn get<T: DeserializeOwned>(&self, path: &str, bearer: &str) -> Result<T, ApiError> {
        let response = self
            .agent
            .get(Self::url(path))
            .header("Authorization", &format!("Bearer {bearer}"))
            .call()
            .map_err(|_| ApiError::Transport)?;
        decode_response(response)
    }

    fn post<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        bearer: Option<&str>,
        body: Option<&B>,
    ) -> Result<Option<T>, ApiError> {
        let mut request = self.agent.post(Self::url(path));
        if let Some(bearer) = bearer {
            request = request.header("Authorization", &format!("Bearer {bearer}"));
        }
        let response = match body {
            Some(body) => {
                let encoded = serde_json::to_vec(body)
                    .map_err(|_| ApiError::Local("request_encoding_failed"))?;
                request
                    .header("Content-Type", "application/json")
                    .send(encoded.as_slice())
            }
            None => request.send_empty(),
        }
        .map_err(|_| ApiError::Transport)?;
        if response.status().as_u16() == 204 {
            return Ok(None);
        }
        decode_response(response).map(Some)
    }
}

impl Default for HttpAccountApi {
    fn default() -> Self {
        Self::new()
    }
}

impl AccountApi for HttpAccountApi {
    fn start_email(
        &self,
        email: &str,
        code_challenge: &str,
    ) -> Result<EmailStartResponse, ApiError> {
        let wire: EmailStartWire = self
            .post(
                "/v1/auth/email/start",
                None,
                Some(&EmailStartRequest {
                    email,
                    client: "desktop",
                    code_challenge,
                }),
            )?
            .ok_or(ApiError::InvalidResponse)?;
        if !wire.ok || wire.status != "email_sent" {
            return Err(ApiError::InvalidResponse);
        }
        Ok(EmailStartResponse {
            expires_at: wire.expires_at,
            poll_token: wire.poll_token,
        })
    }

    fn poll_email(&self, poll_token: &str, code_verifier: &str) -> Result<PollResponse, ApiError> {
        let wire: PollWire = self
            .post(
                "/v1/auth/email/poll",
                None,
                Some(&PollRequest {
                    poll_token,
                    code_verifier,
                }),
            )?
            .ok_or(ApiError::InvalidResponse)?;
        match (wire.ok, wire.status.as_str(), wire.token, wire.expires_at) {
            (true, "pending", None, None) => Ok(PollResponse::Pending),
            (true, "signed_in", Some(token), Some(expires_at)) => {
                Ok(PollResponse::SignedIn(SignedInResponse {
                    token,
                    expires_at,
                }))
            }
            _ => Err(ApiError::InvalidResponse),
        }
    }

    fn start_social(
        &self,
        provider: SocialProvider,
        code_challenge: &str,
    ) -> Result<SocialStartResponse, ApiError> {
        let path = format!("/v1/auth/{}/start", provider.as_str());
        // The production service currently returns only Stable protocol links. Do not
        // launch a Dev sign-in that would open (and deliver its callback to) Stable.
        if kalcode_contracts::identity::URL_SCHEME != "kalcode" {
            return Err(ApiError::Local("social_sign_in_unavailable"));
        }
        let wire: SocialStartWire = self
            .post(
                &path,
                None,
                Some(&SocialStartRequest {
                    client: "desktop",
                    code_challenge,
                }),
            )?
            .ok_or(ApiError::InvalidResponse)?;
        if !wire.ok {
            return Err(ApiError::InvalidResponse);
        }
        Ok(SocialStartResponse {
            authorize_url: wire.authorize_url,
            nonce: wire.nonce,
            expires_at: wire.expires_at,
        })
    }

    fn complete_social(
        &self,
        provider: SocialProvider,
        state: &str,
        code: &str,
        code_verifier: &str,
        nonce: &str,
    ) -> Result<SocialCompleteResponse, ApiError> {
        let path = format!("/v1/auth/{}/complete", provider.as_str());
        let wire: SocialCompleteWire = self
            .post(
                &path,
                None,
                Some(&SocialCompleteRequest {
                    state,
                    code,
                    code_verifier,
                    nonce,
                }),
            )?
            .ok_or(ApiError::InvalidResponse)?;
        if !wire.ok {
            return Err(ApiError::InvalidResponse);
        }
        Ok(SocialCompleteResponse {
            token: wire.token,
            account_id: wire.account_id,
            expires_at: wire.expires_at,
        })
    }

    fn refresh_session(&self, bearer: &str) -> Result<SignedInResponse, ApiError> {
        let wire: SessionWire = self
            .post::<(), _>("/v1/auth/session/refresh", Some(bearer), None)?
            .ok_or(ApiError::InvalidResponse)?;
        if !wire.ok {
            return Err(ApiError::InvalidResponse);
        }
        Ok(SignedInResponse {
            token: wire.token,
            expires_at: wire.expires_at,
        })
    }

    fn logout(&self, bearer: &str) -> Result<(), ApiError> {
        let result = self.post::<(), serde_json::Value>("/v1/auth/logout", Some(bearer), None)?;
        if result.is_some() {
            return Err(ApiError::InvalidResponse);
        }
        Ok(())
    }

    fn account(&self, bearer: &str) -> Result<ApiAccount, ApiError> {
        // The profile route is the account plus its display name. A service that predates it
        // answers 404; the plain account route then still signs the person in, unnamed.
        let wire: AccountWire = match self.get("/v1/account/profile", bearer) {
            Err(error) if error.status() == Some(404) => self.get("/v1/account", bearer)?,
            other => other?,
        };
        wire.into_account()
    }

    fn billing_interval(&self, bearer: &str) -> Result<Option<BillingInterval>, ApiError> {
        #[derive(Deserialize)]
        struct Billing {
            interval: Option<BillingInterval>,
        }
        #[derive(Deserialize)]
        struct Status {
            ok: bool,
            billing: Billing,
        }
        let status: Status = self.get("/v1/billing/status", bearer)?;
        if !status.ok {
            return Err(ApiError::InvalidResponse);
        }
        Ok(status.billing.interval)
    }

    fn set_display_name(
        &self,
        bearer: &str,
        display_name: Option<&str>,
    ) -> Result<ApiAccount, ApiError> {
        let wire: AccountWire = self
            .post(
                "/v1/account/profile",
                Some(bearer),
                Some(&DisplayNameRequest { display_name }),
            )?
            .ok_or(ApiError::InvalidResponse)?;
        wire.into_account()
    }

    fn activate_free(&self, bearer: &str) -> Result<(), ApiError> {
        let wire: ActivateWire = self
            .post::<(), _>("/v1/account/activate-free", Some(bearer), None)?
            .ok_or(ApiError::InvalidResponse)?;
        if wire.ok && wire.tier == "free" {
            Ok(())
        } else {
            Err(ApiError::InvalidResponse)
        }
    }

    fn checkout(
        &self,
        bearer: &str,
        tier: PaidTier,
        interval: BillingInterval,
        request_id: &str,
    ) -> Result<BrowserUrlResponse, ApiError> {
        let wire: UrlWire = self
            .post(
                "/v1/billing/checkout",
                Some(bearer),
                Some(&CheckoutRequest::new(tier, interval, request_id)),
            )?
            .ok_or(ApiError::InvalidResponse)?;
        if !wire.ok || validate_browser_destination(&wire.url)? != BrowserDestination::Checkout {
            return Err(ApiError::InvalidResponse);
        }
        Ok(BrowserUrlResponse { url: wire.url })
    }

    fn portal(&self, bearer: &str, request_id: &str) -> Result<BrowserUrlResponse, ApiError> {
        let wire: UrlWire = self
            .post(
                "/v1/billing/portal",
                Some(bearer),
                Some(&RequestIdRequest { request_id }),
            )?
            .ok_or(ApiError::InvalidResponse)?;
        if !wire.ok || validate_browser_destination(&wire.url)? != BrowserDestination::Portal {
            return Err(ApiError::InvalidResponse);
        }
        Ok(BrowserUrlResponse { url: wire.url })
    }

    fn entitlement(&self, bearer: &str) -> Result<EntitlementResponse, ApiError> {
        let wire: EntitlementWire = self.get("/v1/entitlement", bearer)?;
        if !wire.ok || wire.entitlement.is_null() {
            return Err(ApiError::InvalidResponse);
        }
        Ok(EntitlementResponse { token: wire.token })
    }

    fn usage(&self, bearer: &str) -> Result<UsageResponse, ApiError> {
        let wire: UsageWire = self.get("/v1/kalvoice/usage", bearer)?;
        if !wire.ok {
            return Err(ApiError::InvalidResponse);
        }
        Ok(UsageResponse {
            usage: AccountUsageSnapshot {
                billing_interval: None,
                used: wire.usage.used,
                allowance: wire.usage.allowance,
                period_start: wire.usage.period_start,
                resets_at: wire.usage.resets_at,
            },
            receipt: wire.receipt,
        })
    }

    fn record_kalvoice(
        &self,
        bearer: &str,
        request_id: &str,
        offline: bool,
    ) -> Result<RequestUsageResponse, ApiError> {
        // Metering must not inherit authentication's long retry budget. An unknown outcome is
        // retained by the caller's durable outbox and reconciled with the same idempotency key.
        let bounded = Self {
            agent: ureq::Agent::config_builder()
                .timeout_global(Some(Duration::from_millis(750)))
                .timeout_connect(Some(Duration::from_millis(500)))
                .max_redirects(0)
                .http_status_as_error(false)
                .build()
                .into(),
        };
        let wire: RequestUsageWire = bounded
            .post(
                "/v1/kalvoice/requests",
                Some(bearer),
                Some(&serde_json::json!({
                    "requestId": request_id, "mode": if offline { "offline" } else { "online" }
                })),
            )?
            .ok_or(ApiError::InvalidResponse)?;
        if !wire.ok
            || !matches!(
                (wire.allowed, wire.outcome.as_str()),
                (true, "recorded" | "duplicate") | (false, "denied")
            )
        {
            return Err(ApiError::InvalidResponse);
        }
        Ok(RequestUsageResponse {
            allowed: wire.allowed,
            usage: UsageResponse {
                usage: AccountUsageSnapshot {
                    billing_interval: None,
                    used: wire.usage.used,
                    allowance: wire.usage.allowance,
                    period_start: wire.usage.period_start,
                    resets_at: wire.usage.resets_at,
                },
                receipt: wire.receipt,
            },
        })
    }
}

#[derive(Deserialize)]
struct RequestUsageWire {
    ok: bool,
    allowed: bool,
    outcome: String,
    usage: UsageBody,
    receipt: String,
}

fn decode_response<T: DeserializeOwned>(
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<T, ApiError> {
    let status = response.status().as_u16();
    let retry_after_seconds = response
        .headers()
        .get("Retry-After")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|seconds| seconds.min(MAX_RETRY_AFTER_SECONDS));
    let body = response
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES)
        .read_to_vec()
        .map_err(|_| ApiError::InvalidResponse)?;
    if !(200..300).contains(&status) {
        let error: ErrorWire =
            serde_json::from_slice(&body).map_err(|_| ApiError::InvalidResponse)?;
        if error.ok
            || error.error.is_empty()
            || error.error.len() > 128
            || error.message.len() > 512
        {
            return Err(ApiError::InvalidResponse);
        }
        return Err(ApiError::Http {
            status,
            code: error.error,
            retry_after_seconds,
        });
    }
    serde_json::from_slice(&body).map_err(|_| ApiError::InvalidResponse)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EmailStartRequest<'a> {
    email: &'a str,
    client: &'static str,
    code_challenge: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PollRequest<'a> {
    poll_token: &'a str,
    code_verifier: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SocialStartRequest<'a> {
    client: &'static str,
    code_challenge: &'a str,
}

#[cfg(test)]
mod social_start_request_tests {
    use super::*;

    #[test]
    fn dev_social_sign_in_refuses_before_contacting_stable_service() {
        if cfg!(debug_assertions) {
            assert!(matches!(
                HttpAccountApi::new().start_social(SocialProvider::Google, "challenge"),
                Err(ApiError::Local("social_sign_in_unavailable"))
            ));
        }
    }

    #[test]
    fn desktop_social_start_explicitly_requests_the_desktop_client_contract() {
        let encoded = serde_json::to_value(SocialStartRequest {
            client: "desktop",
            code_challenge: "challenge",
        })
        .expect("serialize social start request");
        assert_eq!(
            encoded,
            serde_json::json!({
                "client": "desktop",
                "codeChallenge": "challenge",
            })
        );
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SocialCompleteRequest<'a> {
    state: &'a str,
    code: &'a str,
    code_verifier: &'a str,
    nonce: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CheckoutRequest<'a> {
    tier: &'static str,
    request_id: &'a str,
    /// Absent means monthly, so a monthly request stays byte-identical to older builds.
    #[serde(skip_serializing_if = "Option::is_none")]
    interval: Option<&'static str>,
}

impl<'a> CheckoutRequest<'a> {
    fn new(tier: PaidTier, interval: BillingInterval, request_id: &'a str) -> Self {
        Self {
            tier: tier.as_str(),
            request_id,
            interval: match interval {
                BillingInterval::Month => None,
                BillingInterval::Year => Some(interval.as_str()),
            },
        }
    }
}

#[cfg(test)]
mod checkout_request_tests {
    use super::*;

    #[test]
    fn monthly_checkout_body_is_unchanged() {
        let body = serde_json::to_string(&CheckoutRequest::new(
            PaidTier::Max,
            BillingInterval::Month,
            "request-0001",
        ))
        .expect("serialize checkout request");
        assert_eq!(body, r#"{"tier":"max","requestId":"request-0001"}"#);
    }

    #[test]
    fn yearly_checkout_body_sends_year_interval_and_never_a_price() {
        let body = serde_json::to_value(CheckoutRequest::new(
            PaidTier::Pro,
            BillingInterval::Year,
            "request-0002",
        ))
        .expect("serialize checkout request");
        assert_eq!(
            body,
            serde_json::json!({
                "tier": "pro",
                "requestId": "request-0002",
                "interval": "year",
            })
        );
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RequestIdRequest<'a> {
    request_id: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EmailStartWire {
    ok: bool,
    status: String,
    expires_at: String,
    poll_token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PollWire {
    ok: bool,
    status: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    expires_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SocialStartWire {
    ok: bool,
    authorize_url: String,
    nonce: String,
    expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SocialCompleteWire {
    ok: bool,
    token: String,
    account_id: String,
    expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionWire {
    ok: bool,
    token: String,
    expires_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccountWire {
    ok: bool,
    account: AccountBody,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AccountBody {
    id: String,
    email: String,
    activated_at: Option<String>,
    /// Served only by `/v1/account/profile`; `/v1/account` keeps its shipped shape.
    #[serde(default)]
    display_name: Option<String>,
}

impl AccountWire {
    fn into_account(self) -> Result<ApiAccount, ApiError> {
        if !self.ok {
            return Err(ApiError::InvalidResponse);
        }
        Ok(ApiAccount {
            id: self.account.id,
            email: self.account.email,
            activated_at: self.account.activated_at,
            display_name: self.account.display_name,
        })
    }
}

/// `null` clears the name; the field is always sent.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DisplayNameRequest<'a> {
    display_name: Option<&'a str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ActivateWire {
    ok: bool,
    tier: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UrlWire {
    ok: bool,
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EntitlementWire {
    ok: bool,
    token: String,
    entitlement: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageWire {
    ok: bool,
    usage: UsageBody,
    receipt: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UsageBody {
    used: u64,
    allowance: Option<u64>,
    period_start: String,
    resets_at: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ErrorWire {
    ok: bool,
    error: String,
    message: String,
}
