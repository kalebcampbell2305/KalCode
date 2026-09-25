//! The helper side of the protocol: connect, prove the key, send the record, verify the reply.
//! Blocking I/O; the helper enforces its overall deadline around [`exchange`].

use std::io::{Read, Write};
use std::time::{Duration, Instant};

use crate::key::{SessionKey, is_hex_of_len, random_bytes};
use crate::wire::{self, Hello, PROTOCOL_VERSION, Request, Response};
use crate::{BridgeError, Endpoint, HookRecord, HookReply};

/// A connected stream to the bridge.
pub trait Stream: Read + Write + Send {}
impl<T: Read + Write + Send> Stream for T {}

/// How long to wait between connection attempts while the endpoint is busy or not there yet.
const RETRY: Duration = Duration::from_millis(25);

/// Opens the endpoint, retrying while it is busy (all pipe instances in use) until `deadline`.
pub fn connect(endpoint: &Endpoint, deadline: Instant) -> Result<Box<dyn Stream>, BridgeError> {
    loop {
        match open(endpoint) {
            Ok(stream) => return Ok(stream),
            Err(error) if retryable(&error) && Instant::now() + RETRY < deadline => {
                std::thread::sleep(RETRY);
            }
            Err(error) => return Err(BridgeError::Unreachable(error.kind().to_string())),
        }
    }
}

#[cfg(windows)]
fn open(endpoint: &Endpoint) -> std::io::Result<Box<dyn Stream>> {
    use std::os::windows::fs::OpenOptionsExt;
    // SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION: the server may identify the helper but
    // never impersonate its token (docs/campaigns/Z7-W4-THREATS.md §4.3).
    const SQOS: u32 = 0x0010_0000 | 0x0001_0000;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .security_qos_flags(SQOS)
        .open(endpoint.path())?;
    Ok(Box::new(file))
}

#[cfg(unix)]
fn open(endpoint: &Endpoint) -> std::io::Result<Box<dyn Stream>> {
    Ok(Box::new(std::os::unix::net::UnixStream::connect(
        endpoint.path(),
    )?))
}

fn retryable(error: &std::io::Error) -> bool {
    // ERROR_PIPE_BUSY (231): every instance is serving a client; the server creates another.
    matches!(error.raw_os_error(), Some(231))
        || matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionRefused | std::io::ErrorKind::Interrupted
        )
}

/// One authenticated round trip over `stream`.
pub fn exchange_on(
    stream: &mut dyn Stream,
    session: &str,
    key: &SessionKey,
    record: &HookRecord,
) -> Result<HookReply, BridgeError> {
    let hello: Hello = wire::read_frame(stream)?;
    if hello.v != PROTOCOL_VERSION || !is_hex_of_len(&hello.nonce, 64) {
        return Err(BridgeError::BadReply);
    }
    let client_nonce = hex::encode(random_bytes::<32>()?);
    let body = serde_json::to_string(record).map_err(|e| BridgeError::Malformed(e.to_string()))?;
    let mac = wire::request_mac(key, &hello.nonce, &client_nonce, session, &body);
    wire::write_frame(
        stream,
        &Request {
            v: PROTOCOL_VERSION,
            session: session.to_owned(),
            nonce: client_nonce.clone(),
            body,
            mac,
        },
    )?;
    let response: Response = wire::read_frame(stream).map_err(|_| BridgeError::BadReply)?;
    if response.v != PROTOCOL_VERSION
        || !wire::verify_response(
            key,
            &hello.nonce,
            &client_nonce,
            &response.body,
            &response.mac,
        )
    {
        return Err(BridgeError::BadReply);
    }
    serde_json::from_str(&response.body).map_err(|_| BridgeError::BadReply)
}

/// Connects (until `connect_deadline`) and performs one round trip.
pub fn exchange(
    endpoint: &Endpoint,
    session: &str,
    key: &SessionKey,
    record: &HookRecord,
    connect_deadline: Instant,
) -> Result<HookReply, BridgeError> {
    let mut stream = connect(endpoint, connect_deadline)?;
    exchange_on(stream.as_mut(), session, key, record)
}
