#if DEBUG
import Foundation
import RemoteKit

/// Development-only fixtures (`-kc-fixture <name>`) for design review without a workstation.
/// Never compiled into Release. They show the demo workstation's data (see DemoWorkstation)
/// without the Demo badge, in the connection states the demo itself never reaches.
///
/// Names: fleet (default), reconnecting, offline, connecting, removed, empty, big (200 agents).
@MainActor
enum Fixtures {
    static func load(_ name: String, into model: AppModel) {
        let now = Date()
        let workstation = DemoWorkstation.pairing(now)
        let agents = DemoWorkstation.agents(now)
        let needs = DemoWorkstation.needs(now)
        let client = model.client
        DemoResponder.reset()
        switch name {
        case "removed":
            model.removedNameOverride = workstation.name
            client.simulate(fleet: FleetState(), status: .removed(.revoked), workstation: nil)
        case "empty":
            client.simulate(fleet: DemoWorkstation.fleet(agents: [], needs: [], now: now), status: .online, workstation: workstation)
        case "big":
            client.simulate(fleet: DemoWorkstation.fleet(agents: bigAgents(agents, now), needs: needs, now: now), status: .online, workstation: workstation)
        case "reconnecting":
            client.simulate(fleet: DemoWorkstation.fleet(agents: agents, needs: needs, now: now), status: .reconnecting(since: now), workstation: workstation)
        case "offline":
            client.simulate(fleet: DemoWorkstation.fleet(agents: agents, needs: needs, now: now), status: .offline(.unreachable), workstation: workstation)
        case "connecting":
            client.simulate(fleet: FleetState(), status: .connecting, workstation: workstation)
        default:
            client.simulate(fleet: DemoWorkstation.fleet(agents: agents, needs: needs, now: now), status: .online, workstation: workstation)
        }
    }

    static func bigAgents(_ base: [Agent], _ now: Date) -> [Agent] {
        let workspaces = DemoWorkstation.workspaces
        let states: [AgentState] = [.working, .working, .testing, .done, .idle, .failed, .waiting, .starting, .stopped, .ready]
        let names = ["Refactor provider adapter", "Add retry to sync", "Tighten CSP", "Speed up cold start", "Fix flaky e2e",
                     "Polish onboarding copy", "Index workspace symbols", "Trim bundle size", "Harden updater", "Migrate icons"]
        let providers = [("claude-code", "Claude Code", "claude-opus-5-5"), ("codex", "Codex", "gpt-5.5-codex"),
                         ("gemini", "Gemini CLI", "gemini-3-pro"), ("cursor", "Cursor", "cursor-fast")]
        var out = base
        for i in 0..<(200 - base.count) {
            let p = providers[i % providers.count]
            let state = states[i % states.count]
            out.append(Agent(
                id: "thr_bulk_\(i)", name: "\(names[i % names.count]) #\(i + 1)",
                workspaceId: workspaces[i % 3].id, workspaceName: workspaces[i % 3].name,
                providerId: p.0, providerName: p.1, accountLabel: i % 2 == 0 ? "Work" : "Personal",
                model: p.2, effort: ["low", "medium", "high"][i % 3], state: state, status: state.rawValue,
                activity: state.isActive ? "Editing src/module\(i % 17).ts" : nil,
                branch: "kal/task-\(i + 1)", worktree: i % 3 != 0, filesChanged: i % 9,
                pendingApprovals: 0, error: state == .failed ? "Exit code 1 in npm test" : nil,
                createdAt: now.addingTimeInterval(-Double(60 * (i + 1) * 7)), lastActivityAt: now.addingTimeInterval(-Double(30 * (i + 1))),
                runtime: "pane"))
        }
        return out
    }
}
#endif
