use crate::wire::RejectReason;

/// Errors from the Remote transport, handshake and persistence layers.
///
/// Operation failures that travel back to the device are [`crate::wire::RemoteError`], not this.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("i/o failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("noise failed: {0}")]
    Noise(#[from] snow::Error),
    #[error("the handshake did not finish within 10 s")]
    HandshakeTimeout,
    #[error("the workstation rejected this device: {0}")]
    Rejected(RejectReason),
    #[error("the handshake was invalid: {0}")]
    BadHandshake(String),
    #[error("a message of {0} bytes exceeds the size limit")]
    MessageTooLarge(usize),
    #[error("the peer stopped reading")]
    PeerStalled,
    #[error("a message was malformed: {0}")]
    Malformed(String),
    #[error("the connection closed")]
    Closed,
    #[error("invalid key: {0}")]
    InvalidKey(String),
    #[error("the system random generator failed: {0}")]
    Random(String),
}

impl From<serde_json::Error> for Error {
    fn from(error: serde_json::Error) -> Self {
        Self::Malformed(error.to_string())
    }
}
