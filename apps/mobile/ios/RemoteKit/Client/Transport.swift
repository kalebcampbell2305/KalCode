import CryptoKit
import Foundation
import Network

public enum TransportError: Error, Equatable, Sendable {
    case closed
    case unreachable(String)
    case handshakeTimeout
    case protocolViolation(String)
}

/// One TCP connection carrying length-prefixed Noise frames (Network.framework).
final class FramedConnection: @unchecked Sendable {
    let endpoint: HostPort
    private let connection: NWConnection
    private let queue: DispatchQueue
    private var reader = FrameReader()   // only touched by the single reading task

    init(endpoint: HostPort) {
        self.endpoint = endpoint
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.connectionTimeout = 8
        let params = NWParameters(tls: nil, tcp: tcp)
        params.includePeerToPeer = false
        connection = NWConnection(
            host: NWEndpoint.Host(endpoint.host),
            port: NWEndpoint.Port(rawValue: endpoint.port) ?? 47820,
            using: params
        )
        queue = DispatchQueue(label: "com.kalcode.remote.conn.\(endpoint)")
    }

    /// Wraps an accepted connection (loopback test host).
    init(accepted: NWConnection, endpoint: HostPort) {
        self.endpoint = endpoint
        connection = accepted
        queue = DispatchQueue(label: "com.kalcode.remote.accepted")
    }

    func open() async throws {
        let conn = connection
        let ep = endpoint.description
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Void, Error>) in
                let once = Once()
                conn.stateUpdateHandler = { state in
                    switch state {
                    case .ready:
                        once.run { cont.resume() }
                    case .failed(let error):
                        once.run { cont.resume(throwing: TransportError.unreachable("\(ep): \(error)")) }
                    case .waiting(let error):
                        // Refused / no route: fail fast and let the reconnect loop retry.
                        once.run { cont.resume(throwing: TransportError.unreachable("\(ep): \(error)")) }
                        conn.cancel()
                    case .cancelled:
                        once.run { cont.resume(throwing: CancellationError()) }
                    default:
                        break
                    }
                }
                conn.start(queue: queue)
            }
        } onCancel: {
            conn.cancel()
        }
    }

    func send(frame payload: Data) throws {
        let framed = try Framing.frame(payload)
        connection.send(content: framed, completion: .contentProcessed { _ in })
    }

    func readFrame() async throws -> Data {
        while true {
            if let frame = try reader.next() { return frame }
            reader.push(try await receiveChunk())
        }
    }

    private func receiveChunk() async throws -> Data {
        let conn = connection
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Data, Error>) in
                conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, isComplete, error in
                    if let data, !data.isEmpty {
                        cont.resume(returning: data)
                    } else if let error {
                        cont.resume(throwing: TransportError.unreachable("\(error)"))
                    } else {
                        _ = isComplete
                        cont.resume(throwing: TransportError.closed)
                    }
                }
            }
        } onCancel: {
            conn.cancel()
        }
    }

    func close() { connection.cancel() }
}

private final class Flag: @unchecked Sendable {
    private var value = false
    private let lock = NSLock()
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

private final class Once: @unchecked Sendable {
    private var done = false
    private let lock = NSLock()
    func run(_ body: () -> Void) {
        lock.lock()
        let first = !done
        done = true
        lock.unlock()
        if first { body() }
    }
}

/// An authenticated, encrypted session with the workstation.
public final class SecureSession: @unchecked Sendable {
    public let endpoint: HostPort
    public let reply: HandshakeReply
    private let connection: FramedConnection
    private var sender: NoiseCipherState
    private var receiver: NoiseCipherState
    private var assembler = AppMessageAssembler()
    private var pending: [Data] = []
    private let sendLock = NSLock()

    var framed: FramedConnection { connection }

    init(connection: FramedConnection, transport: NoiseTransport, reply: HandshakeReply) {
        self.connection = connection
        self.endpoint = connection.endpoint
        self.sender = transport.sender
        self.receiver = transport.receiver
        self.reply = reply
    }

    /// Encrypts and sends one application message. Thread-safe; frames keep nonce order.
    public func send(_ message: OutboundMessage) throws {
        let json = try message.encoded()
        sendLock.lock()
        defer { sendLock.unlock() }
        for chunk in try Framing.appMessageChunks(json) {
            let ciphertext = try sender.encrypt(plaintext: chunk)
            try connection.send(frame: ciphertext)
        }
    }

    /// The next application message (raw JSON). Call from one task at a time.
    public func receiveRaw() async throws -> Data {
        while pending.isEmpty {
            let frame = try await connection.readFrame()
            let plaintext = try receiver.decrypt(ciphertext: frame)  // a bad tag or nonce gap throws
            pending.append(contentsOf: try assembler.push(plaintext))
        }
        return pending.removeFirst()
    }

    /// Sends raw JSON as one application message (loopback test host).
    func sendJSON(_ json: Data) throws {
        sendLock.lock()
        defer { sendLock.unlock() }
        for chunk in try Framing.appMessageChunks(json) {
            try connection.send(frame: try sender.encrypt(plaintext: chunk))
        }
    }

    public func receive() async throws -> InboundMessage {
        try InboundMessage.decode(try await receiveRaw())
    }

    public func close() { connection.close() }

    // MARK: Connect

    public struct Credentials: Sendable {
        public var deviceKey: Curve25519.KeyAgreement.PrivateKey
        public var workstationKey: Curve25519.KeyAgreement.PublicKey
        public var hello: HandshakeHello

        public init(deviceKey: Curve25519.KeyAgreement.PrivateKey, workstationKey: Curve25519.KeyAgreement.PublicKey, hello: HandshakeHello) {
            self.deviceKey = deviceKey; self.workstationKey = workstationKey; self.hello = hello
        }
    }

    /// One attempt against one address: TCP, then the IK handshake (10 s budget).
    static func connect(to endpoint: HostPort, credentials: Credentials, timeout: TimeInterval = 10) async throws -> SecureSession {
        let connection = FramedConnection(endpoint: endpoint)
        let timedOut = Flag()
        let timer = Task {
            try await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            timedOut.set()
            connection.close()
        }
        defer { timer.cancel() }
        do {
            try await connection.open()
            var initiator = NoiseIKInitiator(staticKey: credentials.deviceKey, remoteStatic: credentials.workstationKey)
            let payload = try JSONEncoder().encode(credentials.hello)
            try connection.send(frame: try initiator.writeMessage1(payload: payload))
            let message2 = try await connection.readFrame()
            let (replyData, transport) = try initiator.readMessage2(message2)
            let reply = try JSONDecoder().decode(HandshakeReply.self, from: replyData)
            guard reply.ok else {
                connection.close()
                throw HandshakeRejection(code: reply.error)
            }
            if Task.isCancelled { connection.close(); throw CancellationError() }
            return SecureSession(connection: connection, transport: transport, reply: reply)
        } catch let error as HandshakeRejection {
            throw error
        } catch {
            connection.close()
            if timedOut.isSet { throw TransportError.handshakeTimeout }
            throw error
        }
    }

    /// Tries every address in parallel and keeps the first completed handshake (protocol §2).
    /// Extra sessions that also complete are closed. If all fail, a definitive rejection wins
    /// over network errors.
    public static func connectFirst(to endpoints: [HostPort], credentials: Credentials) async throws -> SecureSession {
        guard !endpoints.isEmpty else { throw TransportError.unreachable("no addresses") }
        return try await withThrowingTaskGroup(of: Result<SecureSession, Error>.self) { group in
            for endpoint in endpoints {
                group.addTask {
                    do { return .success(try await connect(to: endpoint, credentials: credentials)) }
                    catch { return .failure(error) }
                }
            }
            var winner: SecureSession?
            var rejection: HandshakeRejection?
            var lastError: Error?
            for try await result in group {
                switch result {
                case .success(let session):
                    if winner == nil {
                        winner = session
                        group.cancelAll()
                    } else {
                        session.close()
                    }
                case .failure(let error):
                    if let r = error as? HandshakeRejection, rejection == nil || r.isDefinitive { rejection = r }
                    lastError = error
                }
            }
            if let winner { return winner }
            if Task.isCancelled { throw CancellationError() }
            throw rejection ?? lastError ?? TransportError.unreachable("no addresses")
        }
    }
}
