import Foundation

/// Handshake payloads (protocol §3).
public struct HandshakeHello: Encodable, Sendable {
    public var v = 1
    public var device: String
    public var platform = "ios"
    public var model: String
    public var app: String
    public var pair: String?
    public var ts: Int

    public init(device: String, model: String, app: String, pair: String?, ts: Int) {
        self.device = Self.clean(device, fallback: "iPhone"); self.model = Self.clean(model, fallback: "iOS")
        self.app = Self.clean(app, fallback: "1.0"); self.pair = pair; self.ts = ts
    }

    /// The desktop rejects hello fields over 64 characters or with control characters (`invalid`).
    public static let maxFieldLength = 64

    static func clean(_ value: String, fallback: String) -> String {
        let scalars = value.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        var text = String(String.UnicodeScalarView(scalars)).trimmingCharacters(in: .whitespaces)
        // Truncate by characters, then make sure the UTF-16/scalar count fits too.
        if text.count > maxFieldLength { text = String(text.prefix(maxFieldLength)) }
        while text.unicodeScalars.count > maxFieldLength { text.removeLast() }
        return text.isEmpty ? fallback : text
    }
}

public struct HostInfo: Codable, Equatable, Sendable {
    public var platform: String?
    public var version: String?
    public var build: Int?
}

public struct HandshakeReply: Decodable, Equatable, Sendable {
    public var ok: Bool
    public var error: String?
    public var wid: String?
    public var name: String?
    public var deviceId: String?
    public var host: HostInfo?
}

/// Why the desktop refused a handshake. All of these come from an authenticated desktop (only the
/// pinned key can produce a decryptable reply), so the phone can trust them.
public enum HandshakeRejection: String, Error, Sendable {
    case unpaired, revoked
    case pairingExpired = "pairing_expired"
    case notEntitled = "not_entitled"
    case busy, version, invalid, unknown

    public init(code: String?) { self = HandshakeRejection(rawValue: code ?? "") ?? .unknown }

    /// Definitive answers end the attempt; `busy`/`unknown` are retried.
    public var isDefinitive: Bool { self != .busy && self != .unknown }
}

/// `error` of a failed `res`.
public struct RemoteErrorPayload: Codable, Equatable, Sendable {
    public var code: String
    public var message: String?
}

public struct NotifyMessage: Decodable, Equatable, Sendable {
    public var id: String
    public var kind: String?
    public var title: String?
    public var body: String?
    public var link: String?
}

/// Every desktop → device message.
public enum InboundMessage: Sendable {
    case snapshot(rev: Int, state: FleetSnapshot)
    case patch(FleetPatch)
    /// `raw` is the whole message; the waiting request decodes `result` with its own type.
    case res(id: String, ok: Bool, error: RemoteErrorPayload?, raw: Data)
    case notify(NotifyMessage)
    case pong(n: Int)
    case bye(reason: String)
    case unknown(type: String)

    private struct Envelope: Decodable { var t: String }
    private struct SnapshotEnvelope: Decodable { var rev: Int; var state: FleetSnapshot }
    private struct ResEnvelope: Decodable { var id: String; var ok: Bool; var error: RemoteErrorPayload? }
    private struct PongEnvelope: Decodable { var n: Int }
    private struct ByeEnvelope: Decodable { var reason: String? }

    public static func decode(_ data: Data) throws -> InboundMessage {
        let decoder = JSONDecoder.remote
        let type = try decoder.decode(Envelope.self, from: data).t
        switch type {
        case "snapshot":
            let s = try decoder.decode(SnapshotEnvelope.self, from: data)
            return .snapshot(rev: s.rev, state: s.state)
        case "patch":
            return .patch(try decoder.decode(FleetPatch.self, from: data))
        case "res":
            let r = try decoder.decode(ResEnvelope.self, from: data)
            return .res(id: r.id, ok: r.ok, error: r.error, raw: data)
        case "notify":
            return .notify(try decoder.decode(NotifyMessage.self, from: data))
        case "pong":
            return .pong(n: try decoder.decode(PongEnvelope.self, from: data).n)
        case "bye":
            return .bye(reason: (try? decoder.decode(ByeEnvelope.self, from: data).reason) ?? "shutdown")
        default:
            return .unknown(type: type)
        }
    }
}

/// Every device → desktop message.
public enum OutboundMessage: Sendable {
    /// Device → desktop messages are capped at 256 KiB (the desktop closes on larger ones).
    public static let maxEncodedSize = 256 * 1024

    case hello
    case req(id: String, op: String, args: [String: JSONValue])
    case ping(n: Int)

    public func encoded() throws -> Data {
        let value: JSONValue
        switch self {
        case .hello: value = ["t": "hello"]
        case let .req(id, op, args): value = ["t": "req", "id": .string(id), "op": .string(op), "args": .object(args)]
        case let .ping(n): value = ["t": "ping", "n": .number(Double(n))]
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(value)
    }
}

// MARK: - Operation results (protocol §5)

public struct ResultEnvelope<T: Decodable>: Decodable { public var result: T }

public struct SummaryResult: Decodable, Equatable, Sendable {
    public var summary: String?
    public var agentId: String?
    public var outcome: String?
    public var status: String?
}

public struct AgentMessage: Decodable, Equatable, Hashable, Sendable {
    public var role: String?
    public var text: String?
    public var at: Date?
}

public struct AgentToolCall: Decodable, Equatable, Hashable, Sendable {
    public var name: String?
    public var summary: String?
    public var status: String?
    public var at: Date?
}

public struct AgentDetail: Decodable, Equatable, Sendable {
    public var agent: Agent?
    public var messages: [AgentMessage]
    public var tools: [AgentToolCall]
    public var worktree: JSONValue?

    enum CodingKeys: String, CodingKey { case agent, messages, tools, worktree }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agent = try? c.decodeIfPresent(Agent.self, forKey: .agent)
        messages = (try? c.decodeIfPresent(LossyArray<AgentMessage>.self, forKey: .messages))?.elements ?? []
        tools = (try? c.decodeIfPresent(LossyArray<AgentToolCall>.self, forKey: .tools))?.elements ?? []
        worktree = try? c.decodeIfPresent(JSONValue.self, forKey: .worktree)
    }
}

public enum DiffLineKind: Sendable { case add, delete, context, meta }

public struct DiffLine: Equatable, Hashable, Sendable {
    public var kind: DiffLineKind
    public var text: String

    /// The desktop sends `[kind, text]`; kind is `+`/`-`/` ` or a word (`add`, `del`, `ctx`).
    init(raw: JSONValue) {
        let parts = raw.arrayValue ?? []
        let k = parts.first?.stringValue ?? " "
        text = parts.count > 1 ? (parts[1].stringValue ?? "") : (raw.stringValue ?? "")
        switch k.lowercased() {
        case "+", "add", "added", "insert", "a": kind = .add
        case "-", "del", "delete", "deleted", "remove", "removed", "d": kind = .delete
        case "\\", "meta", "info": kind = .meta
        default: kind = .context
        }
    }

    public init(kind: DiffLineKind, text: String) { self.kind = kind; self.text = text }
}

public struct DiffHunk: Decodable, Equatable, Hashable, Sendable {
    public var header: String
    public var lines: [DiffLine]

    enum CodingKeys: String, CodingKey { case header, lines }

    public init(header: String, lines: [DiffLine]) { self.header = header; self.lines = lines }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        header = (try? c.decodeIfPresent(String.self, forKey: .header)) ?? ""
        let raw = (try? c.decodeIfPresent([JSONValue].self, forKey: .lines)) ?? []
        lines = raw.map(DiffLine.init(raw:))
    }
}

public struct DiffFile: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public var path: String
    public var status: String?
    public var additions: Int?
    public var deletions: Int?
    public var hunks: [DiffHunk]
    public var id: String { path }

    enum CodingKeys: String, CodingKey { case path, status, additions, deletions, hunks }

    public init(path: String, status: String?, additions: Int?, deletions: Int?, hunks: [DiffHunk]) {
        self.path = path; self.status = status; self.additions = additions; self.deletions = deletions; self.hunks = hunks
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        additions = try? c.decodeIfPresent(Int.self, forKey: .additions)
        deletions = try? c.decodeIfPresent(Int.self, forKey: .deletions)
        hunks = (try? c.decodeIfPresent(LossyArray<DiffHunk>.self, forKey: .hunks))?.elements ?? []
    }
}

public struct AgentDiff: Decodable, Equatable, Sendable {
    public var files: [DiffFile]
    public var truncated: Bool

    enum CodingKeys: String, CodingKey { case files, truncated }

    public init(files: [DiffFile], truncated: Bool) { self.files = files; self.truncated = truncated }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        files = (try? c.decodeIfPresent(LossyArray<DiffFile>.self, forKey: .files))?.elements ?? []
        truncated = (try? c.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
    }
}

public struct AgentLogPage: Decodable, Equatable, Sendable {
    public var entries: [JSONValue]
    public var more: Bool

    enum CodingKeys: String, CodingKey { case entries, more }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        entries = (try? c.decodeIfPresent([JSONValue].self, forKey: .entries)) ?? []
        more = (try? c.decodeIfPresent(Bool.self, forKey: .more)) ?? false
    }
}

public struct LaunchOptions: Decodable, Equatable, Sendable {
    public struct Account: Decodable, Equatable, Hashable, Identifiable, Sendable { public var id: String; public var label: String? }
    public struct Model: Decodable, Equatable, Hashable, Identifiable, Sendable {
        public var id: String
        public var name: String?
        public var efforts: [String]?
    }
    public struct Provider: Decodable, Equatable, Hashable, Identifiable, Sendable {
        public var id: String
        public var name: String?
        public var accounts: [Account]?
        public var models: [Model]?
    }

    public var workspaces: [Workspace]
    public var providers: [Provider]

    enum CodingKeys: String, CodingKey { case workspaces, providers }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workspaces = (try? c.decodeIfPresent(LossyArray<Workspace>.self, forKey: .workspaces))?.elements ?? []
        providers = (try? c.decodeIfPresent(LossyArray<Provider>.self, forKey: .providers))?.elements ?? []
    }
}

public struct RunDetail: Decodable, Equatable, Sendable {
    public var run: Run?
    public var logs: JSONValue?
    public var tests: JSONValue?
}

// MARK: - Typed views of the open-shaped fields (as the Rust host sends them)

public struct WorktreeInfo: Equatable, Sendable {
    public var path: String?
    public var branch: String?
    public var baseBranch: String?

    public init?(_ value: JSONValue?) {
        guard let o = value?.objectValue else { return nil }
        path = o["path"]?.stringValue; branch = o["branch"]?.stringValue; baseBranch = o["baseBranch"]?.stringValue
    }
}

public struct LogEntry: Identifiable, Equatable, Sendable {
    public var id: String
    public var kind: String
    public var text: String
    public var at: Date?

    public init(_ value: JSONValue, index: Int) {
        let o = value.objectValue ?? [:]
        id = o["id"]?.stringValue ?? "entry-\(index)"
        kind = o["kind"]?.stringValue ?? o["role"]?.stringValue ?? "output"
        text = o["text"]?.stringValue ?? value.stringValue ?? ""
        at = o["at"]?.stringValue.flatMap(RFC3339.parse)
    }
}

public extension AgentLogPage {
    var typedEntries: [LogEntry] { entries.enumerated().map { LogEntry($1, index: $0) } }
}

public struct TestResult: Identifiable, Equatable, Sendable {
    public var id: String { name }
    public var name: String
    public var status: String
    public var durationMs: Int?
}

public extension RunDetail {
    var logLines: [String] { logs?.arrayValue?.compactMap { $0.stringValue ?? $0["text"]?.stringValue } ?? [] }
    var testResults: [TestResult] {
        tests?.arrayValue?.compactMap { t in
            guard let name = t["name"]?.stringValue else { return nil }
            return TestResult(name: name, status: t["status"]?.stringValue ?? "unknown", durationMs: t["durationMs"]?.numberValue.map { Int($0) })
        } ?? []
    }
}
