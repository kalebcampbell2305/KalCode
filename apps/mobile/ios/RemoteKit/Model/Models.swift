import Foundation

// Canonical state mirrored from the desktop (protocol §4.1). Every field the desktop may leave
// null is optional; unknown enum strings decode to `.unknown` so a newer desktop never breaks an
// older phone.

public struct Workstation: Codable, Equatable, Sendable {
    public var id: String
    public var name: String?
    public var platform: String?
    public var version: String?
    public var build: Int?
    public var activeWorkspaceId: String?

    public init(id: String, name: String? = nil, platform: String? = nil, version: String? = nil, build: Int? = nil, activeWorkspaceId: String? = nil) {
        self.id = id; self.name = name; self.platform = platform; self.version = version; self.build = build; self.activeWorkspaceId = activeWorkspaceId
    }
}

public struct Workspace: Codable, Equatable, Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String?
    public var path: String?
    public var lastActiveAt: Date?

    public init(id: String, name: String? = nil, path: String? = nil, lastActiveAt: Date? = nil) {
        self.id = id; self.name = name; self.path = path; self.lastActiveAt = lastActiveAt
    }

    public var displayName: String { name ?? path?.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? id }
}

public enum AgentState: String, Codable, Sendable, CaseIterable {
    case starting, ready, working, testing, waiting
    case needsYou = "needs_you"
    case idle, done, failed, stopped
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = AgentState(rawValue: raw) ?? .unknown
    }

    /// Starting, working or testing now (the desktop deck's "active").
    public var isActive: Bool { self == .starting || self == .working || self == .testing }
    public var needsAttention: Bool { self == .needsYou || self == .waiting }
    public var isFinished: Bool { self == .done || self == .stopped }
}

public struct Agent: Codable, Equatable, Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String?
    public var workspaceId: String?
    public var workspaceName: String?
    public var providerId: String?
    public var providerName: String?
    public var accountLabel: String?
    public var model: String?
    public var effort: String?
    public var state: AgentState
    public var status: String?
    public var activity: String?
    public var branch: String?
    public var worktree: Bool?
    public var filesChanged: Int?
    public var pendingApprovals: Int?
    public var error: String?
    public var createdAt: Date?
    public var lastActivityAt: Date?
    public var runtime: String?

    public init(
        id: String, name: String? = nil, workspaceId: String? = nil, workspaceName: String? = nil,
        providerId: String? = nil, providerName: String? = nil, accountLabel: String? = nil,
        model: String? = nil, effort: String? = nil, state: AgentState = .idle, status: String? = nil,
        activity: String? = nil, branch: String? = nil, worktree: Bool? = nil, filesChanged: Int? = nil,
        pendingApprovals: Int? = nil, error: String? = nil, createdAt: Date? = nil,
        lastActivityAt: Date? = nil, runtime: String? = nil
    ) {
        self.id = id; self.name = name; self.workspaceId = workspaceId; self.workspaceName = workspaceName
        self.providerId = providerId; self.providerName = providerName; self.accountLabel = accountLabel
        self.model = model; self.effort = effort; self.state = state; self.status = status
        self.activity = activity; self.branch = branch; self.worktree = worktree
        self.filesChanged = filesChanged; self.pendingApprovals = pendingApprovals; self.error = error
        self.createdAt = createdAt; self.lastActivityAt = lastActivityAt; self.runtime = runtime
    }

    enum CodingKeys: String, CodingKey {
        case id, name, workspaceId, workspaceName, providerId, providerName, accountLabel, model, effort
        case state, status, activity, branch, worktree, filesChanged, pendingApprovals, error
        case createdAt, lastActivityAt, runtime
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try? c.decodeIfPresent(String.self, forKey: .name)
        workspaceId = try? c.decodeIfPresent(String.self, forKey: .workspaceId)
        workspaceName = try? c.decodeIfPresent(String.self, forKey: .workspaceName)
        providerId = try? c.decodeIfPresent(String.self, forKey: .providerId)
        providerName = try? c.decodeIfPresent(String.self, forKey: .providerName)
        accountLabel = try? c.decodeIfPresent(String.self, forKey: .accountLabel)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        effort = try? c.decodeIfPresent(String.self, forKey: .effort)
        state = (try? c.decodeIfPresent(AgentState.self, forKey: .state)) ?? .unknown
        status = try? c.decodeIfPresent(String.self, forKey: .status)
        activity = try? c.decodeIfPresent(String.self, forKey: .activity)
        branch = try? c.decodeIfPresent(String.self, forKey: .branch)
        worktree = try? c.decodeIfPresent(Bool.self, forKey: .worktree)
        filesChanged = try? c.decodeIfPresent(Int.self, forKey: .filesChanged)
        pendingApprovals = try? c.decodeIfPresent(Int.self, forKey: .pendingApprovals)
        error = try? c.decodeIfPresent(String.self, forKey: .error)
        createdAt = try? c.decodeIfPresent(Date.self, forKey: .createdAt)
        lastActivityAt = try? c.decodeIfPresent(Date.self, forKey: .lastActivityAt)
        runtime = try? c.decodeIfPresent(String.self, forKey: .runtime)
    }

    public var displayName: String {
        if let name, !name.trimmingCharacters(in: .whitespaces).isEmpty { return name }
        return "Untitled agent"
    }
}

public enum NeedsYouKind: String, Codable, Sendable {
    case approval, question, failed, auth, stalled, review, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = NeedsYouKind(rawValue: raw) ?? .unknown
    }
}

public struct NeedsYouItem: Codable, Equatable, Identifiable, Hashable, Sendable {
    public var id: String
    public var kind: NeedsYouKind
    public var title: String?
    public var detail: String?
    public var agentId: String?
    public var approvalId: String?
    public var createdAt: Date?
    public var actions: [String]?

    public init(id: String, kind: NeedsYouKind, title: String? = nil, detail: String? = nil, agentId: String? = nil, approvalId: String? = nil, createdAt: Date? = nil, actions: [String]? = nil) {
        self.id = id; self.kind = kind; self.title = title; self.detail = detail; self.agentId = agentId
        self.approvalId = approvalId; self.createdAt = createdAt; self.actions = actions
    }

    public var canApprove: Bool { approvalId != nil && (actions ?? []).contains("approve_once") }
    public var canDeny: Bool { approvalId != nil && (actions ?? []).contains("deny") }
}

public struct Run: Codable, Equatable, Identifiable, Hashable, Sendable {
    public var id: String
    public var title: String?
    public var kind: String?
    public var status: String?
    public var agentId: String?
    public var branch: String?
    public var currentAction: String?
    public var outcome: String?
    public var updatedAt: Date?

    public init(id: String, title: String? = nil, kind: String? = nil, status: String? = nil, agentId: String? = nil, branch: String? = nil, currentAction: String? = nil, outcome: String? = nil, updatedAt: Date? = nil) {
        self.id = id; self.title = title; self.kind = kind; self.status = status; self.agentId = agentId
        self.branch = branch; self.currentAction = currentAction; self.outcome = outcome; self.updatedAt = updatedAt
    }
}

public struct Service: Codable, Equatable, Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String?
    public var status: String?
    public var url: String?

    public init(id: String, name: String? = nil, status: String? = nil, url: String? = nil) {
        self.id = id; self.name = name; self.status = status; self.url = url
    }
}

public struct DeployEnvironment: Codable, Equatable, Identifiable, Hashable, Sendable {
    public var id: String
    public var name: String?
    public var kind: String?
    public var deploymentStatus: String?
    public var health: String?
    public var url: String?
    public var lastDeployAt: Date?

    public init(id: String, name: String? = nil, kind: String? = nil, deploymentStatus: String? = nil, health: String? = nil, url: String? = nil, lastDeployAt: Date? = nil) {
        self.id = id; self.name = name; self.kind = kind; self.deploymentStatus = deploymentStatus
        self.health = health; self.url = url; self.lastDeployAt = lastDeployAt
    }
}

/// The `state` object of a snapshot.
public struct FleetSnapshot: Decodable, Equatable, Sendable {
    public var workstation: Workstation?
    public var workspaces: [Workspace]
    public var agents: [Agent]
    public var needsYou: [NeedsYouItem]
    public var runs: [Run]
    public var services: [Service]
    public var environments: [DeployEnvironment]

    public init(workstation: Workstation? = nil, workspaces: [Workspace] = [], agents: [Agent] = [], needsYou: [NeedsYouItem] = [], runs: [Run] = [], services: [Service] = [], environments: [DeployEnvironment] = []) {
        self.workstation = workstation; self.workspaces = workspaces; self.agents = agents
        self.needsYou = needsYou; self.runs = runs; self.services = services; self.environments = environments
    }

    enum CodingKeys: String, CodingKey { case workstation, workspaces, agents, needsYou, runs, services, environments }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workstation = try? c.decodeIfPresent(Workstation.self, forKey: .workstation)
        workspaces = (try? c.decodeIfPresent(LossyArray<Workspace>.self, forKey: .workspaces))?.elements ?? []
        agents = (try? c.decodeIfPresent(LossyArray<Agent>.self, forKey: .agents))?.elements ?? []
        needsYou = (try? c.decodeIfPresent(LossyArray<NeedsYouItem>.self, forKey: .needsYou))?.elements ?? []
        runs = (try? c.decodeIfPresent(LossyArray<Run>.self, forKey: .runs))?.elements ?? []
        services = (try? c.decodeIfPresent(LossyArray<Service>.self, forKey: .services))?.elements ?? []
        environments = (try? c.decodeIfPresent(LossyArray<DeployEnvironment>.self, forKey: .environments))?.elements ?? []
    }
}

/// `patch.upsert` / `patch.remove`.
public struct FleetUpsert: Decodable, Equatable, Sendable {
    public var agents: [Agent]?
    public var needsYou: [NeedsYouItem]?
    public var runs: [Run]?
    public var services: [Service]?
    public var environments: [DeployEnvironment]?
    public var workspaces: [Workspace]?

    public init(agents: [Agent]? = nil, needsYou: [NeedsYouItem]? = nil, runs: [Run]? = nil, services: [Service]? = nil, environments: [DeployEnvironment]? = nil, workspaces: [Workspace]? = nil) {
        self.agents = agents; self.needsYou = needsYou; self.runs = runs; self.services = services
        self.environments = environments; self.workspaces = workspaces
    }

    enum CodingKeys: String, CodingKey { case agents, needsYou, runs, services, environments, workspaces }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        agents = (try? c.decodeIfPresent(LossyArray<Agent>.self, forKey: .agents))?.elements
        needsYou = (try? c.decodeIfPresent(LossyArray<NeedsYouItem>.self, forKey: .needsYou))?.elements
        runs = (try? c.decodeIfPresent(LossyArray<Run>.self, forKey: .runs))?.elements
        services = (try? c.decodeIfPresent(LossyArray<Service>.self, forKey: .services))?.elements
        environments = (try? c.decodeIfPresent(LossyArray<DeployEnvironment>.self, forKey: .environments))?.elements
        workspaces = (try? c.decodeIfPresent(LossyArray<Workspace>.self, forKey: .workspaces))?.elements
    }
}

public struct FleetRemove: Decodable, Equatable, Sendable {
    public var agents: [String]?
    public var needsYou: [String]?
    public var runs: [String]?
    public var services: [String]?
    public var environments: [String]?
    public var workspaces: [String]?

    public init(agents: [String]? = nil, needsYou: [String]? = nil, runs: [String]? = nil, services: [String]? = nil, environments: [String]? = nil, workspaces: [String]? = nil) {
        self.agents = agents; self.needsYou = needsYou; self.runs = runs; self.services = services
        self.environments = environments; self.workspaces = workspaces
    }
}

public struct FleetPatch: Decodable, Equatable, Sendable {
    public var rev: Int
    public var upsert: FleetUpsert?
    public var remove: FleetRemove?
    public var workstation: Workstation?

    public init(rev: Int, upsert: FleetUpsert? = nil, remove: FleetRemove? = nil, workstation: Workstation? = nil) {
        self.rev = rev; self.upsert = upsert; self.remove = remove; self.workstation = workstation
    }
}
