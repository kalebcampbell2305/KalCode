use std::io::{Read, Write};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::DesktopGeneration;
use super::marker::JobId;

pub const PROTOCOL_VERSION: u16 = 1;
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelNonce([u8; 16]);

impl ChannelNonce {
    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        Self(bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope<T> {
    pub protocol_version: u16,
    pub nonce: ChannelNonce,
    pub desktop_generation: DesktopGeneration,
    pub sequence: u64,
    pub request_id: Uuid,
    pub body: T,
}

impl<T> Envelope<T> {
    pub const fn new(
        nonce: ChannelNonce,
        desktop_generation: DesktopGeneration,
        sequence: u64,
        request_id: Uuid,
        body: T,
    ) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            nonce,
            desktop_generation,
            sequence,
            request_id,
            body,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Request {
    Health,
    /// Takes ownership of a least-rights Job Object handle that the desktop duplicated directly
    /// into the helper process. The numeric value is meaningful only in this helper process.
    HoldJob {
        job: JobId,
        handle: u64,
    },
    /// Releases the helper's duplicate only after the helper independently observes zero active
    /// processes and the desktop has durably persisted CLEAN for this exact job.
    ReleaseJob {
        job: JobId,
    },
    Seal,
    Drain,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Response {
    Healthy,
    Accepted,
    Clean,
    Denied { code: String },
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("guardian frame declared {declared} bytes; maximum is {maximum}")]
    FrameTooLarge { declared: usize, maximum: usize },
    #[error("guardian protocol version {actual} is unsupported; expected {expected}")]
    VersionMismatch { expected: u16, actual: u16 },
    #[error("guardian channel authentication failed")]
    AuthenticationFailed,
    #[error("guardian desktop generation does not match")]
    DesktopGenerationMismatch,
    #[error("guardian sequence mismatch: expected {expected}, got {actual}")]
    SequenceMismatch { expected: u64, actual: u64 },
    #[error("guardian channel I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("guardian frame was malformed: {0}")]
    Malformed(#[from] serde_json::Error),
}

pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> Result<(), ProtocolError> {
    let payload = serde_json::to_vec(value)?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            declared: payload.len(),
            maximum: MAX_FRAME_BYTES,
        });
    }
    let length = u32::try_from(payload.len()).map_err(|_| ProtocolError::FrameTooLarge {
        declared: payload.len(),
        maximum: MAX_FRAME_BYTES,
    })?;
    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()?;
    Ok(())
}

pub fn read_frame<R: Read, T: DeserializeOwned>(reader: &mut R) -> Result<T, ProtocolError> {
    let mut length = [0_u8; 4];
    reader.read_exact(&mut length)?;
    let declared = u32::from_le_bytes(length) as usize;
    if declared > MAX_FRAME_BYTES {
        return Err(ProtocolError::FrameTooLarge {
            declared,
            maximum: MAX_FRAME_BYTES,
        });
    }
    let mut payload = vec![0_u8; declared];
    reader.read_exact(&mut payload)?;
    Ok(serde_json::from_slice(&payload)?)
}

#[derive(Debug)]
pub struct InboundGuard {
    nonce: ChannelNonce,
    desktop_generation: DesktopGeneration,
    next_sequence: u64,
}

impl InboundGuard {
    pub const fn new(nonce: ChannelNonce, desktop_generation: DesktopGeneration) -> Self {
        Self {
            nonce,
            desktop_generation,
            next_sequence: 1,
        }
    }

    pub fn accept<T>(&mut self, envelope: &Envelope<T>) -> Result<(), ProtocolError> {
        if envelope.protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolError::VersionMismatch {
                expected: PROTOCOL_VERSION,
                actual: envelope.protocol_version,
            });
        }
        if envelope.nonce != self.nonce {
            return Err(ProtocolError::AuthenticationFailed);
        }
        if envelope.desktop_generation != self.desktop_generation {
            return Err(ProtocolError::DesktopGenerationMismatch);
        }
        if envelope.sequence != self.next_sequence {
            return Err(ProtocolError::SequenceMismatch {
                expected: self.next_sequence,
                actual: envelope.sequence,
            });
        }
        self.next_sequence =
            self.next_sequence
                .checked_add(1)
                .ok_or(ProtocolError::SequenceMismatch {
                    expected: u64::MAX,
                    actual: envelope.sequence,
                })?;
        Ok(())
    }
}
