//! The device (initiator) side, used by tests, the dev host and tooling. The mobile apps
//! implement the same steps natively.

use tokio::io::{AsyncRead, AsyncWrite, ReadHalf, WriteHalf};

use crate::noise::{self, KEY_LEN, StaticKeypair};
use crate::transport::{self, NoiseReader, NoiseWriter};
use crate::wire::{DeviceHello, DeviceMessage, HandshakeAccepted, HandshakeReply, HostMessage};
use crate::{Error, HANDSHAKE_TIMEOUT};

/// An open session from the device's point of view.
pub struct ClientConnection<S> {
    pub accepted: HandshakeAccepted,
    pub handshake_hash: Vec<u8>,
    pub reader: NoiseReader<ReadHalf<S>>,
    pub writer: NoiseWriter<WriteHalf<S>>,
}

impl<S> std::fmt::Debug for ClientConnection<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClientConnection")
            .field("accepted", &self.accepted)
            .finish_non_exhaustive()
    }
}

impl<S: AsyncRead + AsyncWrite> ClientConnection<S> {
    pub async fn send(&mut self, message: &DeviceMessage) -> Result<(), Error> {
        self.writer.send(message).await
    }

    pub async fn recv(&mut self) -> Result<HostMessage, Error> {
        self.reader.recv().await
    }
}

/// Runs the IK handshake against the workstation pinned by `host_public`, then sends `hello`.
/// A refusal is `Err(Error::Rejected(reason))`.
pub async fn connect<S>(
    mut stream: S,
    device: &StaticKeypair,
    host_public: &[u8; KEY_LEN],
    hello: &DeviceHello,
) -> Result<ClientConnection<S>, Error>
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let mut handshake = noise::initiator(device, host_public)?;
        transport::write_handshake(&mut stream, &mut handshake, &serde_json::to_vec(hello)?)
            .await?;
        let payload = transport::read_handshake(&mut stream, &mut handshake).await?;
        let reply = serde_json::from_slice::<HandshakeReply>(&payload)
            .map_err(|e| Error::BadHandshake(e.to_string()))?;
        let accepted = match reply {
            HandshakeReply::Accepted(accepted) => accepted,
            HandshakeReply::Rejected(reason) => return Err(Error::Rejected(reason)),
        };
        let handshake_hash = handshake.get_handshake_hash().to_vec();
        let (reader, mut writer) = transport::split(stream, handshake.into_transport_mode()?);
        writer.send(&DeviceMessage::Hello {}).await?;
        Ok(ClientConnection {
            accepted,
            handshake_hash,
            reader,
            writer,
        })
    })
    .await
    .unwrap_or(Err(Error::HandshakeTimeout))
}
