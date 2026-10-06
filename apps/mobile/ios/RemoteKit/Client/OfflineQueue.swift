import Foundation

/// A request held while the workstation is Reconnecting (protocol §5 "Offline queue").
public struct QueuedRequest: Identifiable, Equatable, Sendable {
    /// The request id. It never changes, so a request that reached the desktop before a drop is
    /// answered from the desktop's result cache instead of running twice.
    public let id: String
    public let op: String
    public let args: [String: JSONValue]
    public let queuedAt: Date

    public init(id: String, op: String, args: [String: JSONValue], queuedAt: Date) {
        self.id = id; self.op = op; self.args = args; self.queuedAt = queuedAt
    }

    public var agentId: String? { args["agentId"]?.stringValue }
    public var text: String? { args["text"]?.stringValue }
}

public enum OfflineQueueError: Error, Equatable, Sendable {
    /// Only `agent.prompt` and `voice.command` may wait for a connection.
    case notQueueable(String)
}

/// Pure queue rules; the client owns the clock and the transport.
public struct OfflineQueue: Equatable, Sendable {
    public static let ttl: TimeInterval = 60
    public static let queueableOps: Set<String> = ["agent.prompt", "voice.command"]

    public private(set) var items: [QueuedRequest] = []

    public init() {}

    public static func canQueue(_ op: String) -> Bool { queueableOps.contains(op) }

    public var isEmpty: Bool { items.isEmpty }

    public mutating func enqueue(_ request: QueuedRequest) throws {
        guard Self.canQueue(request.op) else { throw OfflineQueueError.notQueueable(request.op) }
        if let i = items.firstIndex(where: { $0.id == request.id }) {
            items[i] = request  // same id re-queued after a drop: keep one entry
        } else {
            items.append(request)
        }
    }

    /// Removes and returns requests older than the TTL.
    public mutating func expire(now: Date) -> [QueuedRequest] {
        let expired = items.filter { now.timeIntervalSince($0.queuedAt) >= Self.ttl }
        if !expired.isEmpty { items.removeAll { now.timeIntervalSince($0.queuedAt) >= Self.ttl } }
        return expired
    }

    /// On reconnect: the live requests in FIFO order (to send with their original ids) and the
    /// expired ones (to fail). The queue is left empty.
    public mutating func drain(now: Date) -> (send: [QueuedRequest], expired: [QueuedRequest]) {
        let expired = expire(now: now)
        let send = items
        items.removeAll()
        return (send, expired)
    }

    /// Everything, for failing the queue when the workstation goes Offline/Removed.
    public mutating func removeAll() -> [QueuedRequest] {
        let all = items
        items.removeAll()
        return all
    }

    public mutating func remove(id: String) { items.removeAll { $0.id == id } }
}

/// Reconnect backoff: 0.5 s doubling to a 10 s cap.
public struct Backoff: Equatable, Sendable {
    public let initial: TimeInterval
    public let maximum: TimeInterval
    public private(set) var attempt = 0

    public init(initial: TimeInterval = 0.5, maximum: TimeInterval = 10) {
        self.initial = initial; self.maximum = maximum
    }

    public mutating func next() -> TimeInterval {
        let delay = min(maximum, initial * pow(2, Double(attempt)))
        attempt = min(attempt + 1, 30)
        return delay
    }

    public mutating func reset() { attempt = 0 }
}
