//! The API Inspector's HTTP client (UD-06).
//!
//! Every request is sent from native code, never from the WebView, and each hop (the request
//! and every redirect it follows) passes the same steps:
//!
//! 1. **Validate** the request natively: `http`/`https` only, no user-info in the URL, a fixed
//!    method list, well-formed header names and values, framing headers refused, size caps.
//! 2. **Authorize DNS** with an exact, durable, one-time `UtilityDnsResolve` approval. A deny,
//!    pending, expired or replayed approval ends the operation before name resolution.
//! 3. **Resolve** the host once and **classify** every address ([`destination`]). The connection
//!    is pinned to exactly those addresses, so DNS can't point the request elsewhere after the
//!    check (rebinding).
//! 4. **Authorize and confirm** the pinned hop with a fresh destination-bound `UtilityHttp`
//!    approval. Loopback needs no extra native confirmation; the first request of the session to
//!    any other host uses [`NetworkGate::confirm`], and link-local/metadata addresses always need
//!    their own per-hop native confirmation.
//! 5. **Send** with a timeout, no cookies, no stored credentials, no proxy, no automatic
//!    redirects, and read at most [`MAX_RESPONSE_BYTES`] of the body.
//!
//! What is logged: the method and the host, never the path, query, headers or body. The
//! session's history is redacted ([`redact`]).

pub mod destination;
pub mod redact;

use std::collections::{HashSet, VecDeque};
use std::io::Read;
use std::net::SocketAddr;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant};

use kalcode_core::{ErrorCategory, KalError, Result};
use ureq::http;
use ureq::unversioned::resolver::{ResolvedSocketAddrs, Resolver};
use ureq::unversioned::transport::{DefaultConnector, NextTimeout};

use crate::types::{
    HttpBodyKind, HttpDestination, HttpHeader, HttpHistoryEntry, HttpMethod, HttpRedirectHop,
    HttpRequestSpec, HttpResponseView, HttpTiming,
};
use crate::{invalid, refused};

/// Largest request body sent.
pub const MAX_REQUEST_BODY: usize = 1024 * 1024;
/// Most response body bytes read; the rest is left unread and the view says so.
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_URL_BYTES: usize = 8192;
pub const MAX_HEADERS: usize = 64;
pub const MAX_HEADER_BYTES: usize = 16 * 1024;
pub const MAX_REDIRECTS: usize = 5;
pub const DEFAULT_TIMEOUT_MS: u32 = 15_000;
pub const MIN_TIMEOUT_MS: u32 = 1_000;
pub const MAX_TIMEOUT_MS: u32 = 60_000;
/// Requests kept in the session history.
pub const HISTORY_LIMIT: usize = 50;
/// Hex preview of a binary body.
const BINARY_PREVIEW: usize = 4096;

/// Headers the person can't set: the client frames the request itself, and proxies are never
/// used.
const FORBIDDEN_HEADERS: &[&str] = &[
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "upgrade",
    "te",
    "trailer",
    "proxy-authorization",
    "proxy-connection",
    "expect",
];

/// The permission engine's verdict on a `network` action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateVerdict {
    /// A rule allows it outright.
    Allow,
    /// The policy asks: the person's own Send (loopback) or a native confirmation answers it.
    Ask,
    Deny {
        reason: String,
    },
}

/// What stands between a request and the network: the permission engine and the native
/// confirmation dialog. Implemented by the desktop shell (`PermissionService` +
/// `TauriConfirmer`); tests use scripted gates.
pub trait NetworkGate: Send + Sync {
    /// Evaluates `ActionKind::Network { host, url }` for `ActionOrigin::Utility { tool:
    /// "api_inspector" }`. `origin_url` is `scheme://host[:port]/` — never the path or query.
    fn evaluate(&self, host: &str, origin_url: &str) -> GateVerdict;
    /// Shows the native confirmation for a request to `host` (D8). `Err` carries the refusal
    /// code (`confirmation_declined`, `confirmation_unavailable`).
    fn confirm(
        &self,
        host: &str,
        destination: HttpDestination,
    ) -> std::result::Result<(), &'static str>;
}

/// A validated request, ready to be sent.
#[derive(Debug, Clone)]
pub struct Prepared {
    pub method: HttpMethod,
    pub url: url::Url,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
    pub timeout: Duration,
}

impl Prepared {
    /// The host as the engine and the confirmation name it (lower-case; IPv6 in brackets).
    pub fn host(&self) -> String {
        match self.url.host() {
            Some(url::Host::Ipv6(v6)) => format!("[{v6}]"),
            Some(host) => host.to_string().to_ascii_lowercase(),
            None => String::new(),
        }
    }

    pub fn port(&self) -> u16 {
        self.url.port_or_known_default().unwrap_or(80)
    }

    /// `scheme://host[:port]/` for the permission engine (no path, no query).
    pub fn origin_url(&self) -> String {
        let port = match self.url.port() {
            Some(p) => format!(":{p}"),
            None => String::new(),
        };
        format!("{}://{}{port}/", self.url.scheme(), self.host())
    }
}

fn is_token(name: &str) -> bool {
    !name.is_empty()
        && name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

/// Validates a request spec (step 1).
pub fn prepare(spec: &HttpRequestSpec) -> Result<Prepared> {
    let raw = spec.url.trim();
    if raw.is_empty() {
        return Err(invalid(
            "url_missing",
            "Enter a URL to send the request to.",
        ));
    }
    if raw.len() > MAX_URL_BYTES {
        return Err(invalid("url_too_long", "That URL is longer than 8 KiB."));
    }
    let mut url = url::Url::parse(raw).map_err(|_| {
        invalid(
            "url_invalid",
            "That isn't a valid URL. Use a full address such as http://localhost:3000/api.",
        )
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(invalid(
            "url_scheme",
            "The API Inspector sends http:// and https:// requests only.",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid(
            "url_credentials",
            "Credentials in the URL aren't sent. Add an Authorization header instead.",
        ));
    }
    if url.host().is_none() {
        return Err(invalid("url_host", "That URL has no host."));
    }
    url.set_fragment(None);
    let enabled: Vec<_> = spec.query.iter().filter(|p| p.enabled).collect();
    if !enabled.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for param in enabled {
            if param.name.is_empty() || param.name.len() > 1024 || param.value.len() > 4096 {
                return Err(invalid(
                    "query_invalid",
                    "Query parameters need a name (up to 1 KiB) and values up to 4 KiB.",
                ));
            }
            pairs.append_pair(&param.name, &param.value);
        }
    }
    if url.as_str().len() > MAX_URL_BYTES {
        return Err(invalid(
            "url_too_long",
            "The URL with its query is longer than 8 KiB.",
        ));
    }
    if spec.headers.len() > MAX_HEADERS {
        return Err(invalid(
            "headers_too_many",
            "A request can have at most 64 headers.",
        ));
    }
    let mut total = 0usize;
    let mut headers = Vec::with_capacity(spec.headers.len());
    for header in &spec.headers {
        let name = header.name.trim();
        if name.is_empty() && header.value.is_empty() {
            continue;
        }
        if !is_token(name) {
            return Err(invalid(
                "header_name_invalid",
                format!(
                    "“{}” isn't a valid header name.",
                    kalcode_core::confirm::sanitize(name)
                ),
            ));
        }
        if FORBIDDEN_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(invalid(
                "header_forbidden",
                format!("KalCode sets the {name} header itself."),
            ));
        }
        if header
            .value
            .chars()
            .any(|c| c == '\r' || c == '\n' || c == '\0')
        {
            return Err(invalid(
                "header_value_invalid",
                format!("The value of {name} contains a line break."),
            ));
        }
        total += name.len() + header.value.len();
        headers.push((name.to_owned(), header.value.clone()));
    }
    if total > MAX_HEADER_BYTES {
        return Err(invalid(
            "headers_too_large",
            "Headers are larger than 16 KiB in total.",
        ));
    }
    let body = match &spec.body {
        Some(body) if !body.is_empty() => {
            if matches!(spec.method, HttpMethod::Get | HttpMethod::Head) {
                return Err(invalid(
                    "body_not_allowed",
                    "GET and HEAD requests are sent without a body. Choose POST, PUT or PATCH.",
                ));
            }
            if body.len() > MAX_REQUEST_BODY {
                return Err(invalid("body_too_large", "The body is larger than 1 MiB."));
            }
            Some(body.clone().into_bytes())
        }
        _ => None,
    };
    let timeout_ms = spec
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
    Ok(Prepared {
        method: spec.method,
        url,
        headers,
        body,
        timeout: Duration::from_millis(u64::from(timeout_ms)),
    })
}

/// A resolver that returns the addresses resolved and classified before the request (step 3):
/// ureq never looks the name up again.
#[derive(Debug)]
struct PinnedResolver {
    addrs: Vec<SocketAddr>,
}

impl Resolver for PinnedResolver {
    fn resolve(
        &self,
        _uri: &http::Uri,
        _config: &ureq::config::Config,
        _timeout: NextTimeout,
    ) -> std::result::Result<ResolvedSocketAddrs, ureq::Error> {
        let mut out = self.empty();
        for addr in self.addrs.iter().take(16) {
            out.push(*addr);
        }
        if out.is_empty() {
            Err(ureq::Error::HostNotFound)
        } else {
            Ok(out)
        }
    }
}

fn agent(addrs: Vec<SocketAddr>, timeout: Duration) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        // Redirects are followed here, one gated hop at a time.
        .max_redirects(0)
        .max_redirects_will_error(false)
        // Never through a proxy from the environment: the pinned address is the destination.
        .proxy(None)
        .timeout_global(Some(timeout))
        .user_agent("KalCode-API-Inspector")
        .max_response_header_size(64 * 1024)
        .max_idle_connections(0)
        .build();
    ureq::Agent::with_parts(
        config,
        DefaultConnector::default(),
        PinnedResolver { addrs },
    )
}

fn network_error(error: &ureq::Error) -> KalError {
    let (code, message): (&'static str, String) = match error {
        ureq::Error::Timeout(_) => ("http_timeout", "The request timed out.".into()),
        ureq::Error::HostNotFound => ("host_not_found", "The host couldn't be reached.".into()),
        ureq::Error::Io(io) if io.kind() == std::io::ErrorKind::ConnectionRefused => (
            "connection_refused",
            "Nothing is listening at that address (connection refused).".into(),
        ),
        ureq::Error::Io(io) if io.kind() == std::io::ErrorKind::TimedOut => {
            ("http_timeout", "Connecting timed out.".into())
        }
        ureq::Error::Io(_) | ureq::Error::ConnectionFailed => (
            "connection_failed",
            "KalCode couldn't connect to that address.".into(),
        ),
        ureq::Error::Protocol(_) => (
            "protocol_error",
            "The server's answer wasn't valid HTTP.".into(),
        ),
        ureq::Error::Tls(_) | ureq::Error::Rustls(_) => (
            "tls_error",
            "The secure connection failed (certificate or TLS error).".into(),
        ),
        ureq::Error::LargeResponseHeader(_, _) => (
            "headers_too_large",
            "The response headers are larger than 64 KiB.".into(),
        ),
        _ => ("request_failed", "The request failed.".into()),
    };
    KalError::new(ErrorCategory::Network, code, message)
}

/// The state kept for one app session: hosts already confirmed, and the history.
#[derive(Debug, Default)]
pub struct HttpSession {
    confirmed: Mutex<HashSet<(String, bool)>>,
    history: Mutex<VecDeque<HttpHistoryEntry>>,
    resolver: destination::TrackedResolver,
}

/// One hop's outcome.
struct Hop {
    status: u16,
    reason: String,
    headers: Vec<HttpHeader>,
    location: Option<String>,
    body: Vec<u8>,
    truncated: bool,
    destination: HttpDestination,
    remote: SocketAddr,
    resolve_ms: u32,
    headers_ms: u32,
}

/// One validated but unresolved HTTP hop. It is sealed behind exact hostname-resolution
/// authority before any DNS lookup can occur.
pub struct PreparedHttpResolution {
    prepared: Prepared,
    follow_redirects: bool,
    redirects: Vec<HttpRedirectHop>,
    resolve_total_ms: u32,
    entry: HttpHistoryEntry,
    started: Instant,
}

impl std::fmt::Debug for PreparedHttpResolution {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedHttpResolution")
            .field("host", &self.prepared.host())
            .field("redirect_hop", &self.redirects.len())
            .finish_non_exhaustive()
    }
}

impl PreparedHttpResolution {
    pub fn host(&self) -> String {
        self.prepared.host()
    }

    pub fn redirect_hop(&self) -> u8 {
        u8::try_from(self.redirects.len()).unwrap_or(u8::MAX)
    }
}

/// One DNS-pinned HTTP hop sealed behind a second exact send approval. The full URL, headers and
/// body remain in this native object; permission review receives only its safe getters.
pub struct PreparedHttpEffect {
    prepared: Prepared,
    resolution: destination::Resolution,
    follow_redirects: bool,
    redirects: Vec<HttpRedirectHop>,
    resolve_total_ms: u32,
    entry: HttpHistoryEntry,
    started: Instant,
}

impl std::fmt::Debug for PreparedHttpEffect {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PreparedHttpEffect")
            .field("method", &self.prepared.method)
            .field("origin", &self.prepared.origin_url())
            .field("destination", &self.resolution.destination)
            .field("redirect_hop", &self.redirects.len())
            .field("body_bytes", &self.body_bytes())
            .finish_non_exhaustive()
    }
}

impl PreparedHttpEffect {
    pub fn method(&self) -> HttpMethod {
        self.prepared.method
    }

    pub fn origin(&self) -> String {
        self.prepared.origin_url()
    }

    pub fn destination(&self) -> HttpDestination {
        self.resolution.destination
    }

    pub fn redirect_hop(&self) -> u8 {
        u8::try_from(self.redirects.len()).unwrap_or(u8::MAX)
    }

    pub fn body_bytes(&self) -> u64 {
        self.prepared
            .body
            .as_ref()
            .map_or(0, |body| u64::try_from(body.len()).unwrap_or(u64::MAX))
    }
}

pub enum ApprovedHttpOutcome {
    Completed(Box<HttpResponseView>),
    Redirect(Box<PreparedHttpResolution>),
}

impl HttpSession {
    pub fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    fn with_resolver(resolver: destination::TrackedResolver) -> Self {
        Self {
            resolver,
            ..Self::default()
        }
    }

    /// This session's history, newest first.
    pub fn history(&self) -> Vec<HttpHistoryEntry> {
        self.history
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .cloned()
            .collect()
    }

    pub fn clear_history(&self) {
        self.history
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    fn is_confirmed(&self, host: &str, link_local: bool) -> bool {
        if link_local {
            return false;
        }
        self.confirmed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .contains(&(host.to_owned(), link_local))
    }

    fn mark_confirmed(&self, host: &str, link_local: bool) {
        if link_local {
            return;
        }
        self.confirmed
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert((host.to_owned(), link_local));
    }

    fn confirm_destination(
        &self,
        host: &str,
        destination: HttpDestination,
        gate: &dyn NetworkGate,
    ) -> Result<()> {
        let link_local = destination == HttpDestination::LinkLocal;
        if destination == HttpDestination::Loopback || self.is_confirmed(host, link_local) {
            return Ok(());
        }
        gate.confirm(host, destination).map_err(|code| {
            refused(
                if code == "confirmation_declined" {
                    "confirmation_declined"
                } else {
                    "confirmation_unavailable"
                },
                if code == "confirmation_declined" {
                    format!("The request to {host} wasn't sent: you didn't confirm it.")
                } else {
                    format!(
                        "The request to {host} wasn't sent: KalCode couldn't show its confirmation window."
                    )
                },
            )
        })?;
        self.mark_confirmed(host, link_local);
        Ok(())
    }

    /// Records `entry`, replacing the row it already has: every redirect hop of one request
    /// updates the same history entry (one id, one row).
    fn record(&self, entry: HttpHistoryEntry) {
        let mut history = self.history.lock().unwrap_or_else(PoisonError::into_inner);
        history.retain(|existing| existing.id != entry.id);
        history.push_front(entry);
        history.truncate(HISTORY_LIMIT);
    }

    /// Validates the first hop without resolving or contacting it. The returned object must be
    /// covered by exact one-time DNS authority before `resolve_approved` is called.
    pub fn prepare_resolution(&self, spec: &HttpRequestSpec) -> Result<PreparedHttpResolution> {
        let started = Instant::now();
        let prepared = prepare(spec)?;
        let (stored, redactions) = redact::redact_request(spec);
        Ok(PreparedHttpResolution {
            entry: HttpHistoryEntry {
                id: uuid::Uuid::now_v7().to_string(),
                at: kalcode_core::time::now_rfc3339(),
                method: spec.method,
                host: prepared.host(),
                destination: None,
                status: None,
                error_code: None,
                elapsed_ms: 0,
                request: stored,
                redactions,
            },
            prepared,
            follow_redirects: spec.follow_redirects,
            redirects: Vec::new(),
            resolve_total_ms: 0,
            started,
        })
    }

    /// Resolves one previously authorized hostname and returns a pinned effect that still needs
    /// its own destination-bound send approval.
    pub fn resolve_approved(
        &self,
        mut pending: PreparedHttpResolution,
    ) -> Result<PreparedHttpEffect> {
        let resolution = match self
            .resolver
            .resolve(&pending.prepared.host(), pending.prepared.port())
        {
            Ok(resolution) => resolution,
            Err(error) => {
                pending.entry.error_code = Some(error.code.to_owned());
                pending.entry.elapsed_ms = crate::elapsed_ms(pending.started);
                self.record(pending.entry);
                return Err(error);
            }
        };
        Ok(PreparedHttpEffect {
            prepared: pending.prepared,
            resolution,
            follow_redirects: pending.follow_redirects,
            redirects: pending.redirects,
            resolve_total_ms: pending.resolve_total_ms,
            entry: pending.entry,
            started: pending.started,
        })
    }

    pub fn shutdown_checked(&self) -> Result<()> {
        self.resolver.shutdown_checked()
    }

    /// Executes exactly one already-approved pinned hop. A redirect is returned as a new sealed
    /// effect and cannot contact its destination until a fresh approval is claimed.
    pub fn execute_approved(
        &self,
        mut effect: PreparedHttpEffect,
        native_gate: &dyn NetworkGate,
    ) -> Result<ApprovedHttpOutcome> {
        let result = self.execute_approved_inner(&mut effect, native_gate);
        if let Err(error) = &result {
            effect.entry.error_code = Some(error.code.to_owned());
            effect.entry.elapsed_ms = crate::elapsed_ms(effect.started);
            self.record(effect.entry.clone());
        }
        result
    }

    fn execute_approved_inner(
        &self,
        effect: &mut PreparedHttpEffect,
        native_gate: &dyn NetworkGate,
    ) -> Result<ApprovedHttpOutcome> {
        let host = effect.prepared.host();
        self.confirm_destination(&host, effect.resolution.destination, native_gate)?;
        let hop = self.send_resolved_hop(&effect.prepared, &effect.resolution)?;
        effect.resolve_total_ms = effect
            .resolve_total_ms
            .saturating_add(effect.resolution.elapsed_ms);
        let redirect = effect.follow_redirects
            && matches!(hop.status, 301 | 302 | 303 | 307 | 308)
            && hop.location.is_some();
        if redirect {
            if effect.redirects.len() >= MAX_REDIRECTS {
                return Err(KalError::new(
                    ErrorCategory::Network,
                    "too_many_redirects",
                    "The server redirected more than 5 times.",
                ));
            }
            let location = hop.location.clone().unwrap_or_default();
            let next = effect.prepared.url.join(&location).map_err(|_| {
                KalError::new(
                    ErrorCategory::Network,
                    "redirect_invalid",
                    "The server redirected to an address that isn't valid.",
                )
            })?;
            if !matches!(next.scheme(), "http" | "https")
                || !next.username().is_empty()
                || next.password().is_some()
            {
                return Err(KalError::new(
                    ErrorCategory::Network,
                    "redirect_refused",
                    "The server redirected to an address the API Inspector doesn't follow.",
                ));
            }
            let same_origin = next.origin() == effect.prepared.url.origin();
            effect.redirects.push(HttpRedirectHop {
                status: hop.status,
                host: match next.host() {
                    Some(url::Host::Ipv6(v6)) => format!("[{v6}]"),
                    Some(host) => host.to_string(),
                    None => String::new(),
                },
            });
            let to_get = hop.status == 303
                || (matches!(hop.status, 301 | 302) && effect.prepared.method == HttpMethod::Post);
            if to_get {
                effect.prepared.method = HttpMethod::Get;
                effect.prepared.body = None;
                effect
                    .prepared
                    .headers
                    .retain(|(name, _)| !name.eq_ignore_ascii_case("content-type"));
            }
            if !same_origin {
                effect
                    .prepared
                    .headers
                    .retain(|(name, _)| !redact::is_sensitive_header(name));
            }
            effect.prepared.url = next;
            effect.entry.status = Some(hop.status);
            effect.entry.destination = Some(hop.destination);
            effect.entry.elapsed_ms = crate::elapsed_ms(effect.started);
            self.record(effect.entry.clone());
            return Ok(ApprovedHttpOutcome::Redirect(Box::new(
                PreparedHttpResolution {
                    prepared: effect.prepared.clone(),
                    follow_redirects: effect.follow_redirects,
                    redirects: effect.redirects.clone(),
                    resolve_total_ms: effect.resolve_total_ms,
                    entry: effect.entry.clone(),
                    started: effect.started,
                },
            )));
        }
        let mut response = view(
            hop,
            &effect.prepared,
            effect.redirects.clone(),
            effect.resolve_total_ms,
            crate::elapsed_ms(effect.started),
        );
        response.history_id.clone_from(&effect.entry.id);
        effect.entry.status = Some(response.status);
        effect.entry.destination = Some(response.destination);
        effect.entry.elapsed_ms = crate::elapsed_ms(effect.started);
        self.record(effect.entry.clone());
        Ok(ApprovedHttpOutcome::Completed(Box::new(response)))
    }

    /// Sends `spec` through `gate` (steps 1–5 for the request and every redirect it follows).
    /// The redacted request is recorded in the history whatever happens.
    pub fn send(&self, spec: &HttpRequestSpec, gate: &dyn NetworkGate) -> Result<HttpResponseView> {
        let started = Instant::now();
        let history_id = uuid::Uuid::now_v7().to_string();
        let (stored, redactions) = redact::redact_request(spec);
        let mut entry = HttpHistoryEntry {
            id: history_id.clone(),
            at: kalcode_core::time::now_rfc3339(),
            method: spec.method,
            host: String::new(),
            destination: None,
            status: None,
            error_code: None,
            elapsed_ms: 0,
            request: stored,
            redactions,
        };
        let result = self.send_hops(spec, gate, &mut entry, started);
        entry.elapsed_ms = crate::elapsed_ms(started);
        match &result {
            Ok(view) => {
                entry.status = Some(view.status);
                entry.destination = Some(view.destination);
                tracing::info!(
                    event = "utility.request_sent",
                    method = spec.method.as_str(),
                    host = %entry.host,
                    status = view.status
                );
            }
            Err(error) => {
                entry.error_code = Some(error.code.to_owned());
                tracing::info!(
                    event = "utility.request_not_completed",
                    method = spec.method.as_str(),
                    host = %entry.host,
                    code = error.code
                );
            }
        }
        self.record(entry);
        result.map(|mut view| {
            view.history_id = history_id;
            view
        })
    }

    fn send_hops(
        &self,
        spec: &HttpRequestSpec,
        gate: &dyn NetworkGate,
        entry: &mut HttpHistoryEntry,
        started: Instant,
    ) -> Result<HttpResponseView> {
        let mut prepared = prepare(spec)?;
        entry.host = prepared.host();
        let mut redirects = Vec::new();
        let mut resolve_total = 0u32;
        loop {
            let hop = self.hop(&prepared, gate)?;
            resolve_total = resolve_total.saturating_add(hop.resolve_ms);
            let redirect = spec.follow_redirects
                && matches!(hop.status, 301 | 302 | 303 | 307 | 308)
                && hop.location.is_some();
            if !redirect || redirects.len() >= MAX_REDIRECTS {
                if redirect {
                    return Err(KalError::new(
                        ErrorCategory::Network,
                        "too_many_redirects",
                        "The server redirected more than 5 times.",
                    ));
                }
                return Ok(view(
                    hop,
                    &prepared,
                    redirects,
                    resolve_total,
                    crate::elapsed_ms(started),
                ));
            }
            let location = hop.location.clone().unwrap_or_default();
            let next = prepared.url.join(&location).map_err(|_| {
                KalError::new(
                    ErrorCategory::Network,
                    "redirect_invalid",
                    "The server redirected to an address that isn't valid.",
                )
            })?;
            if !matches!(next.scheme(), "http" | "https")
                || !next.username().is_empty()
                || next.password().is_some()
            {
                return Err(KalError::new(
                    ErrorCategory::Network,
                    "redirect_refused",
                    "The server redirected to an address the API Inspector doesn't follow.",
                ));
            }
            let same_origin = next.origin() == prepared.url.origin();
            redirects.push(HttpRedirectHop {
                status: hop.status,
                host: match next.host() {
                    Some(url::Host::Ipv6(v6)) => format!("[{v6}]"),
                    Some(h) => h.to_string(),
                    None => String::new(),
                },
            });
            // Browsers' rules: 303 (and 301/302 after POST) become GET without a body; 307/308
            // keep the method and body. Credentials never follow to another origin.
            let to_get = hop.status == 303
                || (matches!(hop.status, 301 | 302) && prepared.method == HttpMethod::Post);
            if to_get {
                prepared.method = HttpMethod::Get;
                prepared.body = None;
                prepared
                    .headers
                    .retain(|(n, _)| !n.eq_ignore_ascii_case("content-type"));
            }
            if !same_origin {
                prepared
                    .headers
                    .retain(|(n, _)| !redact::is_sensitive_header(n));
            }
            prepared.url = next;
        }
    }

    /// Steps 2–5 for one hop.
    fn hop(&self, prepared: &Prepared, gate: &dyn NetworkGate) -> Result<Hop> {
        let host = prepared.host();
        match gate.evaluate(&host, &prepared.origin_url()) {
            GateVerdict::Deny { reason } => {
                return Err(refused(
                    "blocked_by_policy",
                    format!("Your permission settings block requests to {host}. {reason}"),
                ));
            }
            GateVerdict::Allow | GateVerdict::Ask => {}
        }
        let resolution = self.resolver.resolve(&host, prepared.port())?;
        self.confirm_destination(&host, resolution.destination, gate)?;
        self.send_resolved_hop(prepared, &resolution)
    }

    fn send_resolved_hop(
        &self,
        prepared: &Prepared,
        resolution: &destination::Resolution,
    ) -> Result<Hop> {
        let remote = resolution.addrs[0];
        let agent = agent(resolution.addrs.clone(), prepared.timeout);
        let mut builder = http::Request::builder()
            .method(prepared.method.as_str())
            .uri(prepared.url.as_str());
        for (name, value) in &prepared.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        let sent = Instant::now();
        let response = match &prepared.body {
            Some(body) => {
                let request = builder.body(body.clone()).map_err(|_| {
                    invalid("request_invalid", "KalCode couldn't build that request.")
                })?;
                agent.run(request)
            }
            None => {
                let request = builder.body(()).map_err(|_| {
                    invalid("request_invalid", "KalCode couldn't build that request.")
                })?;
                agent.run(request)
            }
        };
        let mut response = response.map_err(|e| network_error(&e))?;
        let headers_ms = crate::elapsed_ms(sent);
        let status = response.status();
        let headers: Vec<HttpHeader> = response
            .headers()
            .iter()
            .map(|(name, value)| HttpHeader {
                name: name.as_str().to_owned(),
                value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
                sensitive: redact::is_sensitive_header(name.as_str()),
            })
            .collect();
        let location = response
            .headers()
            .get(http::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let mut body = Vec::new();
        let mut truncated = false;
        if prepared.method != HttpMethod::Head {
            let mut reader = response
                .body_mut()
                .as_reader()
                .take(MAX_RESPONSE_BYTES as u64 + 1);
            reader.read_to_end(&mut body).map_err(|e| {
                if e.kind() == std::io::ErrorKind::TimedOut {
                    KalError::new(
                        ErrorCategory::Network,
                        "http_timeout",
                        "The response body took longer than the timeout.",
                    )
                } else {
                    KalError::new(
                        ErrorCategory::Network,
                        "body_read_failed",
                        "The connection closed while the response body was being read.",
                    )
                }
            })?;
            if body.len() > MAX_RESPONSE_BYTES {
                body.truncate(MAX_RESPONSE_BYTES);
                truncated = true;
                // A cap inside a multi-byte character must not make a text body look binary.
                if let Err(error) = std::str::from_utf8(&body)
                    && error.error_len().is_none()
                {
                    body.truncate(error.valid_up_to());
                }
            }
        }
        Ok(Hop {
            status: status.as_u16(),
            reason: status.canonical_reason().unwrap_or("").to_owned(),
            headers,
            location,
            body,
            truncated,
            destination: resolution.destination,
            remote,
            resolve_ms: resolution.elapsed_ms,
            headers_ms,
        })
    }
}

fn view(
    hop: Hop,
    prepared: &Prepared,
    redirects: Vec<HttpRedirectHop>,
    resolve_ms: u32,
    total_ms: u32,
) -> HttpResponseView {
    let content_type = hop
        .headers
        .iter()
        .find(|h| h.name.eq_ignore_ascii_case("content-type"))
        .map(|h| h.value.clone());
    let bytes = hop.body.len() as u64;
    let (body, body_kind) = describe_body(hop.body, content_type.as_deref());
    HttpResponseView {
        status: hop.status,
        reason: hop.reason,
        headers: hop.headers,
        body,
        body_kind,
        content_type,
        bytes,
        truncated: hop.truncated,
        timing: HttpTiming {
            resolve_ms,
            headers_ms: hop.headers_ms,
            total_ms,
        },
        url: prepared.url.to_string(),
        redirects,
        destination: hop.destination,
        remote_address: hop.remote.to_string(),
        history_id: String::new(),
    }
}

/// Text (JSON when it parses or says so), or a hex preview of a binary body.
fn describe_body(body: Vec<u8>, content_type: Option<&str>) -> (String, HttpBodyKind) {
    if body.is_empty() {
        return (String::new(), HttpBodyKind::Empty);
    }
    match String::from_utf8(body) {
        Ok(text) => {
            let json_type = content_type.is_some_and(|t| {
                let t = t.to_ascii_lowercase();
                t.contains("json")
            });
            let kind = if json_type || serde_json::from_str::<serde_json::Value>(&text).is_ok() {
                HttpBodyKind::Json
            } else {
                HttpBodyKind::Text
            };
            (text, kind)
        }
        Err(error) => {
            let bytes = error.into_bytes();
            let preview: Vec<String> = bytes
                .iter()
                .take(BINARY_PREVIEW)
                .map(|b| format!("{b:02x}"))
                .collect();
            (
                preview
                    .chunks(16)
                    .map(|c| c.join(" "))
                    .collect::<Vec<_>>()
                    .join("\n"),
                HttpBodyKind::Binary,
            )
        }
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
#[path = "history_tests.rs"]
mod history_tests;
