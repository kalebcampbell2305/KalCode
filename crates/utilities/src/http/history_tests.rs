//! One request is one history row, however many redirect hops update it.
use super::*;

fn entry(id: &str, status: Option<u16>) -> HttpHistoryEntry {
    HttpHistoryEntry {
        id: id.into(),
        at: "2026-10-06T00:00:00Z".into(),
        method: HttpMethod::Get,
        host: "example.com".into(),
        destination: None,
        status,
        error_code: None,
        elapsed_ms: 1,
        request: HttpRequestSpec {
            method: HttpMethod::Get,
            url: "https://example.com/".into(),
            query: Vec::new(),
            headers: Vec::new(),
            body: None,
            timeout_ms: None,
            follow_redirects: true,
        },
        redactions: 0,
    }
}

#[test]
fn a_redirected_request_keeps_one_history_row_with_its_final_status() {
    let session = HttpSession::new();
    session.record(entry("other", Some(204)));
    session.record(entry("request-1", Some(302)));
    session.record(entry("request-1", Some(200)));

    let history = session.history();
    assert_eq!(history.len(), 2);
    assert_eq!(history[0].id, "request-1");
    assert_eq!(history[0].status, Some(200));
    assert_eq!(history[1].id, "other");
}
