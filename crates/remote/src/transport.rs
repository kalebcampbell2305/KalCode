//! Wire framing (§3).
//!
//! Every wire frame is a 2-byte big-endian length followed by one Noise message (max 65535
//! bytes). After the handshake, the decrypted plaintexts of consecutive frames form one byte
//! stream of application messages: a 4-byte big-endian length followed by UTF-8 JSON (max
//! 8 MiB). A sender splits a message across as many frames as needed, each carrying at most
//! [`MAX_FRAME_PLAINTEXT`] plaintext bytes.

use std::io::ErrorKind;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use serde::de::DeserializeOwned;
use snow::{HandshakeState, TransportState};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};

use crate::Error;
use crate::noise::TAG_LEN;

/// Largest Noise message a frame can carry.
pub const MAX_NOISE_MESSAGE: usize = 65535;

/// Largest plaintext a transport frame carries (65535 minus the 16-byte AEAD tag).
pub const MAX_FRAME_PLAINTEXT: usize = MAX_NOISE_MESSAGE - TAG_LEN;

/// Largest application message (JSON body, without its 4-byte length prefix).
pub const MAX_APP_MESSAGE: usize = 8 * 1024 * 1024;

/// Reads one wire frame into `buf`. A clean end of stream before a frame is [`Error::Closed`].
pub async fn read_frame<R: AsyncRead + Unpin>(io: &mut R, buf: &mut Vec<u8>) -> Result<(), Error> {
    let mut len = [0u8; 2];
    io.read_exact(&mut len).await.map_err(eof_is_closed)?;
    buf.clear();
    buf.resize(usize::from(u16::from_be_bytes(len)), 0);
    io.read_exact(buf).await.map_err(eof_is_closed)?;
    Ok(())
}

/// Writes one wire frame (length prefix and message in a single write) and flushes.
pub async fn write_frame<W: AsyncWrite + Unpin>(io: &mut W, message: &[u8]) -> Result<(), Error> {
    let len = u16::try_from(message.len()).map_err(|_| Error::MessageTooLarge(message.len()))?;
    let mut frame = Vec::with_capacity(2 + message.len());
    frame.extend_from_slice(&len.to_be_bytes());
    frame.extend_from_slice(message);
    io.write_all(&frame).await?;
    io.flush().await?;
    Ok(())
}

/// Writes the next handshake message carrying `payload`; returns the Noise message bytes.
pub async fn write_handshake<W: AsyncWrite + Unpin>(
    io: &mut W,
    state: &mut HandshakeState,
    payload: &[u8],
) -> Result<Vec<u8>, Error> {
    let mut message = vec![0u8; MAX_NOISE_MESSAGE];
    let len = state.write_message(payload, &mut message)?;
    message.truncate(len);
    write_frame(io, &message).await?;
    Ok(message)
}

/// Reads the next handshake message; returns its decrypted payload.
pub async fn read_handshake<R: AsyncRead + Unpin>(
    io: &mut R,
    state: &mut HandshakeState,
) -> Result<Vec<u8>, Error> {
    let mut frame = Vec::new();
    read_frame(io, &mut frame).await?;
    let mut payload = vec![0u8; MAX_NOISE_MESSAGE];
    let len = state.read_message(&frame, &mut payload)?;
    payload.truncate(len);
    Ok(payload)
}

/// Splits a stream whose handshake finished into its encrypted reader and writer halves.
pub fn split<S: AsyncRead + AsyncWrite>(
    stream: S,
    transport: TransportState,
) -> (NoiseReader<ReadHalf<S>>, NoiseWriter<WriteHalf<S>>) {
    let (read, write) = tokio::io::split(stream);
    let transport = Arc::new(Mutex::new(transport));
    (
        NoiseReader {
            io: read,
            transport: Arc::clone(&transport),
            frame: Vec::new(),
            plain: Vec::new(),
        },
        NoiseWriter {
            io: write,
            transport,
        },
    )
}

// Each direction has its own cipher state; the lock only serializes the in-memory
// encrypt/decrypt calls on snow's combined state, never I/O.
fn lock(transport: &Mutex<TransportState>) -> MutexGuard<'_, TransportState> {
    transport
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The receiving half: decrypts frames and reassembles application messages.
pub struct NoiseReader<R> {
    io: R,
    transport: Arc<Mutex<TransportState>>,
    frame: Vec<u8>,
    plain: Vec<u8>,
}

impl<R: AsyncRead + Unpin> NoiseReader<R> {
    /// The next application message's JSON bytes. Any decryption failure (tampering, a gap or
    /// a repeated nonce) is fatal: the caller must drop the connection.
    pub async fn recv_bytes(&mut self) -> Result<Vec<u8>, Error> {
        let mut scratch = Vec::new();
        loop {
            if let Some(message) = self.take_message()? {
                return Ok(message);
            }
            read_frame(&mut self.io, &mut self.frame).await?;
            scratch.resize(self.frame.len(), 0);
            let len = lock(&self.transport).read_message(&self.frame, &mut scratch)?;
            self.plain.extend_from_slice(&scratch[..len]);
        }
    }

    /// The next application message, parsed.
    pub async fn recv<T: DeserializeOwned>(&mut self) -> Result<T, Error> {
        let bytes = self.recv_bytes().await?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn take_message(&mut self) -> Result<Option<Vec<u8>>, Error> {
        let Some(prefix) = self.plain.first_chunk::<4>() else {
            return Ok(None);
        };
        let len = u32::from_be_bytes(*prefix) as usize;
        if len > MAX_APP_MESSAGE {
            return Err(Error::MessageTooLarge(len));
        }
        if self.plain.len() < 4 + len {
            return Ok(None);
        }
        let message = self.plain[4..4 + len].to_vec();
        self.plain.drain(..4 + len);
        Ok(Some(message))
    }
}

/// The sending half: frames, splits and encrypts application messages.
pub struct NoiseWriter<W> {
    io: W,
    transport: Arc<Mutex<TransportState>>,
}

impl<W: AsyncWrite + Unpin> NoiseWriter<W> {
    /// Sends one application message (JSON bytes, without the length prefix).
    pub async fn send_bytes(&mut self, json: &[u8]) -> Result<(), Error> {
        if json.len() > MAX_APP_MESSAGE {
            return Err(Error::MessageTooLarge(json.len()));
        }
        let mut plain = Vec::with_capacity(4 + json.len());
        plain.extend_from_slice(&(json.len() as u32).to_be_bytes());
        plain.extend_from_slice(json);
        let mut wire = Vec::with_capacity(
            plain.len() + (plain.len() / MAX_FRAME_PLAINTEXT + 1) * (2 + TAG_LEN),
        );
        let mut message = vec![0u8; MAX_NOISE_MESSAGE];
        {
            let mut transport = lock(&self.transport);
            for chunk in plain.chunks(MAX_FRAME_PLAINTEXT) {
                let len = transport.write_message(chunk, &mut message)?;
                // len <= MAX_NOISE_MESSAGE because chunk <= MAX_FRAME_PLAINTEXT.
                wire.extend_from_slice(&(len as u16).to_be_bytes());
                wire.extend_from_slice(&message[..len]);
            }
        }
        self.io.write_all(&wire).await.map_err(eof_is_closed)?;
        self.io.flush().await.map_err(eof_is_closed)?;
        Ok(())
    }

    /// Serializes and sends one application message.
    pub async fn send<T: Serialize + ?Sized>(&mut self, message: &T) -> Result<(), Error> {
        let json = serde_json::to_vec(message)?;
        self.send_bytes(&json).await
    }

    /// Flushes and shuts down the write direction.
    pub async fn shutdown(&mut self) -> Result<(), Error> {
        self.io.shutdown().await?;
        Ok(())
    }
}

fn eof_is_closed(error: std::io::Error) -> Error {
    match error.kind() {
        ErrorKind::UnexpectedEof
        | ErrorKind::ConnectionReset
        | ErrorKind::ConnectionAborted
        | ErrorKind::BrokenPipe => Error::Closed,
        _ => Error::Io(error),
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, clippy::unwrap_used)]
    use super::*;
    use crate::noise::{StaticKeypair, initiator, responder};

    /// Runs a raw IK handshake over a duplex pipe and returns both encrypted halves.
    async fn pair() -> (
        (
            NoiseReader<ReadHalf<tokio::io::DuplexStream>>,
            NoiseWriter<WriteHalf<tokio::io::DuplexStream>>,
        ),
        (
            NoiseReader<ReadHalf<tokio::io::DuplexStream>>,
            NoiseWriter<WriteHalf<tokio::io::DuplexStream>>,
        ),
    ) {
        let host = StaticKeypair::generate().unwrap();
        let device = StaticKeypair::generate().unwrap();
        let (mut a, mut b) = tokio::io::duplex(1 << 20);
        let mut i = initiator(&device, host.public()).unwrap();
        let mut r = responder(&host).unwrap();
        write_handshake(&mut a, &mut i, b"one").await.unwrap();
        assert_eq!(read_handshake(&mut b, &mut r).await.unwrap(), b"one");
        write_handshake(&mut b, &mut r, b"two").await.unwrap();
        assert_eq!(read_handshake(&mut a, &mut i).await.unwrap(), b"two");
        (
            split(a, i.into_transport_mode().unwrap()),
            split(b, r.into_transport_mode().unwrap()),
        )
    }

    #[tokio::test]
    async fn round_trips_small_and_split_messages() {
        let ((mut dev_r, mut dev_w), (mut host_r, mut host_w)) = pair().await;
        let big = vec![b'x'; MAX_FRAME_PLAINTEXT + 10];
        let huge = vec![b'y'; 1024 * 1024];
        let host = tokio::spawn(async move {
            for _ in 0..3 {
                let m = host_r.recv_bytes().await.unwrap();
                host_w.send_bytes(&m).await.unwrap();
            }
        });
        for message in [b"{}".to_vec(), big, huge] {
            dev_w.send_bytes(&message).await.unwrap();
            assert_eq!(dev_r.recv_bytes().await.unwrap(), message);
        }
        host.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_oversized_messages() {
        let ((_, mut dev_w), _) = pair().await;
        let too_big = vec![b'z'; MAX_APP_MESSAGE + 1];
        assert!(matches!(
            dev_w.send_bytes(&too_big).await,
            Err(Error::MessageTooLarge(_))
        ));
    }

    #[tokio::test]
    async fn tampered_frame_is_fatal() {
        let host = StaticKeypair::generate().unwrap();
        let device = StaticKeypair::generate().unwrap();
        let (mut a, mut b) = tokio::io::duplex(1 << 16);
        let mut i = initiator(&device, host.public()).unwrap();
        let mut r = responder(&host).unwrap();
        write_handshake(&mut a, &mut i, b"").await.unwrap();
        read_handshake(&mut b, &mut r).await.unwrap();
        write_handshake(&mut b, &mut r, b"").await.unwrap();
        read_handshake(&mut a, &mut i).await.unwrap();
        let mut i = i.into_transport_mode().unwrap();
        let mut message = vec![0u8; 64];
        let len = i.write_message(b"\0\0\0\x02{}", &mut message).unwrap();
        message[3] ^= 1;
        write_frame(&mut a, &message[..len]).await.unwrap();
        let (mut reader, _) = split(b, r.into_transport_mode().unwrap());
        assert!(matches!(reader.recv_bytes().await, Err(Error::Noise(_))));
    }
}
