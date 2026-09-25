//! Hosts and URLs: normalization, documentation hosts, and local addresses.

/// Hosts whose pages are documentation. Reading them is `network.docs`; anything else, and any
/// request that sends data, is `network.other`. Subdomains match on a label boundary.
pub const DOCS_HOSTS: &[&str] = &[
    "docs.rs",
    "doc.rust-lang.org",
    "rust-lang.github.io",
    "developer.mozilla.org",
    "docs.python.org",
    "nodejs.org",
    "learn.microsoft.com",
    "docs.github.com",
    "react.dev",
    "www.typescriptlang.org",
    "typescriptlang.org",
    "pkg.go.dev",
    "go.dev",
    "docs.npmjs.com",
    "v2.tauri.app",
    "tauri.app",
    "vite.dev",
    "vitest.dev",
    "playwright.dev",
    "docs.anthropic.com",
    "platform.openai.com",
    "ai.google.dev",
    "sqlite.org",
    "www.sqlite.org",
    "kotlinlang.org",
    "docs.oracle.com",
    "en.cppreference.com",
    "cppreference.com",
    "docs.djangoproject.com",
    "docs.docker.com",
    "kubernetes.io",
    "developer.apple.com",
    "developer.android.com",
    "developers.cloudflare.com",
    "context7.com",
];

/// A normalized host name, or `None` when the text is not a plain DNS name or IP literal.
/// Lower-cases, strips one trailing dot, and rejects user-info, whitespace, non-ASCII
/// (homoglyph) and percent-encoded forms.
pub fn normalize_host(raw: &str) -> Option<String> {
    let host = raw.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || host.len() > 253 {
        return None;
    }
    let (name, port) = split_port(&host);
    if let Some(port) = port
        && (port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let name = name.trim_end_matches('.');
    let bracketed = name.starts_with('[') && name.ends_with(']');
    let valid = if bracketed {
        name[1..name.len() - 1]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() || b == b':' || b == b'.')
    } else {
        !name.is_empty()
            && name.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            })
    };
    valid.then(|| name.to_owned())
}

fn split_port(host: &str) -> (&str, Option<&str>) {
    if host.starts_with('[') {
        return match host.find(']') {
            Some(end) if host[end + 1..].starts_with(':') => {
                (&host[..=end], Some(&host[end + 2..]))
            }
            _ => (host, None),
        };
    }
    match host.rfind(':') {
        Some(i) if host.matches(':').count() == 1 => (&host[..i], Some(&host[i + 1..])),
        _ => (host, None),
    }
}

/// Extracts the host of an `http(s)`/`ws(s)`/`ftp` URL. User-info (`user@host`) is honoured
/// the way a URL parser would: the host is what follows the last `@` of the authority, so
/// `https://docs.rs@evil.example/` is `evil.example`. Returns `None` for anything malformed.
pub fn url_host(url: &str) -> Option<String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    let rest = [
        "https://", "http://", "wss://", "ws://", "ftp://", "ftps://",
    ]
    .iter()
    .find_map(|scheme| lower.starts_with(scheme).then(|| &url[scheme.len()..]))?;
    let authority_end = rest.find(['/', '?', '#', '\\']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.contains('%') || authority.chars().any(|c| c.is_whitespace()) {
        return None;
    }
    let host = authority.rsplit('@').next()?;
    normalize_host(host)
}

/// True when `host` equals `domain` or is a subdomain of it (label boundary).
pub fn host_matches(host: &str, domain: &str) -> bool {
    let domain = domain.trim().trim_start_matches("*.").trim_end_matches('.');
    let domain = domain.to_ascii_lowercase();
    !domain.is_empty()
        && (host == domain
            || (host.len() > domain.len()
                && host.ends_with(&domain)
                && host.as_bytes()[host.len() - domain.len() - 1] == b'.'))
}

pub fn is_docs_host(host: &str) -> bool {
    DOCS_HOSTS.iter().any(|domain| host_matches(host, domain))
}

/// Loopback addresses: traffic that never leaves the machine.
pub fn is_local_host(host: &str) -> bool {
    matches!(
        host,
        "localhost" | "127.0.0.1" | "[::1]" | "::1" | "0.0.0.0"
    ) || host.ends_with(".localhost")
        || host.starts_with("127.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_normalize_or_fail() {
        assert_eq!(normalize_host("Docs.RS."), Some("docs.rs".into()));
        assert_eq!(normalize_host("docs.rs:443"), Some("docs.rs".into()));
        assert_eq!(normalize_host("[::1]:8080"), Some("[::1]".into()));
        for bad in [
            "",
            "docs rs",
            "dоcs.rs", /* Cyrillic o */
            "a@b",
            "a/b",
            "docs.rs:x",
            "-a.com",
        ] {
            assert_eq!(normalize_host(bad), None, "{bad}");
        }
    }

    #[test]
    fn url_hosts_resist_userinfo_tricks() {
        assert_eq!(url_host("https://docs.rs/serde"), Some("docs.rs".into()));
        assert_eq!(
            url_host("https://docs.rs@evil.example/x"),
            Some("evil.example".into())
        );
        assert_eq!(
            url_host("https://docs.rs:pw@evil.example"),
            Some("evil.example".into())
        );
        assert_eq!(url_host("HTTPS://DOCS.RS"), Some("docs.rs".into()));
        assert_eq!(url_host("https://docs.rs%2eevil.example/"), None);
        assert_eq!(url_host("file:///etc/passwd"), None);
        assert_eq!(url_host("javascript:alert(1)"), None);
    }

    #[test]
    fn docs_matching_uses_label_boundaries() {
        assert!(is_docs_host("docs.rs"));
        assert!(is_docs_host("learn.microsoft.com"));
        assert!(!is_docs_host("docs.rs.evil.example"));
        assert!(!is_docs_host("evildocs.rs"));
        assert!(!is_docs_host("microsoft.com"));
        assert!(host_matches("api.github.com", "github.com"));
        assert!(!host_matches("notgithub.com", "github.com"));
    }
}
