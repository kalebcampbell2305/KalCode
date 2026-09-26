//! Redaction for the API Inspector's history and saved requests: nothing that looks like a
//! credential is kept. Sensitive headers lose their value, secret-looking query values and URL
//! spans are replaced, and bodies go through the Context Firewall's secret catalogue
//! (`kalcode_context::secrets`, over the shared `kalcode_core::redact`).

use kalcode_core::redact::{PlaceholderStyle, apply};

use crate::types::{HttpHeader, HttpQueryParam, HttpRequestSpec};

pub const PLACEHOLDER: &str = "[REDACTED]";

/// Header names whose values are credentials or session state.
const SENSITIVE_HEADER_WORDS: &[&str] = &[
    "auth",
    "token",
    "secret",
    "password",
    "passwd",
    "cookie",
    "session",
    "key",
    "signature",
    "credential",
    "csrf",
    "xsrf",
];

/// Query parameter names whose values are credentials.
const SENSITIVE_PARAM_WORDS: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "pwd",
    "key",
    "auth",
    "signature",
    "sig",
    "session",
    "credential",
    "jwt",
];

/// True when a header's value must never be stored (`Authorization`, `Cookie`, `X-Api-Key`,
/// `X-Auth-Token`, …).
pub fn is_sensitive_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SENSITIVE_HEADER_WORDS.iter().any(|w| lower.contains(w))
}

fn is_sensitive_param(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == "code" || SENSITIVE_PARAM_WORDS.iter().any(|w| lower.contains(w))
}

/// `text` with every detected secret replaced by a labelled placeholder, and how many.
pub fn redact_text(text: &str) -> (String, u32) {
    let findings = kalcode_context::secrets::scan(text);
    if findings.is_empty() {
        return (text.to_owned(), 0);
    }
    let redacted = apply(text, &findings, PlaceholderStyle::Labelled);
    (
        redacted.text,
        u32::try_from(redacted.spans.len()).unwrap_or(u32::MAX),
    )
}

/// A URL with secret-looking query values replaced (by name or by content) and any other
/// detected secret span (a token in the path) redacted.
pub fn redact_url(raw: &str) -> (String, u32) {
    let Ok(mut url) = url::Url::parse(raw) else {
        return redact_text(raw);
    };
    let mut count = 0u32;
    if url.query().is_some() {
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| (k.into_owned(), v.into_owned()))
            .collect();
        let mut rewritten = Vec::with_capacity(pairs.len());
        for (name, value) in pairs {
            let (value, n) = redact_param(&name, &value);
            count += n;
            rewritten.push((name, value));
        }
        url.query_pairs_mut().clear().extend_pairs(rewritten);
    }
    if !url.username().is_empty() || url.password().is_some() {
        let _ = url.set_username("");
        let _ = url.set_password(None);
        count += 1;
    }
    // Placeholders are shown as written, not percent-encoded.
    let display = url.as_str().replace("%5BREDACTED%5D", PLACEHOLDER);
    let (text, n) = redact_text(&display);
    (text, count + n)
}

fn redact_param(name: &str, value: &str) -> (String, u32) {
    if value.is_empty() {
        return (String::new(), 0);
    }
    if is_sensitive_param(name) {
        return (PLACEHOLDER.to_owned(), 1);
    }
    let findings = kalcode_context::secrets::scan(&format!("{name}={value}"));
    if findings.is_empty() {
        (value.to_owned(), 0)
    } else {
        (PLACEHOLDER.to_owned(), 1)
    }
}

/// The request as it may be stored: sensitive header values dropped (name kept, value empty,
/// `sensitive: true`), secret-looking query values replaced, the URL and body redacted.
pub fn redact_request(spec: &HttpRequestSpec) -> (HttpRequestSpec, u32) {
    let mut count = 0u32;
    let (url, n) = redact_url(&spec.url);
    count += n;
    let query = spec
        .query
        .iter()
        .map(|p| {
            let (value, n) = redact_param(&p.name, &p.value);
            count += n;
            HttpQueryParam {
                name: p.name.clone(),
                value,
                enabled: p.enabled,
            }
        })
        .collect();
    let headers = spec
        .headers
        .iter()
        .map(|h| {
            if h.sensitive || is_sensitive_header(&h.name) {
                if !h.value.is_empty() {
                    count += 1;
                }
                HttpHeader {
                    name: h.name.clone(),
                    value: String::new(),
                    sensitive: true,
                }
            } else {
                let (value, n) = redact_text(&h.value);
                count += n;
                HttpHeader {
                    name: h.name.clone(),
                    value,
                    sensitive: false,
                }
            }
        })
        .collect();
    let body = spec.body.as_ref().map(|b| {
        let (text, n) = redact_text(b);
        count += n;
        text
    });
    (
        HttpRequestSpec {
            method: spec.method,
            url,
            query,
            headers,
            body,
            timeout_ms: spec.timeout_ms,
            follow_redirects: spec.follow_redirects,
        },
        count,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::HttpMethod;

    #[test]
    fn sensitive_headers_are_recognised_by_name() {
        for name in [
            "Authorization",
            "cookie",
            "X-Api-Key",
            "X-Auth-Token",
            "Proxy-Authorization",
            "X-CSRF-Token",
        ] {
            assert!(is_sensitive_header(name), "{name}");
        }
        for name in ["Accept", "Content-Type", "User-Agent", "X-Request-Id"] {
            assert!(!is_sensitive_header(name), "{name}");
        }
    }

    #[test]
    fn stored_requests_never_hold_credentials() {
        let token = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
        let spec = HttpRequestSpec {
            method: HttpMethod::Post,
            url: format!(
                "https://api.example.com/v1/items?api_key=abc123&page=2&access_token={token}"
            ),
            query: vec![
                HttpQueryParam {
                    name: "signature".into(),
                    value: "deadbeef".into(),
                    enabled: true,
                },
                HttpQueryParam {
                    name: "q".into(),
                    value: "shoes".into(),
                    enabled: true,
                },
            ],
            headers: vec![
                HttpHeader {
                    name: "Authorization".into(),
                    value: format!("Bearer {token}"),
                    sensitive: false,
                },
                HttpHeader {
                    name: "X-Custom".into(),
                    value: "plain".into(),
                    sensitive: true,
                },
                HttpHeader {
                    name: "Accept".into(),
                    value: "application/json".into(),
                    sensitive: false,
                },
            ],
            body: Some(format!(
                "{{\"password\": \"hunter22\", \"note\": \"{token}\"}}"
            )),
            timeout_ms: None,
            follow_redirects: false,
        };
        let (stored, count) = redact_request(&spec);
        let json = serde_json::to_string(&stored).expect("json");
        assert!(!json.contains(token), "{json}");
        assert!(!json.contains("abc123"), "{json}");
        assert!(!json.contains("deadbeef"), "{json}");
        assert!(!json.contains("hunter22"), "{json}");
        assert!(json.contains("page=2"), "{json}");
        assert!(json.contains("shoes"), "{json}");
        assert!(json.contains("application/json"), "{json}");
        assert_eq!(stored.headers[0].value, "");
        assert!(stored.headers[0].sensitive);
        assert_eq!(stored.headers[1].value, "");
        assert!(count >= 6, "{count}");
    }

    #[test]
    fn user_info_is_removed_from_urls() {
        let (url, n) = redact_url("https://me:pa55@example.com/x");
        assert_eq!(url, "https://example.com/x");
        assert_eq!(n, 1);
    }
}
