//! Pure validation for the embedded browser trust boundary.

use std::fmt;

use kalcode_contracts::ids::is_valid_id;
use serde::{Deserialize, Serialize};
use tauri::Url;

pub const MAX_BROWSER_URL_CHARS: usize = 2048;
const MAX_LOGICAL_COORDINATE: f64 = 16_384.0;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserPolicyError(&'static str);

impl BrowserPolicyError {
    pub const fn message(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for BrowserPolicyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for BrowserPolicyError {}

fn local_development_address(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower == "localhost"
        || lower.starts_with("localhost:")
        || lower.starts_with("localhost/")
        || lower == "127.0.0.1"
        || lower.starts_with("127.0.0.1:")
        || lower.starts_with("127.0.0.1/")
        || lower == "[::1]"
        || lower.starts_with("[::1]:")
        || lower.starts_with("[::1]/")
}

fn looks_like_explicit_scheme(value: &str) -> bool {
    let Some(colon) = value.find(':') else {
        return false;
    };
    let scheme = &value[..colon];
    !scheme.is_empty()
        && scheme.as_bytes()[0].is_ascii_alphabetic()
        && scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
}

/// Normalizes an address-bar value and rejects every scheme except credential-free HTTP(S).
pub fn normalize_browser_url(input: &str) -> Result<Url, BrowserPolicyError> {
    if input.is_empty()
        || input.chars().count() > MAX_BROWSER_URL_CHARS
        || input.chars().any(char::is_control)
    {
        return Err(BrowserPolicyError("Enter a valid web address."));
    }
    let value = input.trim();
    if value.is_empty() || value.chars().count() > MAX_BROWSER_URL_CHARS {
        return Err(BrowserPolicyError("Enter a valid web address."));
    }
    let lower = value.to_ascii_lowercase();
    let candidate = if lower.starts_with("http://") || lower.starts_with("https://") {
        value.to_owned()
    } else if local_development_address(value) {
        format!("http://{value}")
    } else if value.contains("://") || looks_like_explicit_scheme(value) {
        return Err(BrowserPolicyError(
            "Only HTTP and HTTPS addresses can open here.",
        ));
    } else {
        format!("https://{value}")
    };

    let url =
        Url::parse(&candidate).map_err(|_| BrowserPolicyError("Enter a valid web address."))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none_or(str::is_empty)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.as_str().chars().count() > MAX_BROWSER_URL_CHARS
    {
        return Err(BrowserPolicyError(
            "Only credential-free HTTP and HTTPS addresses can open here.",
        ));
    }
    Ok(url)
}

pub fn validate_browser_id(browser_id: &str) -> Result<(), BrowserPolicyError> {
    is_valid_id(browser_id)
        .then_some(())
        .ok_or(BrowserPolicyError("That browser pane is unavailable."))
}

pub fn validate_bounds(bounds: BrowserBounds) -> Result<(), BrowserPolicyError> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if values.iter().any(|value| !value.is_finite())
        || bounds.x < 0.0
        || bounds.y < 0.0
        || bounds.width < 1.0
        || bounds.height < 1.0
        || values.iter().any(|value| *value > MAX_LOGICAL_COORDINATE)
    {
        return Err(BrowserPolicyError("The browser pane has invalid bounds."));
    }
    Ok(())
}

pub fn safe_runtime_url(url: &Url) -> bool {
    normalize_browser_url(url.as_str()).is_ok()
}
