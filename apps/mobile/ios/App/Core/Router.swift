import SwiftUI
import RemoteKit

/// Top-level destinations (iPhone tabs; iPad sidebar adds Settings).
enum AppSection: String, Hashable, CaseIterable, Identifiable {
    case mission, needs, runs, voice, settings
    var id: String { rawValue }

    var title: String {
        switch self {
        case .mission: return "Mission Control"
        case .needs: return "Needs You"
        case .runs: return "Runs"
        case .voice: return "KalVoice"
        case .settings: return "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .mission: return "square.grid.2x2.fill"
        case .needs: return "hand.raised.fill"
        case .runs: return "terminal.fill"
        case .voice: return "waveform"
        case .settings: return "gearshape.fill"
        }
    }
}

/// Pushed destinations inside a section's NavigationStack (iPhone and narrow iPad).
enum Route: Hashable {
    case agent(String)
    case diff(String)
    case log(String)
    case run(String)
    case settings
}

/// One router owns section, stacks and selections so a deep link works on both idioms
/// (and survives iPad size-class changes such as Slide Over).
@MainActor
@Observable
final class Router {
    var section: AppSection = .mission
    var missionPath: [Route] = []
    var needsPath: [Route] = []
    var runsPath: [Route] = []

    // iPad split selections
    var selectedAgentId: String?
    var diffBeside = false
    var selectedNeedsId: String?
    /// The agent behind the selected Needs You item; kept after the item is answered.
    var selectedNeedsAgentId: String?
    var selectedRunId: String?

    var showLaunch = false

    func showFleet() {
        section = .mission
        missionPath = []
        selectedAgentId = nil
        diffBeside = false
    }

    func showAgent(_ id: String, diff: Bool = false) {
        section = .mission
        missionPath = diff ? [.agent(id), .diff(id)] : [.agent(id)]
        selectedAgentId = id
        diffBeside = diff
    }

    func showNeeds(_ item: NeedsYouItem) {
        section = .needs
        selectedNeedsId = item.id
        selectedNeedsAgentId = item.agentId
        needsPath = item.agentId.map { [.agent($0)] } ?? []
    }

    func showRun(_ id: String) {
        section = .runs
        runsPath = [.run(id)]
        selectedRunId = id
    }

    /// Pushes onto the current section's stack (iPhone).
    func push(_ route: Route) {
        switch section {
        case .mission, .settings, .voice: missionPath.append(route)
        case .needs: needsPath.append(route)
        case .runs: runsPath.append(route)
        }
    }

    /// The agent ended: drop every place that still shows it. Never substitutes another target.
    func agentGone(_ id: String) {
        func strip(_ path: inout [Route]) {
            if let i = path.firstIndex(where: { r in
                switch r {
                case .agent(let a), .diff(let a), .log(let a): return a == id
                default: return false
                }
            }) {
                path.removeSubrange(i...)
            }
        }
        strip(&missionPath)
        strip(&needsPath)
        if selectedAgentId == id {
            selectedAgentId = nil
            diffBeside = false
        }
        if selectedNeedsAgentId == id {
            selectedNeedsAgentId = nil
            selectedNeedsId = nil
        }
    }

    func runGone(_ id: String) {
        if let i = runsPath.firstIndex(of: .run(id)) { runsPath.removeSubrange(i...) }
        if selectedRunId == id { selectedRunId = nil }
    }

    func reset() {
        section = .mission
        missionPath = []; needsPath = []; runsPath = []
        selectedAgentId = nil; selectedNeedsId = nil; selectedNeedsAgentId = nil; selectedRunId = nil
        diffBeside = false; showLaunch = false
    }
}
