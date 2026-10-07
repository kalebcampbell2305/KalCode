import CryptoKit
import XCTest
@testable import RemoteKit

/// Reproduces `crates/remote/tests/vectors/noise_ik.json` (the Rust host's committed vector)
/// byte for byte: both handshake messages, the handshake hash, and every transport frame.
final class NoiseVectorTests: XCTestCase {
    private struct Vector: Decodable {
        struct HandshakeMessage: Decodable { var direction: String; var message_hex: String; var payload_hex: String; var wire_frame_hex: String }
        struct TransportMessage: Decodable { var direction: String; var nonce: UInt64; var plaintext_hex: String; var ciphertext_hex: String; var wire_frame_hex: String; var json: String }
        var protocol_name: String
        var prologue_hex: String
        var keys: [String: String]
        var handshake: [HandshakeMessage]
        var handshake_hash: String
        var transport: [TransportMessage]
    }

    private func load() throws -> Vector {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "noise_ik", withExtension: "json"))
        return try JSONDecoder().decode(Vector.self, from: Data(contentsOf: url))
    }

    func testReproducesRustVectorByteForByte() throws {
        let v = try load()
        XCTAssertEqual(v.protocol_name, Noise.protocolName)
        XCTAssertEqual(try hex(v.prologue_hex), Noise.prologue)
        func priv(_ name: String) throws -> Curve25519.KeyAgreement.PrivateKey {
            try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: hex(XCTUnwrap(v.keys[name])))
        }
        let iS = try priv("initiator_static_private"), iE = try priv("initiator_ephemeral_private")
        let rS = try priv("responder_static_private"), rE = try priv("responder_ephemeral_private")
        XCTAssertEqual(iS.publicKey.rawRepresentation.hex, v.keys["initiator_static_public"])
        XCTAssertEqual(iE.publicKey.rawRepresentation.hex, v.keys["initiator_ephemeral_public"])
        XCTAssertEqual(rS.publicKey.rawRepresentation.hex, v.keys["responder_static_public"])
        XCTAssertEqual(rE.publicKey.rawRepresentation.hex, v.keys["responder_ephemeral_public"])

        let m1v = try XCTUnwrap(v.handshake.first { $0.direction == "initiator_to_responder" })
        let m2v = try XCTUnwrap(v.handshake.first { $0.direction == "responder_to_initiator" })

        var initiator = NoiseIKInitiator(staticKey: iS, remoteStatic: rS.publicKey, ephemeral: iE)
        let m1 = try initiator.writeMessage1(payload: try hex(m1v.payload_hex))
        XCTAssertEqual(m1.hex, m1v.message_hex, "message 1")
        XCTAssertEqual(try Framing.frame(m1).hex, m1v.wire_frame_hex)

        var responder = NoiseIKResponder(staticKey: rS, ephemeral: rE)
        XCTAssertEqual(try responder.readMessage1(m1).hex, m1v.payload_hex)
        let (m2, hostTransport) = try responder.writeMessage2(payload: try hex(m2v.payload_hex))
        XCTAssertEqual(m2.hex, m2v.message_hex, "message 2")
        XCTAssertEqual(try Framing.frame(m2).hex, m2v.wire_frame_hex)

        let (reply, deviceTransport) = try initiator.readMessage2(try hex(m2v.message_hex))
        XCTAssertEqual(reply.hex, m2v.payload_hex)
        XCTAssertEqual(deviceTransport.handshakeHash.hex, v.handshake_hash)
        XCTAssertEqual(hostTransport.handshakeHash.hex, v.handshake_hash)

        var device = deviceTransport, host = hostTransport
        XCTAssertFalse(v.transport.isEmpty)
        for t in v.transport {
            let plaintext = try hex(t.plaintext_hex)
            XCTAssertEqual(try Framing.appMessageChunks(Data(t.json.utf8)), [plaintext], "app framing for \(t.json)")
            if t.direction == "initiator_to_responder" {
                XCTAssertEqual(device.sender.nonce, t.nonce)
                let c = try device.encrypt(plaintext)
                XCTAssertEqual(c.hex, t.ciphertext_hex, t.json)
                XCTAssertEqual(try host.decrypt(c), plaintext)
                XCTAssertEqual(try Framing.frame(c).hex, t.wire_frame_hex)
            } else {
                XCTAssertEqual(host.sender.nonce, t.nonce)
                let c = try host.encrypt(plaintext)
                XCTAssertEqual(c.hex, t.ciphertext_hex, t.json)
                XCTAssertEqual(try device.decrypt(try hex(t.ciphertext_hex)), plaintext)
                XCTAssertEqual(try Framing.frame(c).hex, t.wire_frame_hex)
            }
        }
    }

    private func hex(_ s: String) throws -> Data {
        var out = Data(capacity: s.count / 2)
        var it = s.makeIterator()
        while let a = it.next(), let b = it.next() {
            guard let byte = UInt8(String([a, b]), radix: 16) else { throw NoiseError.invalidMessage }
            out.append(byte)
        }
        return out
    }
}

extension Data {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}
