import Foundation

/// The phone's mirror of the desktop's canonical state.
///
/// A snapshot replaces everything. A patch applies only when its `rev` is exactly the next one;
/// anything else is a gap and the caller must reconnect (the desktop then sends a fresh snapshot).
/// The reducer never guesses.
public struct FleetState: Equatable, Sendable {
    public private(set) var rev: Int?
    public var workstation: Workstation?
    public var workspaces: [Workspace] = []
    public var agents: [Agent] = []
    public var needsYou: [NeedsYouItem] = []
    public var runs: [Run] = []
    public var services: [Service] = []
    public var environments: [DeployEnvironment] = []

    public init() {}

    public enum PatchResult: Equatable, Sendable {
        case applied
        /// The patch didn't follow the last applied revision.
        case gap(expected: Int?, received: Int)
    }

    public var hasSnapshot: Bool { rev != nil }

    public mutating func apply(snapshot: FleetSnapshot, rev: Int) {
        self.rev = rev
        workstation = snapshot.workstation
        workspaces = snapshot.workspaces
        agents = snapshot.agents
        needsYou = snapshot.needsYou
        runs = snapshot.runs
        services = snapshot.services
        environments = snapshot.environments
    }

    @discardableResult
    public mutating func apply(patch: FleetPatch) -> PatchResult {
        guard let current = rev, patch.rev == current + 1 else {
            return .gap(expected: rev.map { $0 + 1 }, received: patch.rev)
        }
        rev = patch.rev
        if let ws = patch.workstation { workstation = ws }
        if let r = patch.remove {
            Self.remove(r.agents, from: &agents)
            Self.remove(r.needsYou, from: &needsYou)
            Self.remove(r.runs, from: &runs)
            Self.remove(r.services, from: &services)
            Self.remove(r.environments, from: &environments)
            Self.remove(r.workspaces, from: &workspaces)
        }
        if let u = patch.upsert {
            Self.upsert(u.agents, into: &agents)
            Self.upsert(u.needsYou, into: &needsYou)
            Self.upsert(u.runs, into: &runs)
            Self.upsert(u.services, into: &services)
            Self.upsert(u.environments, into: &environments)
            Self.upsert(u.workspaces, into: &workspaces)
        }
        return .applied
    }

    /// Forget everything (unpair / removed).
    public mutating func reset() { self = FleetState() }

    // MARK: Lookups

    public func agent(_ id: String) -> Agent? { agents.first { $0.id == id } }
    public func needsYouItem(_ id: String) -> NeedsYouItem? { needsYou.first { $0.id == id } }
    public func run(_ id: String) -> Run? { runs.first { $0.id == id } }
    public func needsYou(forAgent id: String) -> [NeedsYouItem] { needsYou.filter { $0.agentId == id } }
    public func workspace(_ id: String?) -> Workspace? {
        guard let id else { return nil }
        return workspaces.first { $0.id == id }
    }

    public var activeWorkspace: Workspace? { workspace(workstation?.activeWorkspaceId) }

    // MARK: Helpers

    private static func upsert<T: Identifiable>(_ items: [T]?, into array: inout [T]) where T.ID == String {
        guard let items, !items.isEmpty else { return }
        var index: [String: Int] = [:]
        index.reserveCapacity(array.count)
        for (i, item) in array.enumerated() { index[item.id] = i }
        for item in items {
            if let i = index[item.id] {
                array[i] = item
            } else {
                index[item.id] = array.count
                array.append(item)
            }
        }
    }

    private static func remove<T: Identifiable>(_ ids: [String]?, from array: inout [T]) where T.ID == String {
        guard let ids, !ids.isEmpty else { return }
        let set = Set(ids)
        array.removeAll { set.contains($0.id) }
    }
}

// MARK: - Fleet presentation (shared by every surface)

public enum FleetFilter: String, CaseIterable, Identifiable, Sendable {
    case all, needsYou, working, failed, done
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .all: return "All"
        case .needsYou: return "Needs You"
        case .working: return "Working"
        case .failed: return "Failed"
        case .done: return "Done"
        }
    }

    public func matches(_ agent: Agent) -> Bool {
        switch self {
        case .all: return true
        case .needsYou: return agent.state.needsAttention || (agent.pendingApprovals ?? 0) > 0
        case .working: return agent.state.isActive
        case .failed: return agent.state == .failed
        case .done: return agent.state.isFinished
        }
    }
}

public extension FleetState {
    /// Stable display order: what needs the person first, then live work, then the rest.
    /// Within a group, newest first by creation time (which never changes, so cards don't jump).
    static func sortRank(_ state: AgentState) -> Int {
        switch state {
        case .needsYou: return 0
        case .waiting: return 1
        case .failed: return 2
        case .working, .testing, .starting: return 3
        case .ready, .idle, .unknown: return 4
        case .done, .stopped: return 5
        }
    }

    func sortedAgents(_ filter: FleetFilter = .all) -> [Agent] {
        agents.filter(filter.matches).sorted { a, b in
            let ra = Self.sortRank(a.state), rb = Self.sortRank(b.state)
            if ra != rb { return ra < rb }
            let ca = a.createdAt ?? .distantPast, cb = b.createdAt ?? .distantPast
            if ca != cb { return ca > cb }
            return a.id < b.id
        }
    }

    func count(_ filter: FleetFilter) -> Int { agents.lazy.filter(filter.matches).count }

    var sortedNeedsYou: [NeedsYouItem] {
        needsYou.sorted { ($0.createdAt ?? .distantPast, $0.id) < ($1.createdAt ?? .distantPast, $1.id) }
    }
}
