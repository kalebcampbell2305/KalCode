import CryptoKit
import Network
import XCTest
@testable import RemoteKit

/// RemoteClient against an in-process Noise IK host over real TCP on 127.0.0.1: pairing,
/// snapshot/patch, rev-gap reconnect, the offline queue across a drop, revocation and
/// handshake rejections. (Interop with the Rust host is covered by RemoteProbe + the UI tests.)
final class LoopbackHost: @unchecked Sendable {
    let key = Curve25519.KeyAgreement.PrivateKey()
    private(set) var port: UInt16 = 0
    private let listener: NWListener
    private let lock = NSLock()
    private var _connections = 0
    private var _reject: String?
    var script: (Int, SecureSession) async throws -> Void = { _, _ in }
    var acceptDelay: (Int) -> TimeInterval = { _ in 0 }

    var connections: Int { lock.lock(); defer { lock.unlock() }; return _connections }
    var reject: String? {
        get { lock.lock(); defer { lock.unlock() }; return _reject }
        set { lock.lock(); _reject = newValue; lock.unlock() }
    }

    init() throws {
        listener = try NWListener(using: .tcp, on: .any)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { if case .ready = $0 { ready.signal() } }
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            Task { await self.serve(conn) }
        }
        listener.start(queue: .global())
        _ = ready.wait(timeout: .now() + 5)
        port = listener.port?.rawValue ?? 0
    }

    deinit { listener.cancel() }

    func pairingPayload() -> PairingPayload {
        PairingPayload(v: 1, wid: "ws_test", name: "Loopback Workstation", pk: key.publicKey.rawRepresentation.base64EncodedString(),
                       code: Data(repeating: 7, count: 32).base64EncodedString(), addrs: ["127.0.0.1:\(port)"],
                       exp: Int(Date().timeIntervalSince1970) + 300)
    }

    private func serve(_ nw: NWConnection) async {
        lock.lock(); _connections += 1; let n = _connections; lock.unlock()
        let conn = FramedConnection(accepted: nw, endpoint: HostPort("127.0.0.1:\(port)")!)
        do {
            try await conn.open()
            let delay = acceptDelay(n)
            if delay > 0 { try await Task.sleep(nanoseconds: UInt64(delay * 1e9)) }
            var responder = NoiseIKResponder(staticKey: key)
            _ = try responder.readMessage1(try await conn.readFrame())
            let rejection = reject
            let reply: JSONValue = rejection.map { ["ok": false, "error": .string($0)] }
                ?? ["ok": true, "wid": "ws_test", "name": "Loopback Workstation", "deviceId": "dev_1",
                    "host": ["platform": "macos", "version": "0.1.9", "build": 2007]]
            let (m2, transport) = try responder.writeMessage2(payload: try JSONEncoder().encode(reply))
            try conn.send(frame: m2)
            if rejection != nil { try await Task.sleep(nanoseconds: 200_000_000); conn.close(); return }
            let session = SecureSession(connection: conn, transport: transport, reply: HandshakeReply(ok: true))
            try await script(n, session)
        } catch {}
        conn.close()
    }
}

extension HandshakeReply {
    init(ok: Bool) { self.init(ok: ok, error: nil, wid: nil, name: nil, deviceId: nil, host: nil) }
}

extension SecureSession {
    func host(_ value: JSONValue) throws { try sendJSON(try JSONEncoder().encode(value)) }
    func nextJSON() async throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: try await receiveRaw()) }
    /// Reads until a message of type `t` (answers pings on the way).
    func expect(_ t: String) async throws -> JSONValue {
        while true {
            let m = try await nextJSON()
            if m["t"]?.stringValue == "ping" { try host(["t": "pong", "n": m["n"] ?? 0]); continue }
            if m["t"]?.stringValue == t { return m }
        }
    }
}

func loopbackSnapshot(rev: Int, agents: Int) -> JSONValue {
    let list: [JSONValue] = (0..<agents).map { ["id": .string("thr_\($0)"), "name": .string("Agent \($0)"), "state": "working"] }
    return ["t": "snapshot", "rev": .number(Double(rev)),
            "state": ["workstation": ["id": "ws_test", "name": "Loopback Workstation"], "agents": .array(list)]]
}

final class IDLog: @unchecked Sendable {
    private var ids: [String] = []
    private let lock = NSLock()
    func add(_ id: String) { lock.lock(); ids.append(id); lock.unlock() }
    var all: [String] { lock.lock(); defer { lock.unlock() }; return ids }
}

@MainActor
final class LoopbackClientTests: XCTestCase {
    private func makeClient() -> RemoteClient {
        RemoteClient(store: MemorySecretStore(), environment: ClientEnvironment(deviceName: { "Test" }, deviceModel: "test", appVersion: "1.0 (1)"))
    }

    private func until(_ what: String, timeout: TimeInterval = 8, _ condition: () -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > end { XCTFail("timed out waiting for \(what)"); throw CancellationError() }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    func testPairSnapshotPatchThenRevGapReconnectsToFreshSnapshot() async throws {
        let host = try LoopbackHost()
        host.script = { n, s in
            _ = try await s.expect("hello")
            if n == 1 {
                try s.host(loopbackSnapshot(rev: 1, agents: 2))
                try s.host(["t": "patch", "rev": 2, "upsert": ["agents": [["id": "thr_0", "state": "done"]]]])
                try await Task.sleep(nanoseconds: 300_000_000)
                try s.host(["t": "patch", "rev": 4, "remove": ["agents": ["thr_1"]]])  // gap
            } else {
                try s.host(loopbackSnapshot(rev: 1, agents: 3))
            }
            _ = try await s.expect("never")
        }
        let client = makeClient()
        try await client.pair(with: host.pairingPayload())
        XCTAssertEqual(client.workstation?.deviceId, "dev_1")
        try await until("first snapshot + patch") { client.fleet.agent("thr_0")?.state == .done }
        try await until("reconnect after rev gap") { host.connections == 2 && client.fleet.agents.count == 3 }
        XCTAssertEqual(client.status, .online)
        XCTAssertNotNil(client.fleet.agent("thr_1"), "the gap patch was never applied; state came from the new snapshot")
        client.unpair()
    }

    func testPromptInFlightAtDropIsRequeuedWithSameIdAndOtherActionsNeedLiveConnection() async throws {
        let host = try LoopbackHost()
        let ids = IDLog()
        host.acceptDelay = { $0 == 2 ? 1.5 : 0 }
        host.script = { n, s in
            _ = try await s.expect("hello")
            try s.host(loopbackSnapshot(rev: 1, agents: 1))
            if n == 1 {
                let req = try await s.expect("req")
                ids.add(req["id"]?.stringValue ?? "?")
                return  // drop the connection without answering
            }
            for _ in 0..<2 {
                let req = try await s.expect("req")
                ids.add(req["id"]?.stringValue ?? "?")
                try s.host(["t": "res", "id": req["id"] ?? nil, "ok": true,
                            "result": ["summary": .string("done " + (req["op"]?.stringValue ?? ""))]])
            }
            _ = try await s.expect("never")
        }
        let client = makeClient()
        try await client.pair(with: host.pairingPayload())
        try await until("online") { client.status == .online }

        let prompt = Task { () -> SummaryResult in try await client.request("agent.prompt", ["agentId": "thr_0", "text": "hi"]) }
        try await until("reconnecting") { client.status.isReconnecting }
        do {
            let _: SummaryResult = try await client.request("agent.stop", ["agentId": "thr_0"])
            XCTFail("stop must not queue")
        } catch { XCTAssertEqual(error as? RemoteRequestError, .notConnected) }
        let voice = Task { () -> SummaryResult in try await client.request("voice.command", ["text": "status"]) }
        try await until("both queued") { client.queue.items.count == 2 }
        XCTAssertEqual(client.queue.items.first?.op, "agent.prompt")

        let promptResult = try await prompt.value
        let voiceResult = try await voice.value
        XCTAssertEqual(promptResult.summary, "done agent.prompt")
        XCTAssertEqual(voiceResult.summary, "done voice.command")
        let seen = ids.all
        XCTAssertEqual(seen.count, 3)
        XCTAssertEqual(seen.first, seen.dropFirst().first, "the re-sent prompt keeps its original request id")
        XCTAssertTrue(client.queue.isEmpty)
        client.unpair()
    }

    func testByeRevokedRemovesPairing() async throws {
        let host = try LoopbackHost()
        host.script = { _, s in
            _ = try await s.expect("hello")
            try s.host(loopbackSnapshot(rev: 1, agents: 1))
            try await Task.sleep(nanoseconds: 300_000_000)
            try s.host(["t": "bye", "reason": "revoked"])
            try await Task.sleep(nanoseconds: 300_000_000)
        }
        let client = makeClient()
        try await client.pair(with: host.pairingPayload())
        try await until("removed") { client.status == .removed(.revoked) }
        XCTAssertNil(client.workstation)
        XCTAssertTrue(client.fleet.agents.isEmpty, "no state survives revocation")
        XCTAssertEqual(client.removedWorkstationName, "Loopback Workstation")
    }

    func testHandshakeRejectionSurfacesAndDoesNotPair() async throws {
        let host = try LoopbackHost()
        host.reject = "pairing_expired"
        let client = makeClient()
        do {
            try await client.pair(with: host.pairingPayload())
            XCTFail("expected rejection")
        } catch { XCTAssertEqual(error as? HandshakeRejection, .pairingExpired) }
        XCTAssertNil(client.workstation)
        XCTAssertEqual(client.status, .unpaired)
    }

    func testRevokedOnReconnectHandshakeShowsRemoved() async throws {
        let host = try LoopbackHost()
        host.script = { _, s in
            _ = try await s.expect("hello")
            try s.host(loopbackSnapshot(rev: 1, agents: 1))
            host.reject = "revoked"   // the next handshake is refused; this connection then drops
        }
        let client = makeClient()
        try await client.pair(with: host.pairingPayload())
        try await until("removed after rejected reconnect") { client.status == .removed(.revoked) }
        XCTAssertNil(client.workstation)
    }
}
