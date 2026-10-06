import CryptoKit
import XCTest
@testable import RemoteKit

final class NoiseTests: XCTestCase {
    func testProtocolNameIsExactlyHashLen() {
        XCTAssertEqual(Data(Noise.protocolName.utf8).count, 32)
    }

    func testNonceLayoutIsFourZeroBytesThenLittleEndianCounter() {
        let nonce = NoisePrimitives.nonce(0x0102_0304_0506_0708)
        let bytes = nonce.withUnsafeBytes { Array($0) }
        XCTAssertEqual(bytes, [0, 0, 0, 0, 0x08, 0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01])
    }

    func testHKDFMatchesRFC5869StyleConstruction() {
        // Noise HKDF(ck, ikm) = HMAC(HMAC(ck, ikm), 0x01), HMAC(temp, out1 || 0x02).
        let ck = Data(repeating: 0x0b, count: 32), ikm = Data("ikm".utf8)
        let temp = Data(HMAC<SHA256>.authenticationCode(for: ikm, using: SymmetricKey(data: ck)))
        let o1 = Data(HMAC<SHA256>.authenticationCode(for: Data([1]), using: SymmetricKey(data: temp)))
        let o2 = Data(HMAC<SHA256>.authenticationCode(for: o1 + Data([2]), using: SymmetricKey(data: temp)))
        let (a, b) = NoisePrimitives.hkdf2(chainingKey: ck, ikm: ikm)
        XCTAssertEqual(a, o1)
        XCTAssertEqual(b, o2)
    }

    func testIKHandshakeRoundTripAndTransport() throws {
        let deviceKey = Curve25519.KeyAgreement.PrivateKey()
        let hostKey = Curve25519.KeyAgreement.PrivateKey()
        var initiator = NoiseIKInitiator(staticKey: deviceKey, remoteStatic: hostKey.publicKey)
        var responder = NoiseIKResponder(staticKey: hostKey)

        let m1 = try initiator.writeMessage1(payload: Data(#"{"v":1}"#.utf8))
        XCTAssertEqual(m1.count, 32 + 48 + 7 + 16)
        XCTAssertEqual(try responder.readMessage1(m1), Data(#"{"v":1}"#.utf8))
        XCTAssertEqual(responder.remoteStatic?.rawRepresentation, deviceKey.publicKey.rawRepresentation)

        let (m2, hostTransport) = try responder.writeMessage2(payload: Data(#"{"ok":true}"#.utf8))
        XCTAssertEqual(m2.count, 32 + 11 + 16)
        let (reply, deviceTransport) = try initiator.readMessage2(m2)
        XCTAssertEqual(reply, Data(#"{"ok":true}"#.utf8))
        XCTAssertEqual(deviceTransport.handshakeHash, hostTransport.handshakeHash)

        var d = deviceTransport, h = hostTransport
        for i in 0..<5 {
            let c = try d.encrypt(Data("ping \(i)".utf8))
            XCTAssertEqual(try h.decrypt(c), Data("ping \(i)".utf8))
            let r = try h.encrypt(Data("pong \(i)".utf8))
            XCTAssertEqual(try d.decrypt(r), Data("pong \(i)".utf8))
        }
    }

    func testWrongWorkstationKeyCannotCompleteHandshake() throws {
        let deviceKey = Curve25519.KeyAgreement.PrivateKey()
        let realHost = Curve25519.KeyAgreement.PrivateKey()
        let impostor = Curve25519.KeyAgreement.PrivateKey()
        var initiator = NoiseIKInitiator(staticKey: deviceKey, remoteStatic: realHost.publicKey)
        var responder = NoiseIKResponder(staticKey: impostor)
        let m1 = try initiator.writeMessage1(payload: Data())
        XCTAssertThrowsError(try responder.readMessage1(m1))
    }

    func testTamperedTransportFrameIsRejectedAndReplayFails() throws {
        let (d0, h0) = try Self.pair()
        var d = d0, h = h0
        var c = try d.encrypt(Data("hello".utf8))
        c[c.startIndex] ^= 0x01
        XCTAssertThrowsError(try h.decrypt(c)) { XCTAssertEqual($0 as? NoiseError, .decryptFailed) }

        var d2 = d0, h2 = h0
        let first = try d2.encrypt(Data("one".utf8))
        XCTAssertNoThrow(try h2.decrypt(first))
        XCTAssertThrowsError(try h2.decrypt(first), "a replayed frame uses a stale nonce")
    }

    static func pair() throws -> (NoiseTransport, NoiseTransport) {
        let deviceKey = Curve25519.KeyAgreement.PrivateKey()
        let hostKey = Curve25519.KeyAgreement.PrivateKey()
        var i = NoiseIKInitiator(staticKey: deviceKey, remoteStatic: hostKey.publicKey)
        var r = NoiseIKResponder(staticKey: hostKey)
        _ = try r.readMessage1(try i.writeMessage1(payload: Data()))
        let (m2, ht) = try r.writeMessage2(payload: Data())
        let (_, dt) = try i.readMessage2(m2)
        return (dt, ht)
    }
}
