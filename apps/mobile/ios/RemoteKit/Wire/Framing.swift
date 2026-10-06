import Foundation

/// Wire framing (protocol §3).
///
/// * Wire frame: 2-byte big-endian length + that many bytes of Noise message (≤ 65535).
/// * Application message: 4-byte big-endian length + UTF-8 JSON (≤ 8 MiB), carried in the
///   decrypted plaintext stream of consecutive frames, ≤ 65519 plaintext bytes per frame.
public enum Framing {
    public static let maxFrameLen = 65535
    public static let maxPlaintextPerFrame = 65535 - 16
    public static let maxAppMessageLen = 8 * 1024 * 1024

    public enum Error: Swift.Error, Equatable {
        case frameTooLarge(Int)
        case messageTooLarge(Int)
        case emptyFrame
    }

    /// Prefixes one Noise message with its 2-byte big-endian length.
    public static func frame(_ payload: Data) throws -> Data {
        guard payload.count <= maxFrameLen else { throw Error.frameTooLarge(payload.count) }
        var out = Data(capacity: payload.count + 2)
        out.append(UInt8(payload.count >> 8))
        out.append(UInt8(payload.count & 0xFF))
        out.append(payload)
        return out
    }

    /// Splits one application message (4-byte length + JSON) into plaintext chunks that each fit
    /// in one frame after encryption.
    public static func appMessageChunks(_ json: Data) throws -> [Data] {
        guard json.count <= maxAppMessageLen else { throw Error.messageTooLarge(json.count) }
        var stream = Data(capacity: json.count + 4)
        let len = UInt32(json.count)
        stream.append(UInt8((len >> 24) & 0xFF))
        stream.append(UInt8((len >> 16) & 0xFF))
        stream.append(UInt8((len >> 8) & 0xFF))
        stream.append(UInt8(len & 0xFF))
        stream.append(json)
        var chunks: [Data] = []
        var offset = stream.startIndex
        while offset < stream.endIndex {
            let end = min(offset + maxPlaintextPerFrame, stream.endIndex)
            chunks.append(Data(stream[offset..<end]))
            offset = end
        }
        return chunks
    }
}

/// Accumulates raw TCP bytes and yields complete Noise messages.
public struct FrameReader {
    private var buffer = Data()

    public init() {}

    public var bufferedByteCount: Int { buffer.count }

    public mutating func push(_ bytes: Data) {
        buffer.append(bytes)
    }

    /// The next complete frame payload, or nil when more bytes are needed.
    public mutating func next() throws -> Data? {
        guard buffer.count >= 2 else { return nil }
        let start = buffer.startIndex
        let len = Int(buffer[start]) << 8 | Int(buffer[start + 1])
        guard len > 0 else { throw Framing.Error.emptyFrame }
        guard buffer.count >= 2 + len else { return nil }
        let payload = Data(buffer[(start + 2)..<(start + 2 + len)])
        buffer = Data(buffer[(start + 2 + len)...])
        return payload
    }
}

/// Reassembles application messages from the decrypted plaintext stream.
public struct AppMessageAssembler {
    private var buffer = Data()

    public init() {}

    public var bufferedByteCount: Int { buffer.count }

    /// Feeds one decrypted frame and returns every application message it completed.
    public mutating func push(_ plaintext: Data) throws -> [Data] {
        buffer.append(plaintext)
        var messages: [Data] = []
        while buffer.count >= 4 {
            let s = buffer.startIndex
            let len = Int(buffer[s]) << 24 | Int(buffer[s + 1]) << 16 | Int(buffer[s + 2]) << 8 | Int(buffer[s + 3])
            guard len <= Framing.maxAppMessageLen else { throw Framing.Error.messageTooLarge(len) }
            guard buffer.count >= 4 + len else { break }
            messages.append(Data(buffer[(s + 4)..<(s + 4 + len)]))
            buffer = Data(buffer[(s + 4 + len)...])
        }
        return messages
    }
}
