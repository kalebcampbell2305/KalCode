//! OAuth token exchange against a loopback token endpoint.
use super::*;

/// A token endpoint that, like GitHub's, answers form-encoded unless the client asks for JSON.
fn content_negotiating_token_endpoint() -> (Transport, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0u8; 2048];
        while !request.windows(4).any(|w| w == b"\r\n\r\n") {
            let read = socket.read(&mut buffer).unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&buffer[..read]);
        }
        let head = String::from_utf8_lossy(&request).to_ascii_lowercase();
        let (content_type, body) = if head.contains("\r\naccept: application/json\r\n") {
            (
                "application/json",
                r#"{"access_token":"gho_exchanged","token_type":"bearer","scope":"repo"}"#,
            )
        } else {
            (
                "application/x-www-form-urlencoded",
                "access_token=gho_exchanged&scope=repo&token_type=bearer",
            )
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).unwrap();
    });
    let transport = Transport {
        client: Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap(),
        endpoint: Url::parse(&format!("http://{address}/login/oauth/access_token")).unwrap(),
        token: None,
        authority: std::sync::Arc::new(|| true),
    };
    (transport, server)
}

#[tokio::test]
async fn token_exchange_asks_for_json_so_github_style_endpoints_succeed() {
    let (transport, server) = content_negotiating_token_endpoint();
    let token = transport
        .exchange_code(
            "client",
            "code",
            "http://127.0.0.1:5555/callback",
            "verifier",
        )
        .await
        .expect("the token endpoint answers JSON when asked");
    assert_eq!(token.expose_secret(), "gho_exchanged");
    server.join().unwrap();
}
