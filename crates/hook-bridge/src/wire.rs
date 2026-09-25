//! The bridge protocol: one connection per hook call, three length-prefixed JSON frames.
//!
//! ```text
//! server → helper   Hello    { v, nonce: server nonce (64 hex) }
//! helper → server   Request  { v, session, nonce: client nonce, body, mac }
//! server → helper   Response { v, body, mac }
//! ```
//!
//! `mac` is HMAC-SHA256 under the session key over a domain tag and length-prefixed fields:
//! the request MAC covers both nonces, the session id and the body; the response MAC covers both
//! nonces and the body. The server's nonce is fresh per connection, so a recorded request never
//! verifies again (no replay), and a reply is bound to the exact request it answers. The key
//! itself is never sent. MACs are compared in constant time.

use std::io::{Read, Write};

use hmac::{Hmac, KeyInit, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::key::SessionKey;

pub const PROTOCOL_VERSION: u32 = 1;
/// Largest frame either side accepts.
pub const MAX_FRAME: usize = 256 * 1024;

const REQUEST_TAG: &[u8] = b"kalcode-hook/1 req";
const RESPONSE_TAG: &[u8] = b"kalcode-hook/1 resp";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    pub v: u32,
    pub nonce: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub v: u32,
    pub session: String,
    pub nonce: String,
    /// The serialized [`crate::HookRecord`], MACed as sent.
    pub body: String,
    pub mac: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Response {
    pub v: u32,
    /// The serialized [`crate::HookReply`], MACed as sent.
    pub body: String,
    pub mac: String,
}

type HmacSha256 = Hmac<Sha256>;

fn mac_over(key: &SessionKey, tag: &[u8], fields: &[&[u8]]) -> HmacSha256 {
    // A 32-byte key is always a valid HMAC key.
    let mut mac = <HmacSha256 as KeyInit>::new_from_slice(key.bytes())
        .unwrap_or_else(|_| unreachable!("HMAC accepts keys of any length"));
    mac.update(&(tag.len() as u32).to_be_bytes());
    mac.update(tag);
    for field in fields {
        mac.update(&(field.len() as u32).to_be_bytes());
        mac.update(field);
    }
    mac
}

fn request_fields<'a>(
    server_nonce: &'a str,
    client_nonce: &'a str,
    session: &'a str,
    body: &'a str,
) -> [&'a [u8]; 4] {
    [
        server_nonce.as_bytes(),
        client_nonce.as_bytes(),
        session.as_bytes(),
        body.as_bytes(),
    ]
}

/// The request MAC (hex).
pub fn request_mac(
    key: &SessionKey,
    server_nonce: &str,
    client_nonce: &str,
    session: &str,
    body: &str,
) -> String {
    let mac = mac_over(
        key,
        REQUEST_TAG,
        &request_fields(server_nonce, client_nonce, session, body),
    );
    hex::encode(mac.finalize().into_bytes())
}

/// Verifies a request MAC in constant time.
pub fn verify_request(
    key: &SessionKey,
    server_nonce: &str,
    client_nonce: &str,
    session: &str,
    body: &str,
    mac_hex: &str,
) -> bool {
    let Ok(given) = hex::decode(mac_hex) else {
        return false;
    };
    mac_over(
        key,
        REQUEST_TAG,
        &request_fields(server_nonce, client_nonce, session, body),
    )
    .verify_slice(&given)
    .is_ok()
}

/// The response MAC (hex).
pub fn response_mac(
    key: &SessionKey,
    server_nonce: &str,
    client_nonce: &str,
    body: &str,
) -> String {
    let mac = mac_over(
        key,
        RESPONSE_TAG,
        &[
            server_nonce.as_bytes(),
            client_nonce.as_bytes(),
            body.as_bytes(),
        ],
    );
    hex::encode(mac.finalize().into_bytes())
}

/// Verifies a response MAC in constant time.
pub fn verify_response(
    key: &SessionKey,
    server_nonce: &str,
    client_nonce: &str,
    body: &str,
    mac_hex: &str,
) -> bool {
    let Ok(given) = hex::decode(mac_hex) else {
        return false;
    };
    mac_over(
        key,
        RESPONSE_TAG,
        &[
            server_nonce.as_bytes(),
            client_nonce.as_bytes(),
            body.as_bytes(),
        ],
    )
    .verify_slice(&given)
    .is_ok()
}

/// Writes one frame: a 4-byte big-endian length, then the JSON.
pub fn write_frame<W: Write + ?Sized, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    if bytes.len() > MAX_FRAME {
        return Err(std::io::Error::other("frame too large"));
    }
    let mut out = Vec::with_capacity(4 + bytes.len());
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(&bytes);
    writer.write_all(&out)?;
    writer.flush()
}

/// Reads one frame of at most [`MAX_FRAME`] bytes.
pub fn read_frame<R: Read + ?Sized, T: for<'de> Deserialize<'de>>(
    reader: &mut R,
) -> std::io::Result<T> {
    let mut len = [0u8; 4];
    reader.read_exact(&mut len)?;
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "frame too large",
        ));
    }
    let mut bytes = vec![0u8; len];
    reader.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> SessionKey {
        SessionKey::from_bytes([byte; 32])
    }

    #[test]
    fn request_macs_bind_every_field() {
        let k = key(7);
        let mac = request_mac(&k, "sn", "cn", "session", "body");
        assert!(verify_request(&k, "sn", "cn", "session", "body", &mac));
        assert!(!verify_request(
            &key(8),
            "sn",
            "cn",
            "session",
            "body",
            &mac
        ));
        assert!(!verify_request(&k, "sn2", "cn", "session", "body", &mac));
        assert!(!verify_request(&k, "sn", "cn2", "session", "body", &mac));
        assert!(!verify_request(&k, "sn", "cn", "other", "body", &mac));
        assert!(!verify_request(&k, "sn", "cn", "session", "body2", &mac));
        assert!(!verify_request(&k, "sn", "cn", "session", "body", "zz"));
        assert!(!verify_request(&k, "sn", "cn", "session", "body", ""));
    }

    #[test]
    fn field_boundaries_are_unambiguous() {
        let k = key(1);
        // Moving bytes between adjacent fields changes the MAC.
        let a = request_mac(&k, "ab", "c", "s", "b");
        assert!(!verify_request(&k, "a", "bc", "s", "b", &a));
    }

    #[test]
    fn request_and_response_macs_are_domain_separated() {
        let k = key(3);
        let response = response_mac(&k, "sn", "cn", "body");
        assert!(verify_response(&k, "sn", "cn", "body", &response));
        // A request MAC can never pass as a response MAC and vice versa.
        let request = request_mac(&k, "sn", "cn", "", "body");
        assert!(!verify_response(&k, "sn", "cn", "body", &request));
        assert!(!verify_request(&k, "sn", "cn", "", "body", &response));
    }

    #[test]
    fn frames_round_trip_and_oversized_frames_are_refused() {
        let hello = Hello {
            v: PROTOCOL_VERSION,
            nonce: "n".into(),
        };
        let mut buffer = Vec::new();
        write_frame(&mut buffer, &hello).expect("write");
        let back: Hello = read_frame(&mut buffer.as_slice()).expect("read");
        assert_eq!(back, hello);

        let mut huge = (MAX_FRAME as u32 + 1).to_be_bytes().to_vec();
        huge.extend(std::iter::repeat_n(b' ', 16));
        let err = read_frame::<_, Hello>(&mut huge.as_slice()).expect_err("too large");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    #[test]
    fn unknown_fields_are_refused() {
        let text = br#"{"v":1,"nonce":"n","extra":true}"#;
        let mut frame = (text.len() as u32).to_be_bytes().to_vec();
        frame.extend_from_slice(text);
        assert!(read_frame::<_, Hello>(&mut frame.as_slice()).is_err());
    }
}
