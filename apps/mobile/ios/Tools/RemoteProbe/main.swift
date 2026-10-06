// RemoteProbe: a macOS command-line interop check of RemoteKit against a real KalCode Remote host
// (the desktop or `crates/remote/examples/devhost.rs`). Same code the app runs, no UI.
//
//   swiftc -parse-as-library -o probe $(find RemoteKit -name '*.swift') Tools/RemoteProbe/main.swift
//   ./probe '<pairing link>'        # pairs, then exercises every read op and a prompt
import Foundation

@main
struct Probe {
    @MainActor
    static func main() async {
        let args = CommandLine.arguments
        guard args.count > 1 else { print("usage: probe <pairing link> [--ops]"); exit(2) }
        let client = RemoteClient(store: MemorySecretStore(), environment: ClientEnvironment(
            deviceName: { "RemoteProbe" }, deviceModel: "probe", appVersion: "1.0 (probe)"))
        var notes = 0
        client.onNotify = { n in notes += 1; print("notify:", n.kind ?? "-", n.title ?? "", n.link ?? "") }
        do {
            let payload = try PairingLink.parse(args[1])
            let t0 = Date()
            try await client.pair(with: payload)
            print("paired with \(client.workstation?.name ?? "?") device=\(client.workstation?.deviceId ?? "?") in \(Int(Date().timeIntervalSince(t0) * 1000)) ms")
            while client.status != .online { try await Task.sleep(nanoseconds: 50_000_000) }
            let f = client.fleet
            print("online rev=\(f.rev ?? -1) agents=\(f.agents.count) needsYou=\(f.needsYou.count) runs=\(f.runs.count) services=\(f.services.count) envs=\(f.environments.count) workspaces=\(f.workspaces.count)")
            print("states:", Dictionary(grouping: f.agents, by: { $0.state.rawValue }).mapValues(\.count))
            guard let agent = f.sortedAgents(.working).first ?? f.agents.first else { print("no agents"); exit(1) }
            let detail: AgentDetail = try await client.request("agent.detail", ["agentId": .string(agent.id)])
            print("agent.detail \(agent.displayName): messages=\(detail.messages.count) tools=\(detail.tools.count) worktree=\(WorktreeInfo(detail.worktree)?.branch ?? "-")")
            let diff: AgentDiff = try await client.request("agent.diff", ["agentId": .string(agent.id)])
            print("agent.diff files=\(diff.files.count) hunks=\(diff.files.map(\.hunks.count).reduce(0, +)) truncated=\(diff.truncated)")
            let log: AgentLogPage = try await client.request("agent.log", ["agentId": .string(agent.id)])
            print("agent.log entries=\(log.entries.count) more=\(log.more)")
            let options: LaunchOptions = try await client.request("launch.options")
            print("launch.options workspaces=\(options.workspaces.count) providers=\(options.providers.map { $0.name ?? $0.id })")
            if let run = f.runs.first {
                let rd: RunDetail = try await client.request("run.detail", ["runId": .string(run.id)])
                print("run.detail \(run.title ?? run.id): logs=\(rd.logLines.count) tests=\(rd.testResults.count)")
            }
            let prompt: SummaryResult = try await client.request("agent.prompt", ["agentId": .string(agent.id), "text": "RemoteProbe: status?"])
            print("agent.prompt →", prompt.summary ?? "-")
            let voice: SummaryResult = try await client.request("voice.command", ["text": "what needs me"])
            print("voice.command →", voice.summary ?? "-", "/", voice.outcome ?? "-")
            do {
                let _: SummaryResult = try await client.request("agent.detail", ["agentId": "thr_does_not_exist"])
            } catch { print("agent.detail(missing) →", error) }
            if let item = client.fleet.needsYou.first(where: { $0.canApprove }), let apr = item.approvalId {
                let r: SummaryResult = try await client.request("needs.decide", ["approvalId": .string(apr), "decision": "approve_once"])
                print("needs.decide \(item.id) → \(r.status ?? "-")")
            }
            let rev0 = client.fleet.rev ?? 0
            try await Task.sleep(nanoseconds: 4_000_000_000)
            print("after 4s: rev \(rev0) → \(client.fleet.rev ?? -1), status=\(client.status), notifications=\(notes)")
            exit(0)
        } catch {
            print("FAILED:", error)
            exit(1)
        }
    }
}
