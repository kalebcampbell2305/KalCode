use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::*;
use crate::types::HttpQueryParam;

/// A scripted gate: a fixed verdict and confirmation answer, recording every call.
struct Gate {
    verdict: GateVerdict,
    confirm: std::result::Result<(), &'static str>,
    evaluated: Mutex<Vec<String>>,
    confirmed: Mutex<Vec<(String, HttpDestination)>>,
}

impl Gate {
    fn new(verdict: GateVerdict, confirm: std::result::Result<(), &'static str>) -> Self {
        Self {
            verdict,
            confirm,
            evaluated: Mutex::new(Vec::new()),
            confirmed: Mutex::new(Vec::new()),
        }
    }
}

impl NetworkGate for Gate {
    fn evaluate(&self, host: &str, origin_url: &str) -> GateVerdict {
        self.evaluated
            .lock()
            .expect("lock")
            .push(format!("{host} {origin_url}"));
        self.verdict.clone()
    }

    fn confirm(
        &self,
        host: &str,
        destination: HttpDestination,
    ) -> std::result::Result<(), &'static str> {
        self.confirmed
            .lock()
            .expect("lock")
            .push((host.to_owned(), destination));
        self.confirm
    }
}

/// Serves `responses` in order, one per connection, and records each request's head.
fn serve(responses: Vec<String>) -> (u16, std::sync::Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for response in responses {
            let Ok((mut stream, _)) = listener.accept() else {
                return;
            };
            let mut reader = BufReader::new(stream.try_clone().expect("clone"));
            let mut head = String::new();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(v) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = v.trim().parse().unwrap_or(0);
                }
                head.push_str(&line);
            }
            let mut body = vec![0u8; length];
            let _ = std::io::Read::read_exact(&mut reader, &mut body);
            head.push_str(&String::from_utf8_lossy(&body));
            log.lock().expect("lock").push(head);
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    (port, seen)
}

fn ok(body: &str, content_type: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn spec(method: HttpMethod, url: String) -> HttpRequestSpec {
    HttpRequestSpec {
        method,
        url,
        query: Vec::new(),
        headers: Vec::new(),
        body: None,
        timeout_ms: Some(5_000),
        follow_redirects: false,
    }
}

struct CountingResolver(Arc<AtomicUsize>);

impl destination::ResolveBackend for CountingResolver {
    fn resolve(&self, _host: &str, port: u16) -> std::io::Result<Vec<std::net::SocketAddr>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(vec![std::net::SocketAddr::new(
            std::net::IpAddr::V4(std::net::Ipv4Addr::LOCALHOST),
            port,
        )])
    }
}

struct PrivateResolver;

impl destination::ResolveBackend for PrivateResolver {
    fn resolve(&self, _host: &str, port: u16) -> std::io::Result<Vec<std::net::SocketAddr>> {
        Ok(vec![std::net::SocketAddr::new(
            std::net::IpAddr::V4(std::net::Ipv4Addr::new(10, 20, 30, 40)),
            port,
        )])
    }
}

#[test]
fn validation_and_sealing_do_not_resolve_before_dns_authority() {
    let calls = Arc::new(AtomicUsize::new(0));
    let resolver = destination::TrackedResolver::with_backend(
        Arc::new(CountingResolver(Arc::clone(&calls))),
        Duration::from_secs(1),
        1,
    );
    let session = HttpSession::with_resolver(resolver);
    let pending = session
        .prepare_resolution(&spec(
            HttpMethod::Get,
            "https://never-resolve.example/path".into(),
        ))
        .expect("validated and sealed");
    assert_eq!(calls.load(Ordering::SeqCst), 0, "DNS ran before authority");

    let _pinned = session
        .resolve_approved(pending)
        .expect("approved DNS stage resolves once");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[test]
fn approved_resolution_classifies_private_destination_for_fresh_send_authority() {
    let session = HttpSession::with_resolver(destination::TrackedResolver::with_backend(
        Arc::new(PrivateResolver),
        Duration::from_secs(1),
        1,
    ));
    let unresolved = session
        .prepare_resolution(&spec(
            HttpMethod::Get,
            "https://private.example/path".into(),
        ))
        .expect("unresolved stage");
    let pinned = session
        .resolve_approved(unresolved)
        .expect("approved resolution");
    assert_eq!(pinned.destination(), HttpDestination::Private);
    // The desktop seals this pinned object as UtilityHttp; no network operation happens here.
}

#[test]
fn a_loopback_request_is_sent_without_a_native_confirmation() {
    let (port, seen) = serve(vec![ok("{\"ok\":true}", "application/json")]);
    let gate = Gate::new(GateVerdict::Ask, Err("confirmation_declined"));
    let session = HttpSession::new();
    let mut request = spec(
        HttpMethod::Post,
        format!("http://127.0.0.1:{port}/api/items"),
    );
    request.headers.push(HttpHeader {
        name: "Content-Type".into(),
        value: "application/json".into(),
        sensitive: false,
    });
    request.body = Some("{\"name\":\"a\"}".into());
    request.query.push(HttpQueryParam {
        name: "page".into(),
        value: "2".into(),
        enabled: true,
    });
    let view = session.send(&request, &gate).expect("sent");
    assert_eq!(view.status, 200);
    assert_eq!(view.body_kind, HttpBodyKind::Json);
    assert_eq!(view.body, "{\"ok\":true}");
    assert_eq!(view.destination, HttpDestination::Loopback);
    assert!(gate.confirmed.lock().expect("lock").is_empty());
    assert_eq!(
        gate.evaluated.lock().expect("lock").as_slice(),
        [format!("127.0.0.1 http://127.0.0.1:{port}/")]
    );
    let head = seen.lock().expect("lock")[0].clone();
    assert!(
        head.starts_with("POST /api/items?page=2 HTTP/1.1"),
        "{head}"
    );
    assert!(head.contains("{\"name\":\"a\"}"), "{head}");
    // Nothing implicit: no cookies, no authorization.
    let lower = head.to_ascii_lowercase();
    assert!(!lower.contains("cookie:"), "{head}");
    assert!(!lower.contains("authorization:"), "{head}");
    let history = session.history();
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].status, Some(200));
    assert_eq!(history[0].host, "127.0.0.1");
}

#[test]
fn an_external_host_is_never_contacted_when_the_confirmation_is_declined() {
    let gate = Gate::new(GateVerdict::Ask, Err("confirmation_declined"));
    let session = HttpSession::new();
    let started = Instant::now();
    // TEST-NET-3 (RFC 5737): classified external, never routed.
    let error = session
        .send(&spec(HttpMethod::Get, "http://203.0.113.10/".into()), &gate)
        .expect_err("declined");
    assert_eq!(error.code, "confirmation_declined");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "no connection attempt"
    );
    assert_eq!(
        gate.confirmed.lock().expect("lock").as_slice(),
        [("203.0.113.10".to_owned(), HttpDestination::External)]
    );
    assert_eq!(
        session.history()[0].error_code.as_deref(),
        Some("confirmation_declined")
    );
}

#[test]
fn a_policy_deny_ends_the_request_before_any_confirmation() {
    let gate = Gate::new(
        GateVerdict::Deny {
            reason: "A never rule matched.".into(),
        },
        Ok(()),
    );
    let session = HttpSession::new();
    let error = session
        .send(&spec(HttpMethod::Get, "http://127.0.0.1:9/".into()), &gate)
        .expect_err("denied");
    assert_eq!(error.code, "blocked_by_policy");
    assert!(gate.confirmed.lock().expect("lock").is_empty());
}

#[test]
fn ordinary_hosts_cache_confirmation_but_link_local_never_does() {
    let gate = Gate::new(GateVerdict::Ask, Ok(()));
    let session = HttpSession::new();
    session
        .confirm_destination("example.test", HttpDestination::External, &gate)
        .expect("first ordinary confirmation");
    session
        .confirm_destination("example.test", HttpDestination::External, &gate)
        .expect("ordinary host is cached");
    session
        .confirm_destination("169.254.169.254", HttpDestination::LinkLocal, &gate)
        .expect("first link-local confirmation");
    session
        .confirm_destination("169.254.169.254", HttpDestination::LinkLocal, &gate)
        .expect("second link-local confirmation");
    assert_eq!(
        gate.confirmed.lock().expect("lock").as_slice(),
        [
            ("example.test".to_owned(), HttpDestination::External),
            ("169.254.169.254".to_owned(), HttpDestination::LinkLocal),
            ("169.254.169.254".to_owned(), HttpDestination::LinkLocal),
        ]
    );
}

#[test]
fn redirects_are_gated_per_hop_and_credentials_stay_on_their_origin() {
    let (second, seen_second) = serve(vec![ok("done", "text/plain")]);
    let (first, seen_first) = serve(vec![format!(
        "HTTP/1.1 302 Found\r\nLocation: http://localhost:{second}/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )]);
    let gate = Gate::new(GateVerdict::Ask, Ok(()));
    let session = HttpSession::new();
    let mut request = spec(HttpMethod::Get, format!("http://127.0.0.1:{first}/start"));
    request.follow_redirects = true;
    request.headers.push(HttpHeader {
        name: "Authorization".into(),
        value: "Bearer secret-value".into(),
        sensitive: true,
    });
    let view = session.send(&request, &gate).expect("followed");
    assert_eq!(view.status, 200);
    assert_eq!(view.body, "done");
    assert_eq!(view.redirects.len(), 1);
    assert_eq!(view.redirects[0].status, 302);
    assert_eq!(gate.evaluated.lock().expect("lock").len(), 2);
    let first_head = seen_first.lock().expect("lock")[0].to_ascii_lowercase();
    assert!(first_head.contains("authorization: bearer secret-value"));
    let second_head = seen_second.lock().expect("lock")[0].to_ascii_lowercase();
    assert!(
        !second_head.contains("authorization"),
        "another origin: {second_head}"
    );
    // The history never holds the header value.
    let json = serde_json::to_string(&session.history()).expect("json");
    assert!(!json.contains("secret-value"), "{json}");
}

#[test]
fn approved_effect_contacts_only_one_pinned_hop_before_fresh_authority() {
    let (second, seen_second) = serve(vec![ok("done", "text/plain")]);
    let (first, seen_first) = serve(vec![format!(
        "HTTP/1.1 302 Found\r\nLocation: http://localhost:{second}/next\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    )]);
    let gate = Gate::new(GateVerdict::Ask, Ok(()));
    let dns_calls = Arc::new(AtomicUsize::new(0));
    let session = HttpSession::with_resolver(destination::TrackedResolver::with_backend(
        Arc::new(CountingResolver(Arc::clone(&dns_calls))),
        Duration::from_secs(1),
        1,
    ));
    let mut request = spec(HttpMethod::Get, format!("http://127.0.0.1:{first}/start"));
    request.follow_redirects = true;
    request.headers.push(HttpHeader {
        name: "Authorization".into(),
        value: "Bearer secret-value".into(),
        sensitive: true,
    });

    let first_resolution = session
        .prepare_resolution(&request)
        .expect("first sealed DNS hop");
    assert_eq!(first_resolution.redirect_hop(), 0);
    let first_effect = session
        .resolve_approved(first_resolution)
        .expect("first approved resolution");
    assert_eq!(first_effect.redirect_hop(), 0);
    assert_eq!(first_effect.destination(), HttpDestination::Loopback);
    let second_resolution = match session
        .execute_approved(first_effect, &gate)
        .expect("first approved hop")
    {
        ApprovedHttpOutcome::Redirect(effect) => effect,
        ApprovedHttpOutcome::Completed(_) => panic!("redirect needs fresh authority"),
    };
    assert_eq!(seen_first.lock().expect("first").len(), 1);
    assert!(seen_second.lock().expect("second").is_empty());
    assert_eq!(second_resolution.redirect_hop(), 1);
    assert_eq!(
        dns_calls.load(Ordering::SeqCst),
        0,
        "a redirect must not resolve before its fresh DNS authority"
    );
    let second_effect = session
        .resolve_approved(*second_resolution)
        .expect("second approved resolution");
    assert_eq!(dns_calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        second_effect.origin(),
        format!("http://localhost:{second}/")
    );

    let response = match session
        .execute_approved(second_effect, &gate)
        .expect("second approved hop")
    {
        ApprovedHttpOutcome::Completed(response) => response,
        ApprovedHttpOutcome::Redirect(_) => panic!("unexpected third hop"),
    };
    assert_eq!(response.body, "done");
    let second_head = seen_second.lock().expect("second")[0].to_ascii_lowercase();
    assert!(!second_head.contains("authorization"), "{second_head}");
    let history = serde_json::to_string(&session.history()).expect("history");
    assert!(!history.contains("secret-value"), "{history}");
}

#[test]
fn redirects_are_not_followed_unless_asked() {
    let (port, _) = serve(vec![
        "HTTP/1.1 301 Moved\r\nLocation: http://127.0.0.1:1/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
    ]);
    let gate = Gate::new(GateVerdict::Ask, Ok(()));
    let view = HttpSession::new()
        .send(
            &spec(HttpMethod::Get, format!("http://127.0.0.1:{port}/")),
            &gate,
        )
        .expect("sent");
    assert_eq!(view.status, 301);
    assert!(view.redirects.is_empty());
}

#[test]
fn large_bodies_are_cut_at_the_cap() {
    let big = "x".repeat(MAX_RESPONSE_BYTES + 10);
    let (port, _) = serve(vec![ok(&big, "text/plain")]);
    let gate = Gate::new(GateVerdict::Ask, Ok(()));
    let view = HttpSession::new()
        .send(
            &spec(HttpMethod::Get, format!("http://127.0.0.1:{port}/")),
            &gate,
        )
        .expect("sent");
    assert!(view.truncated);
    assert_eq!(view.body.len(), MAX_RESPONSE_BYTES);
}

#[test]
fn a_large_text_body_cut_mid_character_stays_text() {
    // "é" is two bytes; the leading "a" puts the cap inside one.
    let big = format!("a{}", "é".repeat(MAX_RESPONSE_BYTES));
    let (port, _) = serve(vec![ok(&big, "text/plain; charset=utf-8")]);
    let gate = Gate::new(GateVerdict::Ask, Ok(()));
    let view = HttpSession::new()
        .send(
            &spec(HttpMethod::Get, format!("http://127.0.0.1:{port}/")),
            &gate,
        )
        .expect("sent");
    assert!(view.truncated);
    assert_eq!(view.body_kind, HttpBodyKind::Text);
    assert_eq!(view.body.len(), MAX_RESPONSE_BYTES - 1);
}

#[test]
fn binary_bodies_are_shown_as_hex_and_json_is_recognised() {
    let (hex, kind) = describe_body(vec![0, 1, 0xff], None);
    assert_eq!(kind, HttpBodyKind::Binary);
    assert_eq!(hex, "00 01 ff");
    assert_eq!(describe_body(Vec::new(), None).1, HttpBodyKind::Empty);
    assert_eq!(
        describe_body(b"[1,2]".to_vec(), Some("text/plain")).1,
        HttpBodyKind::Json
    );
    assert_eq!(describe_body(b"hello".to_vec(), None).1, HttpBodyKind::Text);
}

#[test]
fn nothing_is_listening_is_reported_plainly() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    let gate = Gate::new(GateVerdict::Ask, Ok(()));
    let error = HttpSession::new()
        .send(
            &spec(HttpMethod::Get, format!("http://127.0.0.1:{port}/")),
            &gate,
        )
        .expect_err("refused");
    assert!(
        matches!(error.code, "connection_refused" | "connection_failed"),
        "{}",
        error.code
    );
}

#[test]
fn requests_are_validated_before_anything_else() {
    let gate = Gate::new(GateVerdict::Ask, Ok(()));
    let session = HttpSession::new();
    let cases: Vec<(HttpRequestSpec, &str)> = vec![
        (spec(HttpMethod::Get, "".into()), "url_missing"),
        (
            spec(HttpMethod::Get, "ftp://example.com/".into()),
            "url_scheme",
        ),
        (
            spec(HttpMethod::Get, "file:///etc/passwd".into()),
            "url_scheme",
        ),
        (spec(HttpMethod::Get, "not a url".into()), "url_invalid"),
        (
            spec(HttpMethod::Get, "http://me:pw@127.0.0.1/".into()),
            "url_credentials",
        ),
        (
            {
                let mut s = spec(HttpMethod::Get, "http://127.0.0.1/".into());
                s.body = Some("x".into());
                s
            },
            "body_not_allowed",
        ),
        (
            {
                let mut s = spec(HttpMethod::Get, "http://127.0.0.1/".into());
                s.headers.push(HttpHeader {
                    name: "X-Evil".into(),
                    value: "a\r\nInjected: yes".into(),
                    sensitive: false,
                });
                s
            },
            "header_value_invalid",
        ),
        (
            {
                let mut s = spec(HttpMethod::Get, "http://127.0.0.1/".into());
                s.headers.push(HttpHeader {
                    name: "Bad Name".into(),
                    value: "x".into(),
                    sensitive: false,
                });
                s
            },
            "header_name_invalid",
        ),
        (
            {
                let mut s = spec(HttpMethod::Get, "http://127.0.0.1/".into());
                s.headers.push(HttpHeader {
                    name: "Transfer-Encoding".into(),
                    value: "chunked".into(),
                    sensitive: false,
                });
                s
            },
            "header_forbidden",
        ),
        (
            spec(HttpMethod::Get, "http://0.0.0.0:3000/".into()),
            "destination_refused",
        ),
    ];
    for (request, code) in cases {
        let error = session.send(&request, &gate).expect_err(code);
        assert_eq!(error.code, code, "{:?}", request.url);
    }
    assert!(gate.confirmed.lock().expect("lock").is_empty());
}

#[test]
fn timeouts_are_clamped() {
    let mut s = spec(HttpMethod::Get, "http://127.0.0.1/".into());
    s.timeout_ms = Some(10);
    assert_eq!(
        prepare(&s).expect("ok").timeout,
        Duration::from_millis(1_000)
    );
    s.timeout_ms = Some(10_000_000);
    assert_eq!(
        prepare(&s).expect("ok").timeout,
        Duration::from_millis(60_000)
    );
}

#[test]
fn history_is_capped_and_clearable() {
    let gate = Gate::new(
        GateVerdict::Deny {
            reason: String::new(),
        },
        Ok(()),
    );
    let session = HttpSession::new();
    let count = AtomicUsize::new(0);
    for _ in 0..(HISTORY_LIMIT + 5) {
        let _ = session.send(&spec(HttpMethod::Get, "http://127.0.0.1/".into()), &gate);
        count.fetch_add(1, Ordering::Relaxed);
    }
    assert_eq!(session.history().len(), HISTORY_LIMIT);
    session.clear_history();
    assert!(session.history().is_empty());
}
