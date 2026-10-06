import CryptoKit
import Foundation
import Observation

/// Connection states (protocol §7).
public enum ConnectionStatus: Equatable, Sendable {
    case unpaired
    /// First connection after launch/pairing; nothing is shown as live yet.
    case connecting
    case online
    /// A paired workstation dropped; the last state stays visible but dimmed, never live.
    case reconnecting(since: Date)
    case offline(OfflineReason)
    case removed(RemovedReason)

    public var isOnline: Bool { self == .online }
    public var isReconnecting: Bool { if case .reconnecting = self { return true }; return false }
}

public enum OfflineReason: Equatable, Sendable {
    case unreachable        // no address answered for 30 s
    case shutdown           // the workstation said goodbye
    case disabled           // Remote was turned off on the workstation
    case notEntitled        // the plan doesn't include Remote
    case versionMismatch    // the desktop speaks a different protocol version
    case replaced           // a newer session from this device took over (max 2 per device)
    case invalidHello       // the desktop refused this device's hello fields
}

public enum RemovedReason: Equatable, Sendable {
    case revoked
    case unpaired
}

/// A request failure the UI can show as-is.
public enum RemoteRequestError: Error, Equatable, Sendable {
    /// The desktop answered `ok:false` (`not_found`, `conflict`, `refused`, …).
    case remote(code: String, message: String?)
    case notConnected
    /// Queued while reconnecting, but the workstation didn't come back within 60 s.
    case queueExpired
    /// The connection dropped before the desktop confirmed; it may or may not have run.
    case connectionLost
    case timeout
    case invalidResponse
    /// Over the 256 KiB device → desktop message cap.
    case tooLarge

    /// The desktop's per-device rate limit (`refused` / "rate limited"). Never auto-retried.
    public var isRateLimited: Bool {
        if case let .remote(code, message) = self { return code == "refused" && (message ?? "").lowercased().contains("rate limit") }
        return false
    }

    public var code: String? { if case .remote(let code, _) = self { return code }; return nil }
}

public struct ClientEnvironment {
    public var deviceName: () -> String
    public var deviceModel: String
    public var appVersion: String
    public var now: () -> Date

    public init(deviceName: @escaping () -> String, deviceModel: String, appVersion: String, now: @escaping () -> Date = Date.init) {
        self.deviceName = deviceName; self.deviceModel = deviceModel; self.appVersion = appVersion; self.now = now
    }
}

@MainActor
@Observable
public final class RemoteClient {
    public private(set) var status: ConnectionStatus
    public private(set) var fleet = FleetState()
    public private(set) var workstation: PairedWorkstation?
    public private(set) var queue = OfflineQueue()
    /// Wall time of the last snapshot/patch, for "Updated 12 s ago" while not live.
    public private(set) var lastUpdate: Date?
    /// Set when the workstation removed this device (kept after the pairing is cleared, for the explanation).
    public private(set) var removedWorkstationName: String?
    /// True while showing a simulated workstation (the in-app demo). No connection is made, no
    /// request leaves the device and the pairing store is never touched until `endSimulation()`.
    public private(set) var isSimulated = false

    /// Called for every `notify` (protocol §6).
    @ObservationIgnored public var onNotify: ((NotifyMessage) -> Void)?

    @ObservationIgnored private let pairing: PairingStore
    @ObservationIgnored private let env: ClientEnvironment
    @ObservationIgnored private var session: SecureSession?
    @ObservationIgnored private var loopTask: Task<Void, Never>?
    @ObservationIgnored private var loopGeneration = 0
    @ObservationIgnored private var pending: [String: Pending] = [:]
    @ObservationIgnored private var queueWaiters: [String: CheckedContinuation<Data, Error>] = [:]
    @ObservationIgnored private var pingCounter = 0
    @ObservationIgnored private var lastInbound = Date()
    @ObservationIgnored private var disconnectedSince: Date?
    @ObservationIgnored private var wakeSignal: CheckedContinuation<Void, Never>?

    public static let pingInterval: TimeInterval = 15
    public static let silenceTimeout: TimeInterval = 35
    public static let offlineAfter: TimeInterval = 30
    public static let requestTimeout: TimeInterval = 30
    /// The desktop answers `unavailable` beyond 16 requests in flight per connection.
    public static let maxInFlight = 16

    private struct Pending {
        let op: String
        let args: [String: JSONValue]
        let continuation: CheckedContinuation<Data, Error>
        let timeout: Task<Void, Never>
    }

    public init(store: SecretStore, environment: ClientEnvironment) {
        let pairingStore = PairingStore(store: store)
        let saved = pairingStore.workstation()
        pairing = pairingStore
        env = environment
        workstation = saved
        status = saved == nil ? .unpaired : .connecting
    }

    // MARK: Lifecycle

    /// Starts (or nudges) the connection loop. Safe to call repeatedly, e.g. on foreground.
    public func start() {
        guard !isSimulated else { return }
        guard workstation != nil else { status = .unpaired; return }
        if loopTask == nil {
            launchLoop(initial: nil)
        } else {
            wake()
        }
    }

    /// Retry immediately (pull-to-refresh, "Try again", app foreground).
    public func reconnectNow() {
        guard !isSimulated else { return }
        wake()
        start()
    }

    /// Validates a scanned/pasted link and performs the first handshake with the pairing code.
    public func pair(with payload: PairingPayload) async throws {
        guard let pk = payload.publicKey, let workstationKey = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: pk) else {
            throw PairingLinkError.invalidKey
        }
        guard !payload.isExpired(now: env.now()) else { throw PairingLinkError.expired }
        // A fresh identity for every pairing (a revoked key stays revoked). It is only persisted
        // once the workstation accepted it, so a failed attempt never disturbs a current pairing.
        let deviceKey = Curve25519.KeyAgreement.PrivateKey()
        let credentials = SecureSession.Credentials(deviceKey: deviceKey, workstationKey: workstationKey, hello: hello(pair: payload.code))
        let session = try await SecureSession.connectFirst(to: payload.addrs.compactMap(HostPort.init), credentials: credentials)
        do {
            // The desktop commits the pairing only after the encrypted hello.
            try session.send(.hello)
        } catch {
            session.close()
            throw error
        }
        let record = PairedWorkstation(
            wid: session.reply.wid ?? payload.wid,
            name: session.reply.name ?? payload.name,
            publicKey: pk,
            addrs: payload.addrs,
            deviceId: session.reply.deviceId,
            pairedAt: env.now(),
            host: session.reply.host
        )
        stopLoop()
        failPending()
        failQueue(with: .notConnected)
        pairing.clear()
        do {
            try pairing.save(deviceKey: deviceKey)
            try pairing.save(record)
        } catch {
            session.close()
            pairing.clear()
            workstation = nil
            fleet.reset()
            status = .unpaired
            throw error
        }
        workstation = record
        isSimulated = false
        removedWorkstationName = nil
        fleet.reset()
        lastUpdate = nil
        disconnectedSince = nil
        status = .connecting
        launchLoop(initial: session, helloSent: true)
    }

    private func launchLoop(initial: SecureSession?, helloSent: Bool = false) {
        loopGeneration += 1
        let generation = loopGeneration
        loopTask = Task { [weak self] in
            await self?.runLoop(initial: initial, helloSent: helloSent)
            guard let self, self.loopGeneration == generation else { return }
            self.loopTask = nil
        }
    }

    /// Forgets the workstation on this device.
    public func unpair() {
        stopLoop()
        pairing.clear()
        workstation = nil
        fleet.reset()
        lastUpdate = nil
        failQueue(with: .notConnected)
        status = .unpaired
    }

    /// Clears the Removed screen so the person can pair again.
    public func acknowledgeRemoval() {
        removedWorkstationName = nil
        if case .removed = status { status = .unpaired }
    }

    // MARK: Simulation

    /// Shows a simulated workstation: the in-app demo (and design-review fixtures in DEBUG).
    /// Stops any connection; the saved pairing stays untouched in the store. Requests through
    /// this client fail with `notConnected` while simulating — the app answers them locally.
    public func simulate(fleet: FleetState, status: ConnectionStatus, workstation: PairedWorkstation?) {
        stopLoop()
        isSimulated = true
        self.fleet = fleet
        self.status = status
        self.workstation = workstation
        lastUpdate = env.now()
    }

    /// Leaves the simulation and returns to the real pairing (or the welcome screen).
    public func endSimulation() {
        guard isSimulated else { return }
        isSimulated = false
        failQueue(with: .notConnected)
        fleet.reset()
        lastUpdate = nil
        workstation = pairing.workstation()
        status = workstation == nil ? .unpaired : .connecting
        start()
    }

    // MARK: Requests

    /// Runs an operation (protocol §5) and decodes its `result`.
    public func request<T: Decodable>(_ op: String, _ args: [String: JSONValue] = [:], as type: T.Type = T.self) async throws -> T {
        let raw = try await requestRaw(op, args)
        do {
            return try JSONDecoder.remote.decode(ResultEnvelope<T>.self, from: raw).result
        } catch {
            throw RemoteRequestError.invalidResponse
        }
    }

    public func requestRaw(_ op: String, _ args: [String: JSONValue] = [:]) async throws -> Data {
        let id = UUID().uuidString.lowercased()
        if status == .online {
            // A simulated workstation has no session; the app answers its requests locally.
            guard !isSimulated else { throw RemoteRequestError.notConnected }
            return try await sendNow(id: id, op: op, args: args)
        }
        // Only while Reconnecting (not Offline) may prompts and voice commands wait (§5).
        if status.isReconnecting && OfflineQueue.canQueue(op) {
            return try await enqueue(QueuedRequest(id: id, op: op, args: args, queuedAt: env.now()))
        }
        throw RemoteRequestError.notConnected
    }

    private func sendNow(id: String, op: String, args: [String: JSONValue]) async throws -> Data {
        // Stay under the desktop's in-flight cap instead of earning `unavailable`.
        while pending.count >= Self.maxInFlight, session != nil {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard let session else { throw RemoteRequestError.notConnected }
        return try await withCheckedThrowingContinuation { continuation in
            let timeout = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(Self.requestTimeout * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.finish(id: id, with: .failure(RemoteRequestError.timeout))
            }
            pending[id] = Pending(op: op, args: args, continuation: continuation, timeout: timeout)
            do {
                try session.send(.req(id: id, op: op, args: args))
            } catch {
                finish(id: id, with: .failure(RemoteRequestError.connectionLost))
            }
        }
    }

    private func enqueue(_ request: QueuedRequest) async throws -> Data {
        try await withCheckedThrowingContinuation { continuation in
            do {
                try queue.enqueue(request)
                queueWaiters[request.id] = continuation
                scheduleQueueExpiry()
            } catch {
                continuation.resume(throwing: RemoteRequestError.notConnected)
            }
        }
    }

    private func finish(id: String, with result: Result<Data, Error>) {
        guard let p = pending.removeValue(forKey: id) else { return }
        p.timeout.cancel()
        p.continuation.resume(with: result)
    }

    private func scheduleQueueExpiry() {
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64((OfflineQueue.ttl + 0.2) * 1_000_000_000))
            self?.expireQueue()
        }
    }

    private func expireQueue() {
        for item in queue.expire(now: env.now()) {
            queueWaiters.removeValue(forKey: item.id)?.resume(throwing: RemoteRequestError.queueExpired)
        }
    }

    private func failQueue(with error: RemoteRequestError) {
        for item in queue.removeAll() {
            queueWaiters.removeValue(forKey: item.id)?.resume(throwing: error)
        }
    }

    private func flushQueue() {
        let (send, expired) = queue.drain(now: env.now())
        for item in expired {
            queueWaiters.removeValue(forKey: item.id)?.resume(throwing: RemoteRequestError.queueExpired)
        }
        for item in send {
            guard let waiter = queueWaiters.removeValue(forKey: item.id) else { continue }
            Task { [weak self] in
                guard let self else { return }
                var attempt = 0
                while true {
                    do {
                        waiter.resume(returning: try await self.sendNow(id: item.id, op: item.op, args: item.args))
                        return
                    } catch let error as RemoteRequestError where error.code == "conflict" && attempt < 5 {
                        // The desktop is still running the first copy of this id; its stored
                        // result becomes available when it finishes. Never send a new id.
                        attempt += 1
                        try? await Task.sleep(nanoseconds: 1_000_000_000)
                    } catch {
                        waiter.resume(throwing: error)
                        return
                    }
                }
            }
        }
    }

    // MARK: Connection loop

    private func hello(pair code: String?) -> HandshakeHello {
        HandshakeHello(device: env.deviceName(), model: env.deviceModel, app: env.appVersion, pair: code, ts: Int(env.now().timeIntervalSince1970))
    }

    private func stopLoop() {
        loopGeneration += 1
        loopTask?.cancel()
        loopTask = nil
        session?.close()
        session = nil
        wake()
    }

    private func wake() {
        wakeSignal?.resume()
        wakeSignal = nil
    }

    private func sleep(_ seconds: TimeInterval) async {
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            wakeSignal?.resume()
            wakeSignal = cont
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
                self?.wake()
            }
        }
    }

    private func runLoop(initial: SecureSession? = nil, helloSent: Bool = false) async {
        var initialHelloSent = helloSent
        var backoff = Backoff()
        var next = initial
        while !Task.isCancelled, let ws = workstation {
            do {
                let session: SecureSession
                if let ready = next {
                    session = ready
                    next = nil
                } else {
                    let deviceKey = try pairing.deviceKey()
                    let key = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: ws.publicKey)
                    session = try await SecureSession.connectFirst(
                        to: ws.endpoints,
                        credentials: .init(deviceKey: deviceKey, workstationKey: key, hello: hello(pair: nil))
                    )
                }
                if Task.isCancelled { session.close(); return }
                backoff.reset()
                let skipHello = initialHelloSent
                initialHelloSent = false
                try await run(session, helloSent: skipHello)
            } catch let rejection as HandshakeRejection {
                if handle(rejection) { return }
            } catch let bye as ByeReceived {
                if handle(bye) { return }
            } catch {
                // Network error, silence, decrypt failure or rev gap: reconnect.
            }
            if Task.isCancelled { return }
            connectionLost()
            await sleep(backoff.next())
        }
    }

    private struct ByeReceived: Error { let reason: String }
    private struct RevGap: Error {}
    private struct Silence: Error {}

    /// Runs one live session until it ends. Throws why it ended.
    private func run(_ session: SecureSession, helloSent: Bool = false) async throws {
        self.session = session
        defer {
            session.close()
            if self.session === session { self.session = nil }
        }
        if var ws = workstation, let name = session.reply.name, name != ws.name || session.reply.host != ws.host {
            ws.name = name
            ws.host = session.reply.host ?? ws.host
            try? pairing.save(ws)
            workstation = ws
        }
        lastInbound = env.now()
        if !helloSent { try session.send(.hello) }

        let keepalive = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                guard let self, !Task.isCancelled else { return }
                if self.env.now().timeIntervalSince(self.lastInbound) >= Self.silenceTimeout {
                    session.close()  // unblocks the reader; the loop reconnects
                    return
                }
                self.maybePing(session)
            }
        }
        defer { keepalive.cancel() }

        while !Task.isCancelled {
            let message = try await session.receive()
            lastInbound = env.now()
            switch message {
            case let .snapshot(rev, state):
                fleet.apply(snapshot: state, rev: rev)
                lastUpdate = env.now()
                if status != .online {
                    status = .online
                    disconnectedSince = nil
                    flushQueue()
                }
            case let .patch(patch):
                guard fleet.hasSnapshot else { throw RevGap() }
                if case .gap = fleet.apply(patch: patch) { throw RevGap() }
                lastUpdate = env.now()
            case let .res(id, ok, error, raw):
                if ok {
                    finish(id: id, with: .success(raw))
                } else {
                    finish(id: id, with: .failure(RemoteRequestError.remote(code: error?.code ?? "internal", message: error?.message)))
                }
            case let .notify(note):
                onNotify?(note)
            case .pong:
                break
            case let .bye(reason):
                throw ByeReceived(reason: reason)
            case .unknown:
                break
            }
        }
    }

    @ObservationIgnored private var lastPingSent = Date.distantPast

    private func maybePing(_ session: SecureSession) {
        guard env.now().timeIntervalSince(lastPingSent) >= Self.pingInterval else { return }
        lastPingSent = env.now()
        pingCounter += 1
        try? session.send(.ping(n: pingCounter))
    }

    /// Moves the UI to Reconnecting/Offline after a drop and re-queues in-flight prompts.
    private func connectionLost() {
        let now = env.now()
        if disconnectedSince == nil { disconnectedSince = now }
        // In-flight requests: prompts/voice go back to the queue with the same id (the desktop
        // dedupes by id); anything else is reported as unconfirmed.
        for (id, p) in pending {
            p.timeout.cancel()
            if OfflineQueue.canQueue(p.op) {
                try? queue.enqueue(QueuedRequest(id: id, op: p.op, args: p.args, queuedAt: now))
                queueWaiters[id] = p.continuation
                scheduleQueueExpiry()
            } else {
                p.continuation.resume(throwing: RemoteRequestError.connectionLost)
            }
        }
        pending.removeAll()

        switch status {
        case .online:
            status = .reconnecting(since: now)
        case .reconnecting(let start):
            if now.timeIntervalSince(start) >= Self.offlineAfter {
                status = .offline(.unreachable)
                failQueue(with: .notConnected)
            }
        case .connecting:
            if now.timeIntervalSince(disconnectedSince ?? now) >= Self.offlineAfter {
                status = .offline(.unreachable)
            }
        default:
            break
        }
    }

    /// Returns true when the loop must stop.
    private func handle(_ rejection: HandshakeRejection) -> Bool {
        switch rejection {
        case .revoked, .unpaired:
            markRemoved(rejection == .revoked ? .revoked : .unpaired)
            return true
        case .notEntitled:
            status = .offline(.notEntitled)
            failQueue(with: .notConnected)
            return false
        case .version:
            status = .offline(.versionMismatch)
            failQueue(with: .notConnected)
            return true
        case .invalid:
            status = .offline(.invalidHello)
            failQueue(with: .notConnected)
            return true
        case .pairingExpired, .busy, .unknown:
            return false
        }
    }

    private func handle(_ bye: ByeReceived) -> Bool {
        switch bye.reason {
        case "revoked":
            markRemoved(.revoked)
            return true
        case "disabled":
            status = .offline(.disabled)
        case "replaced":
            // Another session from this device took over; don't fight it with a reconnect loop.
            status = .offline(.replaced)
            disconnectedSince = env.now()
            failQueue(with: .notConnected)
            failPending()
            return true
        case "not_entitled":
            status = .offline(.notEntitled)
        default:
            status = .offline(.shutdown)
        }
        disconnectedSince = env.now()
        failQueue(with: .notConnected)
        failPending()
        return false
    }

    private func failPending() {
        for (_, p) in pending {
            p.timeout.cancel()
            p.continuation.resume(throwing: RemoteRequestError.connectionLost)
        }
        pending.removeAll()
    }

    private func markRemoved(_ reason: RemovedReason) {
        removedWorkstationName = workstation?.name
        failPending()
        failQueue(with: .notConnected)
        session?.close()
        session = nil
        pairing.clear()
        workstation = nil
        fleet.reset()
        lastUpdate = nil
        status = .removed(reason)
    }
}
