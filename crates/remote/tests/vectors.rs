//! Deterministic Noise IK vectors for the iOS and Android implementations
//! (`tests/vectors/noise_ik.json`).
//!
//! The vectors are regenerated here from fixed static and ephemeral keys with the crate's own
//! Noise configuration and compared with the committed file. To rewrite the file after an
//! intentional change: `KALCODE_REMOTE_WRITE_VECTORS=1 cargo test -p kalcode-remote --test vectors`.

#![allow(clippy::expect_used, clippy::unwrap_used)]

use std::path::PathBuf;

use kalcode_remote::noise::{self, PATTERN, PROLOGUE, StaticKeypair};
use kalcode_remote::transport::MAX_NOISE_MESSAGE;
use kalcode_remote::wire::{
    ByeReason, DeviceHello, DeviceMessage, HandshakeAccepted, HandshakeReply, HostBuild,
    HostMessage,
};
use serde_json::{Value, json};

/// 32 bytes counting up from `start`.
fn key(start: u8) -> [u8; 32] {
    std::array::from_fn(|i| start.wrapping_add(i as u8))
}

fn frame(message: &[u8]) -> Vec<u8> {
    let mut out = (message.len() as u16).to_be_bytes().to_vec();
    out.extend_from_slice(message);
    out
}

fn app(json: &[u8]) -> Vec<u8> {
    let mut out = (json.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(json);
    out
}

fn generate() -> Value {
    let initiator_static = StaticKeypair::from_private(key(0x01)).unwrap();
    let responder_static = StaticKeypair::from_private(key(0x21)).unwrap();
    let initiator_ephemeral = StaticKeypair::from_private(key(0x41)).unwrap();
    let responder_ephemeral = StaticKeypair::from_private(key(0x61)).unwrap();

    let mut initiator = noise::builder()
        .unwrap()
        .local_private_key(initiator_static.private_bytes())
        .unwrap()
        .remote_public_key(responder_static.public())
        .unwrap()
        .fixed_ephemeral_key_for_testing_only(initiator_ephemeral.private_bytes())
        .build_initiator()
        .unwrap();
    let mut responder = noise::builder()
        .unwrap()
        .local_private_key(responder_static.private_bytes())
        .unwrap()
        .fixed_ephemeral_key_for_testing_only(responder_ephemeral.private_bytes())
        .build_responder()
        .unwrap();

    let hello = DeviceHello {
        v: 1,
        device: "Test iPhone".into(),
        platform: "ios".into(),
        model: "iPhone17,1".into(),
        app: "1.0 (1)".into(),
        pair: Some(base64_std(&[0x42; 32])),
        ts: 1_791_234_567,
    };
    let reply = HandshakeReply::Accepted(HandshakeAccepted {
        wid: "ws_00000000000000000000test".into(),
        name: "Test Workstation".into(),
        device_id: "dev_00000000000000000000test".into(),
        host: HostBuild {
            platform: "windows".into(),
            version: "0.1.9".into(),
            build: 2007,
        },
    });
    let payload1 = serde_json::to_vec(&hello).unwrap();
    let payload2 = serde_json::to_vec(&reply).unwrap();

    let mut buf = vec![0u8; MAX_NOISE_MESSAGE];
    let mut out = vec![0u8; MAX_NOISE_MESSAGE];

    let len = initiator.write_message(&payload1, &mut buf).unwrap();
    let message1 = buf[..len].to_vec();
    let n = responder.read_message(&message1, &mut out).unwrap();
    assert_eq!(out[..n], payload1[..]);
    assert_eq!(
        responder.get_remote_static().unwrap(),
        initiator_static.public()
    );

    let len = responder.write_message(&payload2, &mut buf).unwrap();
    let message2 = buf[..len].to_vec();
    let n = initiator.read_message(&message2, &mut out).unwrap();
    assert_eq!(out[..n], payload2[..]);

    assert_eq!(
        initiator.get_handshake_hash(),
        responder.get_handshake_hash()
    );
    let handshake_hash = hex::encode(initiator.get_handshake_hash());
    let mut initiator = initiator.into_transport_mode().unwrap();
    let mut responder = responder.into_transport_mode().unwrap();

    let messages: [(bool, Vec<u8>); 4] = [
        (true, serde_json::to_vec(&DeviceMessage::Hello {}).unwrap()),
        (
            true,
            serde_json::to_vec(&DeviceMessage::Ping { n: 1 }).unwrap(),
        ),
        (
            false,
            serde_json::to_vec(&HostMessage::Pong { n: 1 }).unwrap(),
        ),
        (
            false,
            serde_json::to_vec(&HostMessage::Bye {
                reason: ByeReason::Shutdown,
            })
            .unwrap(),
        ),
    ];
    let mut nonces = [0u64, 0u64];
    let mut transport = Vec::new();
    for (from_initiator, json) in messages {
        let plaintext = app(&json);
        let (sender, receiver) = if from_initiator {
            (&mut initiator, &mut responder)
        } else {
            (&mut responder, &mut initiator)
        };
        let len = sender.write_message(&plaintext, &mut buf).unwrap();
        let ciphertext = buf[..len].to_vec();
        let n = receiver.read_message(&ciphertext, &mut out).unwrap();
        assert_eq!(out[..n], plaintext[..]);
        let slot = usize::from(!from_initiator);
        transport.push(json!({
            "direction": if from_initiator { "initiator_to_responder" } else { "responder_to_initiator" },
            "nonce": nonces[slot],
            "json": String::from_utf8(json).unwrap(),
            "plaintext_hex": hex::encode(&plaintext),
            "ciphertext_hex": hex::encode(&ciphertext),
            "wire_frame_hex": hex::encode(frame(&ciphertext)),
        }));
        nonces[slot] += 1;
    }

    json!({
        "description": "KalCode Remote v1 Noise IK test vector (docs/REMOTE_PROTOCOL.md §3). Generated by crates/remote/tests/vectors.rs with fixed static and ephemeral keys. All binary values are lowercase hex. The initiator is the device, the responder the desktop. wire_frame_hex = 2-byte big-endian length + Noise message. Transport plaintext_hex = 4-byte big-endian length + UTF-8 JSON (one application message, here each fitting in one frame). Each direction's nonce starts at 0.",
        "protocol_name": PATTERN,
        "prologue_utf8": String::from_utf8(PROLOGUE.to_vec()).unwrap(),
        "prologue_hex": hex::encode(PROLOGUE),
        "keys": {
            "initiator_static_private": hex::encode(initiator_static.private_bytes()),
            "initiator_static_public": hex::encode(initiator_static.public()),
            "initiator_ephemeral_private": hex::encode(initiator_ephemeral.private_bytes()),
            "initiator_ephemeral_public": hex::encode(initiator_ephemeral.public()),
            "responder_static_private": hex::encode(responder_static.private_bytes()),
            "responder_static_public": hex::encode(responder_static.public()),
            "responder_ephemeral_private": hex::encode(responder_ephemeral.private_bytes()),
            "responder_ephemeral_public": hex::encode(responder_ephemeral.public()),
        },
        "handshake": [
            {
                "direction": "initiator_to_responder",
                "tokens": "e, es, s, ss",
                "payload_utf8": String::from_utf8(payload1.clone()).unwrap(),
                "payload_hex": hex::encode(&payload1),
                "message_hex": hex::encode(&message1),
                "wire_frame_hex": hex::encode(frame(&message1)),
            },
            {
                "direction": "responder_to_initiator",
                "tokens": "e, ee, se",
                "payload_utf8": String::from_utf8(payload2.clone()).unwrap(),
                "payload_hex": hex::encode(&payload2),
                "message_hex": hex::encode(&message2),
                "wire_frame_hex": hex::encode(frame(&message2)),
            },
        ],
        "handshake_hash": handshake_hash,
        "transport": transport,
    })
}

fn base64_std(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/vectors/noise_ik.json")
}

#[test]
fn noise_ik_vectors_match_the_committed_file() {
    let generated = generate();
    if std::env::var_os("KALCODE_REMOTE_WRITE_VECTORS").is_some() {
        let mut text = serde_json::to_string_pretty(&generated).unwrap();
        text.push('\n');
        std::fs::write(path(), text).unwrap();
    }
    let committed: Value =
        serde_json::from_str(&std::fs::read_to_string(path()).expect("vectors file")).unwrap();
    assert_eq!(
        committed, generated,
        "regenerate with KALCODE_REMOTE_WRITE_VECTORS=1 if the change is intended"
    );
}

#[test]
fn vector_messages_have_the_expected_ik_sizes() {
    let v = generate();
    let payload1 = v["handshake"][0]["payload_hex"].as_str().unwrap().len() / 2;
    let message1 = v["handshake"][0]["message_hex"].as_str().unwrap().len() / 2;
    // e (32) + encrypted s (32 + 16) + encrypted payload (+16).
    assert_eq!(message1, 32 + 48 + payload1 + 16);
    let payload2 = v["handshake"][1]["payload_hex"].as_str().unwrap().len() / 2;
    let message2 = v["handshake"][1]["message_hex"].as_str().unwrap().len() / 2;
    // e (32) + encrypted payload (+16).
    assert_eq!(message2, 32 + payload2 + 16);
    // The ephemeral public keys are the first 32 bytes of each handshake message.
    assert_eq!(
        &v["handshake"][0]["message_hex"].as_str().unwrap()[..64],
        v["keys"]["initiator_ephemeral_public"]
    );
    assert_eq!(
        &v["handshake"][1]["message_hex"].as_str().unwrap()[..64],
        v["keys"]["responder_ephemeral_public"]
    );
}
