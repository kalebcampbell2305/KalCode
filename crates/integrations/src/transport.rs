//! Public HTTPS only, DNS-pinned transport. No proxies, redirects, cookies or URL credentials.
use crate::{Error, Result};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::{
    net::{IpAddr, SocketAddr},
    time::Duration,
};
use url::Url;

const MAX_RESPONSE: usize = 1024 * 1024;

pub(crate) fn validate_endpoint(raw: &str) -> Result<Url> {
    let url =
        Url::parse(raw).map_err(|_| Error::Invalid("Enter a valid HTTPS endpoint.".into()))?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
        || url.port_or_known_default() != Some(443)
    {
        return Err(Error::Invalid("Use HTTPS on port 443 without credentials, query or fragment. Private systems require Secure MCP Tunnel.".into()));
    }
    if let Ok(ip) = url
        .host_str()
        .unwrap_or_default()
        .trim_matches(['[', ']'])
        .parse::<IpAddr>()
        && !public_ip(ip)
    {
        return Err(Error::Invalid(
            "Private addresses require Secure MCP Tunnel.".into(),
        ));
    }
    Ok(url)
}

pub(crate) fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let o = ip.octets();
            !(ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_unspecified()
                || ip.is_broadcast()
                || ip.is_documentation()
                || o[0] == 0
                || o[0] >= 240
                || (o[0] == 100 && (64..=127).contains(&o[1]))
                || (o[0] == 198 && (18..=19).contains(&o[1]))
                || (o[0] == 192 && (o[1] == 0 || (o[1] == 88 && o[2] == 99))))
        }
        // Restrict to global unicast; reject transition mechanisms and documentation ranges.
        IpAddr::V6(ip) => {
            let s = ip.segments();
            (s[0] & 0xe000) == 0x2000
                && !matches!(s[0], 0x2002 | 0x3ffe | 0x3fff)
                && !(s[0] == 0x2001 && (s[1] < 0x0200 || s[1] == 0x0db8))
        }
    }
}

pub(crate) struct Transport {
    client: Client,
    endpoint: Url,
    token: Option<kalcode_secure_store::SecretString>,
    authority: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
}
impl Transport {
    pub(crate) async fn new(
        endpoint: &str,
        token: Option<kalcode_secure_store::SecretString>,
    ) -> Result<Self> {
        let endpoint = validate_endpoint(endpoint)?;
        let host = endpoint
            .host_str()
            .ok_or_else(|| Error::Invalid("Missing host.".into()))?;
        let ips: Vec<SocketAddr> =
            tokio::time::timeout(Duration::from_secs(8), tokio::net::lookup_host((host, 443)))
                .await
                .map_err(|_| Error::Timeout)?
                .map_err(|_| Error::Offline)?
                .collect();
        if ips.is_empty() || ips.iter().any(|a| !public_ip(a.ip())) {
            return Err(Error::Invalid(
                "Endpoint resolved to a private or reserved network. Use Secure MCP Tunnel.".into(),
            ));
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(25))
            .connect_timeout(Duration::from_secs(8))
            .resolve_to_addrs(host, &ips)
            .build()
            .map_err(|_| Error::Offline)?;
        Ok(Self {
            client,
            endpoint,
            token,
            authority: std::sync::Arc::new(|| true),
        })
    }

    pub(crate) fn with_authority(
        mut self,
        authority: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        self.authority = authority;
        self
    }

    pub(crate) async fn request(
        &self,
        method: Method,
        url: Url,
        body: Option<&Value>,
        session: Option<&str>,
        rpc_id: Option<u64>,
    ) -> Result<(Value, Option<String>)> {
        if !(self.authority)() {
            return Err(Error::AccessDenied);
        }
        if url.origin() != self.endpoint.origin() {
            return Err(Error::Invalid("Tool endpoint changed origin.".into()));
        }
        let mut request = self
            .client
            .request(method, url)
            .header("Accept", "application/json, text/event-stream");
        if let Some(token) = &self.token {
            request = request.bearer_auth(token.expose_secret());
        }
        if let Some(session) = session {
            request = request.header("Mcp-Session-Id", session);
        }
        if rpc_id.is_some() || session.is_some() {
            request = request.header("MCP-Protocol-Version", "2025-03-26");
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        if !(self.authority)() {
            return Err(Error::AccessDenied);
        }
        let mut response = request.send().await.map_err(|e| {
            if e.is_timeout() {
                Error::Timeout
            } else {
                Error::Offline
            }
        })?;
        if !(self.authority)() {
            return Err(Error::AccessDenied);
        }
        if matches!(response.status().as_u16(), 401 | 403) {
            return Err(Error::Authentication);
        }
        if !response.status().is_success() {
            return Err(Error::RemoteStatus(response.status().as_u16()));
        }
        let session = response
            .headers()
            .get("Mcp-Session-Id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        if session.as_ref().is_some_and(|v| v.len() > 256) {
            return Err(Error::Protocol);
        }
        if response.status().as_u16() == 202 || response.status().as_u16() == 204 {
            return Ok((Value::Null, session));
        }
        if response
            .content_length()
            .is_some_and(|v| v > MAX_RESPONSE as u64)
        {
            return Err(Error::ResponseTooLarge);
        }
        let sse = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|s| s.starts_with("text/event-stream"));
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| {
            if e.is_timeout() {
                Error::Timeout
            } else {
                Error::Offline
            }
        })? {
            if !(self.authority)() {
                return Err(Error::AccessDenied);
            }
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err(Error::ResponseTooLarge);
            }
            bytes.extend_from_slice(&chunk);
            if sse && let Some(value) = parse_sse(&bytes, rpc_id)? {
                return Ok((value, session));
            }
        }
        let value = if sse {
            parse_sse(&bytes, rpc_id)?.ok_or(Error::Protocol)?
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({"text": String::from_utf8_lossy(&bytes)}))
        };
        Ok((value, session))
    }

    pub(crate) async fn rpc(
        &self,
        method: &str,
        params: Value,
        id: Option<u64>,
        session: Option<&str>,
    ) -> Result<(Value, Option<String>)> {
        let mut body = json!({"jsonrpc":"2.0","method":method,"params":params});
        if let Some(id) = id {
            body["id"] = json!(id);
        }
        let (value, session) = self
            .request(
                Method::POST,
                self.endpoint.clone(),
                Some(&body),
                session,
                id,
            )
            .await?;
        if let Some(id) = id {
            if value["jsonrpc"] != "2.0"
                || value["id"].as_u64() != Some(id)
                || value.get("error").is_some()
            {
                return Err(Error::Protocol);
            }
            return Ok((
                value.get("result").cloned().ok_or(Error::Protocol)?,
                session,
            ));
        }
        Ok((value, session))
    }

    pub(crate) async fn initialize(&self) -> Result<Option<String>> {
        let (result, session) = self.rpc("initialize", json!({"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"KalCode","version":"1"}}), Some(1), None).await?;
        if result["protocolVersion"] != "2025-03-26" || result.get("capabilities").is_none() {
            return Err(Error::Protocol);
        }
        self.rpc(
            "notifications/initialized",
            json!({}),
            None,
            session.as_deref(),
        )
        .await?;
        Ok(session)
    }

    pub(crate) fn endpoint(&self) -> &Url {
        &self.endpoint
    }

    /// OAuth token exchange. Raw error bodies (which may contain credentials) never leave here.
    pub(crate) async fn exchange_code(
        &self,
        client_id: &str,
        code: &str,
        redirect_uri: &str,
        verifier: &str,
    ) -> Result<kalcode_secure_store::SecretString> {
        if !(self.authority)() {
            return Err(Error::AccessDenied);
        }
        let mut response = self
            .client
            .post(self.endpoint.clone())
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", client_id),
                ("code", code),
                ("redirect_uri", redirect_uri),
                ("code_verifier", verifier),
            ])
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    Error::Timeout
                } else {
                    Error::Offline
                }
            })?;
        if !(self.authority)() {
            return Err(Error::AccessDenied);
        }
        if !response.status().is_success() {
            return Err(Error::Authentication);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| Error::Offline)? {
            if bytes.len() + chunk.len() > 64 * 1024 {
                return Err(Error::ResponseTooLarge);
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Authentication)?;
        if !value["token_type"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("bearer"))
        {
            return Err(Error::Authentication);
        }
        let token = value["access_token"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() < 16_384 && !s.chars().any(char::is_control))
            .ok_or(Error::Authentication)?;
        Ok(kalcode_secure_store::SecretString::new(token))
    }
}

fn parse_sse(bytes: &[u8], id: Option<u64>) -> Result<Option<Value>> {
    let text = String::from_utf8_lossy(bytes).replace("\r\n", "\n");
    // Only complete events are parsed, never a partial network chunk.
    for event in text.split_inclusive("\n\n").filter(|s| s.ends_with("\n\n")) {
        let data = event
            .lines()
            .filter_map(|l| l.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(&data).map_err(|_| Error::Protocol)?;
        if value.get("id").and_then(Value::as_u64) == id {
            return Ok(Some(value));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_private_reserved_and_url_credentials() {
        for ip in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.0.8",
            "198.18.0.1",
            "::1",
            "::ffff:127.0.0.1",
            "2002:7f00:1::",
            "2001:db8::1",
        ] {
            assert!(!public_ip(ip.parse().unwrap()), "{ip}");
        }
        for url in [
            "http://example.com",
            "https://a:b@example.com",
            "https://example.com?token=secret",
            "https://example.com:444",
            "https://127.0.0.1",
        ] {
            assert!(validate_endpoint(url).is_err());
        }
        assert!(validate_endpoint("https://api.githubcopilot.com/mcp/").is_ok());
    }
    #[test]
    fn sse_requires_complete_matching_response() {
        assert!(
            parse_sse(b"data: {\"id\":3,\"result\":{}}\n", Some(3))
                .unwrap()
                .is_none()
        );
        assert!(
            parse_sse(
                b"data: {\"id\":2}\n\ndata: {\"id\":3,\"result\":{}}\n\n",
                Some(3)
            )
            .unwrap()
            .is_some()
        );
    }

    fn mock_response(response: String) -> Transport {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let _ = socket.read(&mut buffer);
            socket.write_all(response.as_bytes()).unwrap();
        });
        Transport {
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(2))
                .build()
                .unwrap(),
            endpoint: Url::parse(&format!("http://{address}/mcp")).unwrap(),
            token: None,
            authority: std::sync::Arc::new(|| true),
        }
    }
    #[tokio::test]
    async fn rejects_redirects_and_large_responses_without_following_destination() {
        let transport=mock_response("HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data\r\nContent-Length: 0\r\n\r\n".into());
        assert!(matches!(
            transport
                .request(Method::GET, transport.endpoint.clone(), None, None, None)
                .await,
            Err(Error::RemoteStatus(302))
        ));
        let transport = mock_response("HTTP/1.1 200 OK\r\nContent-Length: 1048577\r\n\r\n".into());
        assert!(matches!(
            transport
                .request(Method::GET, transport.endpoint.clone(), None, None, None)
                .await,
            Err(Error::ResponseTooLarge)
        ));
    }
    #[tokio::test]
    async fn rpc_rejects_response_id_mismatch_and_hides_remote_error_body() {
        let body = r#"{"jsonrpc":"2.0","id":99,"error":{"message":"token=do-not-print"}}"#;
        let transport = mock_response(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        ));
        let error = transport
            .rpc("tools/list", json!({}), Some(2), None)
            .await
            .err()
            .unwrap();
        assert!(matches!(error, Error::Protocol));
        assert!(!error.to_string().contains("do-not-print"));
    }

    #[tokio::test]
    async fn streamable_http_initializes_discovers_and_calls_with_session() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let thread = std::thread::spawn(move || {
            for (expected, body) in [
                (
                    "initialize",
                    r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{}}}}"#,
                ),
                ("notifications/initialized", ""),
                (
                    "tools/list",
                    r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"status","inputSchema":{"type":"object"}}]}}"#,
                ),
                (
                    "tools/call",
                    r#"{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"healthy"}]}}"#,
                ),
            ] {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut buffer = [0u8; 2048];
                    let len = socket.read(&mut buffer).unwrap();
                    request.extend_from_slice(&buffer[..len]);
                    let text = String::from_utf8_lossy(&request);
                    if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                        let size: usize = headers
                            .lines()
                            .find_map(|s| {
                                s.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .and_then(|s| s.parse().ok())
                            })
                            .unwrap_or(0);
                        if body.len() >= size {
                            break;
                        }
                    }
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.contains(expected));
                if expected != "initialize" {
                    assert!(
                        request
                            .to_lowercase()
                            .contains("mcp-session-id: session-123")
                    );
                }
                let status = if body.is_empty() {
                    "202 Accepted"
                } else {
                    "200 OK"
                };
                socket.write_all(format!("HTTP/1.1 {status}\r\nConnection: close\r\nContent-Type: application/json\r\nMcp-Session-Id: session-123\r\nContent-Length: {}\r\n\r\n{body}",body.len()).as_bytes()).unwrap();
            }
        });
        let transport = Transport {
            client: Client::builder()
                .no_proxy()
                .timeout(Duration::from_secs(3))
                .build()
                .unwrap(),
            endpoint: Url::parse(&format!("http://{address}/mcp")).unwrap(),
            token: None,
            authority: std::sync::Arc::new(|| true),
        };
        let session = transport.initialize().await.unwrap();
        assert_eq!(session.as_deref(), Some("session-123"));
        let (list, _) = transport
            .rpc("tools/list", json!({}), Some(2), session.as_deref())
            .await
            .unwrap();
        assert_eq!(list["tools"][0]["name"], "status");
        let (result, _) = transport
            .rpc(
                "tools/call",
                json!({"name":"status","arguments":{}}),
                Some(3),
                session.as_deref(),
            )
            .await
            .unwrap();
        assert_eq!(result["content"][0]["text"], "healthy");
        thread.join().unwrap();
    }
}
