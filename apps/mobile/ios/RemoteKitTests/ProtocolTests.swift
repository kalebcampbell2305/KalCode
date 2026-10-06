import XCTest
@testable import RemoteKit

final class FramingTests: XCTestCase {
    func testFrameHasBigEndianLengthPrefix() throws {
        let f = try Framing.frame(Data(repeating: 7, count: 0x0102))
        XCTAssertEqual(Array(f.prefix(2)), [0x01, 0x02])
        XCTAssertEqual(f.count, 0x0102 + 2)
        XCTAssertThrowsError(try Framing.frame(Data(count: 65536)))
    }

    func testFrameReaderHandlesSplitAndCoalescedBytes() throws {
        let a = try Framing.frame(Data("first".utf8)), b = try Framing.frame(Data("second".utf8))
        var reader = FrameReader()
        let all = a + b
        reader.push(all.prefix(3))
        XCTAssertNil(try reader.next())
        reader.push(all.dropFirst(3))
        XCTAssertEqual(try reader.next(), Data("first".utf8))
        XCTAssertEqual(try reader.next(), Data("second".utf8))
        XCTAssertNil(try reader.next())
    }

    func testAppMessagesSplitAcrossFramesAtTheLimit() throws {
        let json = Data(repeating: 0x61, count: 200_000)
        let chunks = try Framing.appMessageChunks(json)
        XCTAssertEqual(chunks.count, 4)
        XCTAssertTrue(chunks.allSatisfy { $0.count <= Framing.maxPlaintextPerFrame })
        XCTAssertEqual(Array(chunks[0].prefix(4)), [0x00, 0x03, 0x0d, 0x40])
        var assembler = AppMessageAssembler()
        var out: [Data] = []
        for c in chunks { out += try assembler.push(c) }
        XCTAssertEqual(out, [json])
        XCTAssertEqual(assembler.bufferedByteCount, 0)
    }

    func testSeveralSmallMessagesInOneFrame() throws {
        let m1 = try Framing.appMessageChunks(Data("{\"t\":\"pong\",\"n\":1}".utf8))[0]
        let m2 = try Framing.appMessageChunks(Data("{\"t\":\"pong\",\"n\":2}".utf8))[0]
        var assembler = AppMessageAssembler()
        XCTAssertEqual(try assembler.push(m1 + m2.prefix(5)).count, 1)
        XCTAssertEqual(try assembler.push(m2.dropFirst(5)).count, 1)
    }

    func testOversizedAppMessageIsRejected() {
        var assembler = AppMessageAssembler()
        XCTAssertThrowsError(try assembler.push(Data([0x7f, 0xff, 0xff, 0xff])))
        XCTAssertThrowsError(try Framing.appMessageChunks(Data(count: Framing.maxAppMessageLen + 1)))
    }

    func testEncryptedMessageRoundTripThroughFrames() throws {
        var (device, host) = try NoiseTests.pair()
        let json = Data(repeating: 0x7b, count: 150_000)
        var assembler = AppMessageAssembler()
        var received: [Data] = []
        for chunk in try Framing.appMessageChunks(json) {
            let frame = try Framing.frame(try device.encrypt(chunk))
            var reader = FrameReader()
            reader.push(frame)
            received += try assembler.push(try host.decrypt(try XCTUnwrap(try reader.next())))
        }
        XCTAssertEqual(received, [json])
    }
}

final class MessageTests: XCTestCase {
    func testDecodesSnapshotWithLenientFields() throws {
        let json = """
        {"t":"snapshot","rev":1,"state":{"workstation":{"id":"ws_1","name":"Kaleb's Workstation","platform":"windows","version":"0.1.9","build":2007,"activeWorkspaceId":"wsp_1"},
        "workspaces":[{"id":"wsp_1","name":"KalCode","path":"C:/KalCode","lastActiveAt":"2026-10-06T12:00:00.123456789Z"}],
        "agents":[{"id":"thr_1","name":"Fix login","state":"working","providerName":"Claude Code","model":"claude-opus-5-5","effort":"high","createdAt":"2026-10-06T12:00:00Z","lastActivityAt":"2026-10-06T12:01:00+00:00","filesChanged":4},
                  {"id":"thr_2","state":"something_new"},{"broken":true}],
        "needsYou":[{"id":"approval:apr_1","kind":"approval","title":"Run cargo test?","approvalId":"apr_1","agentId":"thr_1","actions":["approve_once","deny","open"]}],
        "runs":[],"services":[],"environments":[]}}
        """
        guard case let .snapshot(rev, state) = try InboundMessage.decode(Data(json.utf8)) else { return XCTFail() }
        XCTAssertEqual(rev, 1)
        XCTAssertEqual(state.agents.count, 2, "the malformed agent is dropped, not the snapshot")
        XCTAssertEqual(state.agents[0].state, .working)
        XCTAssertEqual(state.agents[1].state, .unknown)
        XCTAssertEqual(state.agents[0].lastActivityAt?.timeIntervalSince(state.agents[0].createdAt!), 60)
        XCTAssertEqual(state.workspaces[0].lastActiveAt?.timeIntervalSince1970 ?? 0, 1791288000.123, accuracy: 0.001)
        XCTAssertTrue(state.needsYou[0].canApprove)
    }

    func testDecodesResErrorAndResult() throws {
        let ok = try InboundMessage.decode(Data(#"{"t":"res","id":"a","ok":true,"result":{"summary":"Sent"}}"#.utf8))
        guard case let .res(id, isOk, _, raw) = ok else { return XCTFail() }
        XCTAssertEqual(id, "a"); XCTAssertTrue(isOk)
        XCTAssertEqual(try JSONDecoder.remote.decode(ResultEnvelope<SummaryResult>.self, from: raw).result.summary, "Sent")

        let bad = try InboundMessage.decode(Data(#"{"t":"res","id":"b","ok":false,"error":{"code":"not_found","message":"gone"}}"#.utf8))
        guard case let .res(_, false, err, _) = bad else { return XCTFail() }
        XCTAssertEqual(err?.code, "not_found")
    }

    func testDiffLineKinds() throws {
        let json = #"{"files":[{"path":"a.rs","status":"modified","additions":1,"deletions":1,"hunks":[{"header":"@@ -1 +1 @@","lines":[["-","old"],["+","new"],[" ","ctx"],["add","x"]]}]}],"truncated":false}"#
        let diff = try JSONDecoder.remote.decode(AgentDiff.self, from: Data(json.utf8))
        XCTAssertEqual(diff.files[0].hunks[0].lines.map(\.kind), [.delete, .add, .context, .add])
    }

    func testOutboundEncoding() throws {
        let req = try OutboundMessage.req(id: "x", op: "agent.prompt", args: ["agentId": "thr_1", "text": "hi"]).encoded()
        XCTAssertEqual(String(data: req, encoding: .utf8), #"{"args":{"agentId":"thr_1","text":"hi"},"id":"x","op":"agent.prompt","t":"req"}"#)
        XCTAssertEqual(String(data: try OutboundMessage.ping(n: 3).encoded(), encoding: .utf8), #"{"n":3,"t":"ping"}"#)
    }
}

final class FleetStateTests: XCTestCase {
    private func snapshot(_ agents: [Agent]) -> FleetSnapshot { FleetSnapshot(agents: agents) }

    func testSnapshotReplacesEverything() {
        var s = FleetState()
        s.apply(snapshot: snapshot([Agent(id: "a"), Agent(id: "b")]), rev: 1)
        s.apply(snapshot: snapshot([Agent(id: "c")]), rev: 1)
        XCTAssertEqual(s.agents.map(\.id), ["c"])
        XCTAssertEqual(s.rev, 1)
    }

    func testPatchUpsertsAndRemovesInOrder() {
        var s = FleetState()
        s.apply(snapshot: snapshot([Agent(id: "a", state: .working), Agent(id: "b")]), rev: 1)
        let r = s.apply(patch: FleetPatch(rev: 2, upsert: FleetUpsert(agents: [Agent(id: "a", state: .done), Agent(id: "z")]), remove: FleetRemove(agents: ["b"])))
        XCTAssertEqual(r, .applied)
        XCTAssertEqual(s.agents.map(\.id), ["a", "z"])
        XCTAssertEqual(s.agent("a")?.state, .done)
        XCTAssertEqual(s.rev, 2)
    }

    func testRevGapIsDetectedAndNotApplied() {
        var s = FleetState()
        s.apply(snapshot: snapshot([Agent(id: "a")]), rev: 5)
        XCTAssertEqual(s.apply(patch: FleetPatch(rev: 7, remove: FleetRemove(agents: ["a"]))), .gap(expected: 6, received: 7))
        XCTAssertEqual(s.agents.count, 1)
        XCTAssertEqual(s.apply(patch: FleetPatch(rev: 5)), .gap(expected: 6, received: 5), "a repeat is a gap too")
        var empty = FleetState()
        XCTAssertEqual(empty.apply(patch: FleetPatch(rev: 1)), .gap(expected: nil, received: 1), "no snapshot yet")
    }

    func testFiltersAndStableSort() {
        var s = FleetState()
        let t = Date(timeIntervalSince1970: 1000)
        s.apply(snapshot: snapshot([
            Agent(id: "done", state: .done, createdAt: t),
            Agent(id: "w1", state: .working, createdAt: t),
            Agent(id: "w2", state: .testing, createdAt: t.addingTimeInterval(5)),
            Agent(id: "ny", state: .needsYou, createdAt: t),
            Agent(id: "f", state: .failed, createdAt: t),
            Agent(id: "idle", state: .idle, pendingApprovals: 1, createdAt: t),
        ]), rev: 1)
        XCTAssertEqual(s.sortedAgents().map(\.id), ["ny", "f", "w2", "w1", "idle", "done"])
        XCTAssertEqual(s.count(.working), 2)
        XCTAssertEqual(s.sortedAgents(.needsYou).map(\.id), ["ny", "idle"])
        XCTAssertEqual(s.count(.failed), 1)
        XCTAssertEqual(s.count(.done), 1)
    }
}

final class OfflineQueueTests: XCTestCase {
    let t0 = Date(timeIntervalSince1970: 0)

    func testOnlyPromptAndVoiceAreQueueable() {
        var q = OfflineQueue()
        XCTAssertNoThrow(try q.enqueue(QueuedRequest(id: "1", op: "agent.prompt", args: [:], queuedAt: t0)))
        XCTAssertNoThrow(try q.enqueue(QueuedRequest(id: "2", op: "voice.command", args: [:], queuedAt: t0)))
        for op in ["agent.stop", "agent.retry", "needs.decide", "agent.launch", "tidy.closeIdle", "agent.detail"] {
            XCTAssertThrowsError(try q.enqueue(QueuedRequest(id: op, op: op, args: [:], queuedAt: t0)))
        }
        XCTAssertEqual(q.items.count, 2)
    }

    func testExpiresAfterSixtySeconds() {
        var q = OfflineQueue()
        try? q.enqueue(QueuedRequest(id: "old", op: "agent.prompt", args: [:], queuedAt: t0))
        try? q.enqueue(QueuedRequest(id: "new", op: "agent.prompt", args: [:], queuedAt: t0.addingTimeInterval(30)))
        XCTAssertEqual(q.expire(now: t0.addingTimeInterval(59.9)).count, 0)
        XCTAssertEqual(q.expire(now: t0.addingTimeInterval(60)).map(\.id), ["old"])
        let (send, expired) = q.drain(now: t0.addingTimeInterval(61))
        XCTAssertEqual(send.map(\.id), ["new"])
        XCTAssertTrue(expired.isEmpty)
        XCTAssertTrue(q.isEmpty)
    }

    func testRequeueKeepsOriginalIdOnce() {
        var q = OfflineQueue()
        try? q.enqueue(QueuedRequest(id: "same", op: "agent.prompt", args: ["text": "a"], queuedAt: t0))
        try? q.enqueue(QueuedRequest(id: "same", op: "agent.prompt", args: ["text": "a"], queuedAt: t0.addingTimeInterval(1)))
        XCTAssertEqual(q.items.map(\.id), ["same"])
    }

    func testBackoffDoublesToTenSeconds() {
        var b = Backoff()
        XCTAssertEqual((0..<7).map { _ in b.next() }, [0.5, 1, 2, 4, 8, 10, 10])
        b.reset()
        XCTAssertEqual(b.next(), 0.5)
    }
}

final class LinkTests: XCTestCase {
    func makeLink(exp: Int = 4_000_000_000, addrs: [String] = ["127.0.0.1:47820"]) -> String {
        let payload = PairingPayload(v: 1, wid: "ws_1", name: "Kaleb's Workstation",
                                     pk: Data(repeating: 9, count: 32).base64EncodedString(),
                                     code: Data(repeating: 1, count: 32).base64EncodedString(), addrs: addrs, exp: exp)
        return "kalcode-remote://pair?d=" + Base64.urlEncode(try! JSONEncoder().encode(payload))
    }

    func testParsesPairingLink() throws {
        let p = try PairingLink.parse("  " + makeLink() + "\n")
        XCTAssertEqual(p.name, "Kaleb's Workstation")
        XCTAssertEqual(p.publicKey?.count, 32)
        XCTAssertEqual(HostPort("127.0.0.1:47820"), HostPort("127.0.0.1:47820"))
    }

    func testRejectsBadPairingLinks() {
        XCTAssertThrowsError(try PairingLink.parse("https://example.com")) { XCTAssertEqual($0 as? PairingLinkError, .notAPairingLink) }
        XCTAssertThrowsError(try PairingLink.parse("kalcode-remote://pair?d=%%%")) { XCTAssertEqual($0 as? PairingLinkError, .malformed) }
        XCTAssertThrowsError(try PairingLink.parse(makeLink(exp: 10))) { XCTAssertEqual($0 as? PairingLinkError, .expired) }
        XCTAssertThrowsError(try PairingLink.parse(makeLink(addrs: ["nope"]))) { XCTAssertEqual($0 as? PairingLinkError, .noAddresses) }
    }

    func testDeepLinks() {
        XCTAssertEqual(DeepLink(string: "kalcode-remote://agent/thr_1"), .agent("thr_1"))
        XCTAssertEqual(DeepLink(string: "kalcode-remote://needs/approval:apr_1"), .needs("approval:apr_1"))
        XCTAssertEqual(DeepLink(string: "kalcode-remote://run/op_9"), .run("op_9"))
        XCTAssertEqual(DeepLink(string: "kalcode-remote://diff/thr_1"), .diff("thr_1"))
        XCTAssertEqual(DeepLink(string: "kalcode-remote://fleet"), .fleet)
        XCTAssertNil(DeepLink(string: "kalcode-remote://agent/"))
        XCTAssertNil(DeepLink(string: "https://agent/thr_1"))
        XCTAssertEqual(DeepLink(userInfo: ["kc": ["link": "kalcode-remote://agent/x", "wid": "ws"]]), .agent("x"))
    }

    func testRFC3339Variants() {
        XCTAssertEqual(RFC3339.parse("2026-10-06T12:00:00Z")?.timeIntervalSince1970, 1791288000)
        XCTAssertEqual(RFC3339.parse("2026-10-06T08:00:00-04:00")?.timeIntervalSince1970, 1791288000)
        XCTAssertEqual(RFC3339.parse("2026-10-06T12:00:00.5Z")?.timeIntervalSince1970, 1791288000.5)
        XCTAssertNil(RFC3339.parse("yesterday"))
    }
}
