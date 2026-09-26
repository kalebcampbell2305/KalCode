use std::fmt;

use serde::{Deserialize, Serialize};
use url::Url;

use super::api::ApiError;

const OPAQUE_LENGTH: usize = 43;
const MAX_OAUTH_VALUE_LENGTH: usize = 2_048;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SocialProvider {
    Google,
    Microsoft,
}

impl SocialProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Google => "google",
            Self::Microsoft => "microsoft",
        }
    }

    pub fn parse(value: &str) -> Result<Self, SocialCallbackError> {
        match value {
            "google" => Ok(Self::Google),
            "microsoft" => Ok(Self::Microsoft),
            _ => Err(SocialCallbackError),
        }
    }

    fn authorization_endpoint(self) -> (&'static str, &'static str) {
        match self {
            Self::Google => ("accounts.google.com", "/o/oauth2/v2/auth"),
            Self::Microsoft => ("login.microsoftonline.com", "/common/oauth2/v2.0/authorize"),
        }
    }

    pub fn callback_url(self) -> String {
        format!(
            "https://api.kalcoded.com/v1/auth/{}/callback",
            self.as_str()
        )
    }
}

#[derive(Clone, PartialEq, Eq)]
pub enum SocialCallback {
    Success {
        provider: SocialProvider,
        state: String,
        code: String,
    },
    Canceled {
        provider: SocialProvider,
        state: String,
    },
    Failed {
        provider: SocialProvider,
        state: String,
    },
}

impl SocialCallback {
    pub fn provider(&self) -> SocialProvider {
        match self {
            Self::Success { provider, .. }
            | Self::Canceled { provider, .. }
            | Self::Failed { provider, .. } => *provider,
        }
    }

    pub fn state(&self) -> &str {
        match self {
            Self::Success { state, .. }
            | Self::Canceled { state, .. }
            | Self::Failed { state, .. } => state,
        }
    }
}

impl fmt::Debug for SocialCallback {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (provider, outcome) = match self {
            Self::Success { provider, .. } => (provider, "success"),
            Self::Canceled { provider, .. } => (provider, "canceled"),
            Self::Failed { provider, .. } => (provider, "failed"),
        };
        formatter
            .debug_struct("SocialCallback")
            .field("provider", provider)
            .field("outcome", &outcome)
            .field("payload", &"[REDACTED]")
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SocialCallbackError;

pub fn parse_social_callback(raw: &str) -> Result<SocialCallback, SocialCallbackError> {
    if raw.len() > 8_192 || raw.chars().any(char::is_control) {
        return Err(SocialCallbackError);
    }
    let url = Url::parse(raw).map_err(|_| SocialCallbackError)?;
    if url.scheme() != "kalcode"
        || url.host_str() != Some("auth")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err(SocialCallbackError);
    }
    let provider = SocialProvider::parse(url.path().strip_prefix('/').unwrap_or_default())?;
    if url.path_segments().is_none_or(|mut segments| {
        segments.next() != Some(provider.as_str()) || segments.next().is_some()
    }) {
        return Err(SocialCallbackError);
    }

    let mut code = None;
    let mut state = None;
    let mut error = None;
    let mut fields = 0_u8;
    for (key, value) in url.query_pairs() {
        fields = fields.saturating_add(1);
        let slot = match key.as_ref() {
            "code" => &mut code,
            "state" => &mut state,
            "error" => &mut error,
            _ => return Err(SocialCallbackError),
        };
        if slot.replace(value.into_owned()).is_some() {
            return Err(SocialCallbackError);
        }
    }
    if fields != 2 {
        return Err(SocialCallbackError);
    }
    let state = state
        .filter(|value| valid_opaque(value))
        .ok_or(SocialCallbackError)?;
    match (code, error) {
        (Some(code), None) if valid_oauth_value(&code) => Ok(SocialCallback::Success {
            provider,
            state,
            code,
        }),
        (None, Some(error)) if error == "sign_in_canceled" => {
            Ok(SocialCallback::Canceled { provider, state })
        }
        (None, Some(error)) if error == "sign_in_failed" => {
            Ok(SocialCallback::Failed { provider, state })
        }
        _ => Err(SocialCallbackError),
    }
}

pub fn validate_social_authorize_url(
    raw: &str,
    provider: SocialProvider,
    expected_challenge: &str,
    expected_nonce: &str,
) -> Result<String, ApiError> {
    if raw.len() > 8_192 || !valid_opaque(expected_challenge) || !valid_opaque(expected_nonce) {
        return Err(ApiError::InvalidResponse);
    }
    let url = Url::parse(raw).map_err(|_| ApiError::InvalidResponse)?;
    let (host, path) = provider.authorization_endpoint();
    if url.scheme() != "https"
        || url.host_str() != Some(host)
        || url.path() != path
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err(ApiError::InvalidResponse);
    }

    let expected_fields = if provider == SocialProvider::Microsoft {
        9
    } else {
        8
    };
    let mut client_id = None;
    let mut redirect_uri = None;
    let mut response_type = None;
    let mut scope = None;
    let mut state = None;
    let mut nonce = None;
    let mut challenge = None;
    let mut challenge_method = None;
    let mut fields = 0_usize;
    for (key, value) in url.query_pairs() {
        fields += 1;
        let value = value.into_owned();
        let slot = match key.as_ref() {
            "client_id" => &mut client_id,
            "redirect_uri" => &mut redirect_uri,
            "response_type" => &mut response_type,
            "scope" => &mut scope,
            "state" => &mut state,
            "nonce" => &mut nonce,
            "code_challenge" => &mut challenge,
            "code_challenge_method" => &mut challenge_method,
            "response_mode" if provider == SocialProvider::Microsoft => {
                if value != "query" {
                    return Err(ApiError::InvalidResponse);
                }
                continue;
            }
            _ => return Err(ApiError::InvalidResponse),
        };
        if slot.replace(value).is_some() {
            return Err(ApiError::InvalidResponse);
        }
    }
    let state = state
        .filter(|value| valid_opaque(value))
        .ok_or(ApiError::InvalidResponse)?;
    let client_id = client_id.ok_or(ApiError::InvalidResponse)?;
    if fields != expected_fields
        || client_id.is_empty()
        || client_id.len() > 512
        || client_id.chars().any(char::is_control)
        || redirect_uri.as_deref() != Some(provider.callback_url().as_str())
        || response_type.as_deref() != Some("code")
        || scope.as_deref() != Some("openid email")
        || nonce.as_deref() != Some(expected_nonce)
        || challenge.as_deref() != Some(expected_challenge)
        || challenge_method.as_deref() != Some("S256")
    {
        return Err(ApiError::InvalidResponse);
    }
    Ok(state)
}

pub fn valid_opaque(value: &str) -> bool {
    value.len() == OPAQUE_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn valid_oauth_value(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_OAUTH_VALUE_LENGTH
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'~' | b'-'))
}
