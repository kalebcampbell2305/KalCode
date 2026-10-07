import CryptoKit
import Foundation

/// Noise_IK_25519_ChaChaPoly_SHA256 (Noise revision 34), built on CryptoKit only.
///
/// The phone is always the initiator. The responder half exists so the handshake can be proven
/// end to end in unit tests (and against the published test vectors) without a workstation.
public enum Noise {
    public static let protocolName = "Noise_IK_25519_ChaChaPoly_SHA256"
    public static let prologue = Data("kalcode-remote/1".utf8)
    public static let dhLen = 32
    public static let tagLen = 16
    /// Largest Noise message (one wire frame).
    public static let maxMessageLen = 65535
}

public enum NoiseError: Error, Equatable {
    case invalidKey
    case invalidMessage
    case decryptFailed
    case nonceExhausted
    case messageTooLarge
}

// MARK: - Primitives

enum NoisePrimitives {
    static func hash(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    static func hmac(key: Data, data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    /// Noise HKDF with two outputs (HMAC-SHA256 based, Noise spec §4.3).
    static func hkdf2(chainingKey: Data, ikm: Data) -> (Data, Data) {
        let temp = hmac(key: chainingKey, data: ikm)
        let out1 = hmac(key: temp, data: Data([0x01]))
        var input2 = out1
        input2.append(0x02)
        let out2 = hmac(key: temp, data: input2)
        return (out1, out2)
    }

    static func dh(_ priv: Curve25519.KeyAgreement.PrivateKey, _ pub: Curve25519.KeyAgreement.PublicKey) throws -> Data {
        do {
            let secret = try priv.sharedSecretFromKeyAgreement(with: pub)
            return secret.withUnsafeBytes { Data($0) }
        } catch {
            throw NoiseError.invalidKey
        }
    }

    /// ChaChaPoly nonce: 4 zero bytes followed by the 64-bit counter, little-endian.
    static func nonce(_ n: UInt64) -> ChaChaPoly.Nonce {
        var bytes = [UInt8](repeating: 0, count: 12)
        var value = n
        for i in 0..<8 {
            bytes[4 + i] = UInt8(truncatingIfNeeded: value)
            value >>= 8
        }
        // 12 bytes is always a valid ChaChaPoly nonce.
        return try! ChaChaPoly.Nonce(data: bytes)
    }
}

// MARK: - CipherState

public struct NoiseCipherState {
    private var key: SymmetricKey?
    public private(set) var nonce: UInt64 = 0

    init(key: Data? = nil) {
        self.key = key.map { SymmetricKey(data: $0) }
    }

    var hasKey: Bool { key != nil }

    public mutating func encrypt(ad: Data = Data(), plaintext: Data) throws -> Data {
        guard let key else { return plaintext }
        guard nonce < UInt64.max else { throw NoiseError.nonceExhausted }
        let box = try ChaChaPoly.seal(plaintext, using: key, nonce: NoisePrimitives.nonce(nonce), authenticating: ad)
        nonce += 1
        var out = Data(box.ciphertext)
        out.append(box.tag)
        return out
    }

    public mutating func decrypt(ad: Data = Data(), ciphertext: Data) throws -> Data {
        guard let key else { return ciphertext }
        guard nonce < UInt64.max else { throw NoiseError.nonceExhausted }
        guard ciphertext.count >= Noise.tagLen else { throw NoiseError.invalidMessage }
        let body = Data(ciphertext.prefix(ciphertext.count - Noise.tagLen))
        let tag = Data(ciphertext.suffix(Noise.tagLen))
        do {
            let box = try ChaChaPoly.SealedBox(nonce: NoisePrimitives.nonce(nonce), ciphertext: body, tag: tag)
            let plaintext = try ChaChaPoly.open(box, using: key, authenticating: ad)
            nonce += 1
            return plaintext
        } catch {
            throw NoiseError.decryptFailed
        }
    }
}

// MARK: - SymmetricState

struct NoiseSymmetricState {
    private(set) var chainingKey: Data
    private(set) var handshakeHash: Data
    private var cipher = NoiseCipherState()

    init(protocolName: String = Noise.protocolName) {
        let name = Data(protocolName.utf8)
        if name.count <= 32 {
            handshakeHash = name + Data(count: 32 - name.count)
        } else {
            handshakeHash = NoisePrimitives.hash(name)
        }
        chainingKey = handshakeHash
    }

    mutating func mixKey(_ ikm: Data) {
        let (ck, tempK) = NoisePrimitives.hkdf2(chainingKey: chainingKey, ikm: ikm)
        chainingKey = ck
        cipher = NoiseCipherState(key: tempK)
    }

    mutating func mixHash(_ data: Data) {
        handshakeHash = NoisePrimitives.hash(handshakeHash + data)
    }

    mutating func encryptAndHash(_ plaintext: Data) throws -> Data {
        let ciphertext = try cipher.encrypt(ad: handshakeHash, plaintext: plaintext)
        mixHash(ciphertext)
        return ciphertext
    }

    mutating func decryptAndHash(_ ciphertext: Data) throws -> Data {
        let plaintext = try cipher.decrypt(ad: handshakeHash, ciphertext: ciphertext)
        mixHash(ciphertext)
        return plaintext
    }

    func split() -> (NoiseCipherState, NoiseCipherState) {
        let (k1, k2) = NoisePrimitives.hkdf2(chainingKey: chainingKey, ikm: Data())
        return (NoiseCipherState(key: k1), NoiseCipherState(key: k2))
    }
}

// MARK: - Transport

/// Per-direction transport ciphers after a completed handshake.
public struct NoiseTransport {
    public var sender: NoiseCipherState
    public var receiver: NoiseCipherState
    /// The final handshake hash `h` (channel binding).
    public let handshakeHash: Data

    public mutating func encrypt(_ plaintext: Data) throws -> Data {
        guard plaintext.count + Noise.tagLen <= Noise.maxMessageLen else { throw NoiseError.messageTooLarge }
        return try sender.encrypt(plaintext: plaintext)
    }

    public mutating func decrypt(_ ciphertext: Data) throws -> Data {
        try receiver.decrypt(ciphertext: ciphertext)
    }
}

// MARK: - IK initiator (`-> e, es, s, ss` / `<- e, ee, se`)

public struct NoiseIKInitiator {
    private let staticKey: Curve25519.KeyAgreement.PrivateKey
    private let remoteStatic: Curve25519.KeyAgreement.PublicKey
    private let ephemeral: Curve25519.KeyAgreement.PrivateKey
    private var symmetric: NoiseSymmetricState

    /// - Parameters:
    ///   - ephemeral: injected only by deterministic tests; production always generates a fresh key.
    public init(
        staticKey: Curve25519.KeyAgreement.PrivateKey,
        remoteStatic: Curve25519.KeyAgreement.PublicKey,
        prologue: Data = Noise.prologue,
        ephemeral: Curve25519.KeyAgreement.PrivateKey? = nil
    ) {
        self.staticKey = staticKey
        self.remoteStatic = remoteStatic
        self.ephemeral = ephemeral ?? Curve25519.KeyAgreement.PrivateKey()
        var symmetric = NoiseSymmetricState()
        symmetric.mixHash(prologue)
        symmetric.mixHash(remoteStatic.rawRepresentation)
        self.symmetric = symmetric
    }

    public mutating func writeMessage1(payload: Data) throws -> Data {
        var out = Data()
        let e = ephemeral.publicKey.rawRepresentation
        out.append(e)
        symmetric.mixHash(e)
        symmetric.mixKey(try NoisePrimitives.dh(ephemeral, remoteStatic))
        out.append(try symmetric.encryptAndHash(staticKey.publicKey.rawRepresentation))
        symmetric.mixKey(try NoisePrimitives.dh(staticKey, remoteStatic))
        out.append(try symmetric.encryptAndHash(payload))
        guard out.count <= Noise.maxMessageLen else { throw NoiseError.messageTooLarge }
        return out
    }

    public mutating func readMessage2(_ message: Data) throws -> (payload: Data, transport: NoiseTransport) {
        let message = Data(message)
        guard message.count >= Noise.dhLen + Noise.tagLen else { throw NoiseError.invalidMessage }
        let reBytes = message.prefix(Noise.dhLen)
        guard let re = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: reBytes) else {
            throw NoiseError.invalidKey
        }
        symmetric.mixHash(Data(reBytes))
        symmetric.mixKey(try NoisePrimitives.dh(ephemeral, re))
        symmetric.mixKey(try NoisePrimitives.dh(staticKey, re))
        let payload = try symmetric.decryptAndHash(Data(message.dropFirst(Noise.dhLen)))
        let (c1, c2) = symmetric.split()
        return (payload, NoiseTransport(sender: c1, receiver: c2, handshakeHash: symmetric.handshakeHash))
    }
}

// MARK: - IK responder (tests and local tooling)

public struct NoiseIKResponder {
    private let staticKey: Curve25519.KeyAgreement.PrivateKey
    private let ephemeral: Curve25519.KeyAgreement.PrivateKey
    private var symmetric: NoiseSymmetricState
    private var remoteEphemeral: Curve25519.KeyAgreement.PublicKey?
    public private(set) var remoteStatic: Curve25519.KeyAgreement.PublicKey?

    public init(
        staticKey: Curve25519.KeyAgreement.PrivateKey,
        prologue: Data = Noise.prologue,
        ephemeral: Curve25519.KeyAgreement.PrivateKey? = nil
    ) {
        self.staticKey = staticKey
        self.ephemeral = ephemeral ?? Curve25519.KeyAgreement.PrivateKey()
        var symmetric = NoiseSymmetricState()
        symmetric.mixHash(prologue)
        symmetric.mixHash(staticKey.publicKey.rawRepresentation)
        self.symmetric = symmetric
    }

    public mutating func readMessage1(_ message: Data) throws -> Data {
        let message = Data(message)
        let staticLen = Noise.dhLen + Noise.tagLen
        guard message.count >= Noise.dhLen + staticLen + Noise.tagLen else { throw NoiseError.invalidMessage }
        let reBytes = Data(message.prefix(Noise.dhLen))
        guard let re = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: reBytes) else {
            throw NoiseError.invalidKey
        }
        remoteEphemeral = re
        symmetric.mixHash(reBytes)
        symmetric.mixKey(try NoisePrimitives.dh(staticKey, re))
        let encStatic = Data(message.dropFirst(Noise.dhLen).prefix(staticLen))
        let rsBytes = try symmetric.decryptAndHash(encStatic)
        guard let rs = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: rsBytes) else {
            throw NoiseError.invalidKey
        }
        remoteStatic = rs
        symmetric.mixKey(try NoisePrimitives.dh(staticKey, rs))
        return try symmetric.decryptAndHash(Data(message.dropFirst(Noise.dhLen + staticLen)))
    }

    public mutating func writeMessage2(payload: Data) throws -> (message: Data, transport: NoiseTransport) {
        guard let re = remoteEphemeral, let rs = remoteStatic else { throw NoiseError.invalidMessage }
        var out = Data()
        let e = ephemeral.publicKey.rawRepresentation
        out.append(e)
        symmetric.mixHash(e)
        symmetric.mixKey(try NoisePrimitives.dh(ephemeral, re))
        symmetric.mixKey(try NoisePrimitives.dh(ephemeral, rs))
        out.append(try symmetric.encryptAndHash(payload))
        let (c1, c2) = symmetric.split()
        return (out, NoiseTransport(sender: c2, receiver: c1, handshakeHash: symmetric.handshakeHash))
    }
}
