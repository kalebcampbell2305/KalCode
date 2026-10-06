import Foundation
import RemoteKit

/// The in-app demo: a simulated workstation that runs the real interface entirely on this
/// device (welcome → "Explore a demo workstation"). Nothing touches the network or the saved
/// pairing. DEBUG design-review fixtures (`-kc-fixture`) reuse the same data.
@MainActor
enum DemoWorkstation {
    static let name = "Studio Workstation"
    static let wid = "ws_demo_9f3c2a71"

    static func load(into model: AppModel) {
        let now = Date()
        DemoResponder.reset()
        model.client.simulate(fleet: fleet(agents: agents(now), needs: needs(now), now: now), status: .online, workstation: pairing(now))
    }

    static func pairing(_ now: Date) -> PairedWorkstation {
        PairedWorkstation(
            wid: wid, name: name,
            publicKey: Data(repeating: 7, count: 32),
            addrs: ["192.168.1.20:47820", "100.101.7.40:47820"],
            deviceId: "dev_demo_4e81b0", pairedAt: now.addingTimeInterval(-86_400 * 3),
            host: hostInfo
        )
    }

    static var hostInfo: HostInfo? {
        try? JSONDecoder().decode(HostInfo.self, from: Data(#"{"platform":"windows","version":"0.1.9","build":2007}"#.utf8))
    }

    static func fleet(agents: [Agent], needs: [NeedsYouItem], now: Date) -> FleetState {
        var f = FleetState()
        f.apply(snapshot: FleetSnapshot(
            workstation: Workstation(id: wid, name: name, platform: "windows", version: "0.1.9", build: 2007, activeWorkspaceId: "wsp_kalcode"),
            workspaces: workspaces,
            agents: agents,
            needsYou: needs,
            runs: runs(now),
            services: [
                Service(id: "svc_web", name: "web (vite)", status: "running", url: "http://localhost:5173"),
                Service(id: "svc_api", name: "api", status: "running", url: "http://localhost:8787"),
                Service(id: "svc_docs", name: "docs", status: "stopped", url: nil),
            ],
            environments: [
                DeployEnvironment(id: "env_prod", name: "Production", kind: "production", deploymentStatus: "deployed", health: "healthy", url: "https://kalcoded.com", lastDeployAt: now.addingTimeInterval(-3 * 3600)),
                DeployEnvironment(id: "env_prev", name: "Preview", kind: "preview", deploymentStatus: "deploying", health: "degraded", url: "https://preview.kalcoded.com", lastDeployAt: now.addingTimeInterval(-240)),
            ]
        ), rev: 1)
        return f
    }

    static let workspaces = [
        Workspace(id: "wsp_kalcode", name: "KalCode", path: "C:/dev/kalcode"),
        Workspace(id: "wsp_site", name: "kalcoded.com", path: "C:/dev/kalcoded.com"),
        Workspace(id: "wsp_remote", name: "kc-remote-ios", path: "C:/dev/kc-remote-ios"),
    ]

    static let providers = ["claude-code": "Claude Code", "codex": "Codex", "gemini": "Gemini CLI", "cursor": "Cursor"]

    static func agents(_ now: Date) -> [Agent] {
        func ago(_ s: TimeInterval) -> Date { now.addingTimeInterval(-s) }
        return [
            Agent(id: "thr_login", name: "Fix login redirect after OAuth callback", workspaceId: "wsp_kalcode", workspaceName: "KalCode",
                  providerId: "claude-code", providerName: "Claude Code", accountLabel: "Work", model: "claude-opus-5-5", effort: "high",
                  state: .needsYou, status: "waiting_for_approval", activity: "Wants to run cargo test -p auth",
                  branch: "kal/fix-login-redirect", worktree: true, filesChanged: 4, pendingApprovals: 1,
                  createdAt: ago(1_420), lastActivityAt: ago(40), runtime: "pane"),
            Agent(id: "thr_remote", name: "Remote: diff viewer with pinned gutter", workspaceId: "wsp_remote", workspaceName: "kc-remote-ios",
                  providerId: "codex", providerName: "Codex", accountLabel: "Personal", model: "gpt-5.5-codex", effort: "xhigh",
                  state: .working, status: "running_command", activity: "Running xcodebuild -scheme KalCodeRemote",
                  branch: "kal/remote-diff", worktree: true, filesChanged: 9, pendingApprovals: 0,
                  createdAt: ago(2_760), lastActivityAt: ago(5), runtime: "pane"),
            Agent(id: "thr_tests", name: "Stabilize flaky git status tests", workspaceId: "wsp_kalcode", workspaceName: "KalCode",
                  providerId: "claude-code", providerName: "Claude Code", accountLabel: "Work", model: "claude-sonnet-5", effort: "medium",
                  state: .testing, status: "running_tests", activity: "cargo test -p git — 212 passed, 3 running",
                  branch: "kal/flaky-git-status", worktree: true, filesChanged: 2,
                  createdAt: ago(5_400), lastActivityAt: ago(12), runtime: "headless"),
            Agent(id: "thr_pricing", name: "Pricing page: annual toggle", workspaceId: "wsp_site", workspaceName: "kalcoded.com",
                  providerId: "cursor", providerName: "Cursor", accountLabel: "Team", model: "cursor-fast", effort: nil,
                  state: .starting, status: "starting", activity: "Preparing worktree",
                  branch: "kal/annual-toggle", worktree: true,
                  createdAt: ago(20), lastActivityAt: ago(3), runtime: "pane"),
            Agent(id: "thr_q", name: "Migrate settings store to SQLite", workspaceId: "wsp_kalcode", workspaceName: "KalCode",
                  providerId: "gemini", providerName: "Gemini CLI", accountLabel: "Personal", model: "gemini-3-pro", effort: "high",
                  state: .waiting, status: "waiting_for_input", activity: "Asked: keep the JSON export for backups?",
                  branch: "kal/settings-sqlite", worktree: false, filesChanged: 6, pendingApprovals: 0,
                  createdAt: ago(9_000), lastActivityAt: ago(600), runtime: "pane"),
            Agent(id: "thr_fail", name: "Update Tauri to 2.4", workspaceId: "wsp_kalcode", workspaceName: "KalCode",
                  providerId: "codex", providerName: "Codex", accountLabel: "Work", model: "gpt-5.5-codex", effort: "medium",
                  state: .failed, status: "error", activity: nil, branch: "kal/tauri-2-4", worktree: true, filesChanged: 3,
                  error: "cargo build failed: tauri-build 2.4.0 requires rustc 1.88", createdAt: ago(12_000), lastActivityAt: ago(1_800), runtime: "pane"),
            Agent(id: "thr_done", name: "Write release notes for 0.1.9", workspaceId: "wsp_kalcode", workspaceName: "KalCode",
                  providerId: "claude-code", providerName: "Claude Code", accountLabel: "Work", model: "claude-opus-5-5", effort: "low",
                  state: .done, status: "completed", activity: nil, branch: "main", worktree: false, filesChanged: 1,
                  createdAt: ago(30_000), lastActivityAt: ago(7_200), runtime: "headless"),
            Agent(id: "thr_idle", name: "Explore memory retrieval ranking", workspaceId: "wsp_kalcode", workspaceName: "KalCode",
                  providerId: "claude-code", providerName: "Claude Code", accountLabel: "Personal", model: "claude-haiku-5", effort: "low",
                  state: .idle, status: "idle", branch: "kal/memory-rank", worktree: true,
                  createdAt: ago(200_000), lastActivityAt: ago(90_000), runtime: "pane"),
        ]
    }

    static func needs(_ now: Date) -> [NeedsYouItem] {
        [
            NeedsYouItem(id: "approval:apr_7731", kind: .approval, title: "Run `cargo test -p auth`?",
                         detail: "Claude Code wants to run a command in KalCode", agentId: "thr_login", approvalId: "apr_7731",
                         createdAt: now.addingTimeInterval(-40), actions: ["approve_once", "deny", "open"]),
            NeedsYouItem(id: "question:thr_q", kind: .question, title: "Keep the JSON export for backups?",
                         detail: "Gemini CLI is waiting for your answer before it removes settings.json", agentId: "thr_q",
                         createdAt: now.addingTimeInterval(-600), actions: ["open"]),
            NeedsYouItem(id: "failed:thr_fail", kind: .failed, title: "Update Tauri to 2.4 failed",
                         detail: "cargo build failed: tauri-build 2.4.0 requires rustc 1.88", agentId: "thr_fail",
                         createdAt: now.addingTimeInterval(-1_800), actions: ["open"]),
        ]
    }

    static func runs(_ now: Date) -> [Run] {
        [
            Run(id: "op_nightly", title: "Nightly tests", kind: "test", status: "running", branch: "main",
                currentAction: "cargo test -p git", updatedAt: now.addingTimeInterval(-30)),
            Run(id: "op_release", title: "Release 0.1.9 (Windows + macOS)", kind: "release", status: "passed", branch: "release/0.1.9",
                outcome: "Signed installers uploaded", updatedAt: now.addingTimeInterval(-3 * 3600)),
            Run(id: "op_lint", title: "Lint & typecheck", kind: "check", status: "failed", branch: "kal/settings-sqlite",
                outcome: "3 type errors in settingsStore.ts", updatedAt: now.addingTimeInterval(-900)),
            Run(id: "op_deploy", title: "Deploy preview", kind: "deploy", status: "queued", branch: "kal/annual-toggle",
                updatedAt: now.addingTimeInterval(-120)),
        ]
    }
}

/// Answers operations locally for a simulated workstation. Results go through the same decoders
/// as real responses, and actions change the simulated fleet the way the desktop would.
@MainActor
enum DemoResponder {
    /// Follow-ups sent in this demo session, per agent (shown in the agent's conversation).
    private static var sent: [String: [(text: String, at: Date)]] = [:]
    private static var launched = 0

    static func reset() {
        sent = [:]
        launched = 0
    }

    static func respond<T: Decodable>(_ op: String, _ args: [String: JSONValue], model: AppModel, as type: T.Type) async throws -> T {
        try await Task.sleep(nanoseconds: 380_000_000)
        let now = Date()
        func iso(_ s: TimeInterval) -> String { RFC3339.format(now.addingTimeInterval(-s)) }
        let agentId = args["agentId"]?.stringValue ?? ""
        let fleet = model.client.fleet
        let result: Any
        switch op {
        case "agent.detail":
            guard let agent = fleet.agent(agentId) else { throw RemoteRequestError.remote(code: "not_found", message: nil) }
            let agentJSON = try JSONSerialization.jsonObject(with: JSONEncoder.demo.encode(agent))
            var messages = conversation(agent, iso: iso)
            for p in sent[agentId] ?? [] {
                messages.append(["role": "user", "text": p.text, "at": RFC3339.format(p.at)])
            }
            result = [
                "agent": agentJSON,
                "messages": messages,
                "tools": tools(agent, iso: iso),
                "worktree": ["path": "C:/dev/.kalcode/worktrees/\(agent.branch ?? "main")", "branch": agent.branch ?? "main", "baseBranch": "main"],
            ]
        case "agent.diff":
            result = diff
        case "agent.log":
            let page = args["beforeId"] == nil ? 0 : 1
            result = [
                "more": page == 0,
                "entries": (0..<24).map { i -> [String: Any] in
                    let n = page * 24 + i
                    let kinds = ["assistant", "tool", "output", "output", "user", "error"]
                    return ["id": "log_\(page)_\(i)", "kind": kinds[n % kinds.count],
                            "text": n % 6 == 5 ? "warning: unused variable `retry_count`" : "step \(48 - n): compiling auth v0.4.\(n) (crates/auth)",
                            "at": iso(Double(48 - n) * 30 + Double(page) * 2000)]
                },
            ]
        case "launch.options":
            result = [
                "workspaces": DemoWorkstation.workspaces.map { ["id": $0.id, "name": $0.name ?? "", "path": $0.path ?? ""] },
                "providers": [
                    ["id": "claude-code", "name": "Claude Code", "accounts": [["id": "acc_work", "label": "Work"], ["id": "acc_personal", "label": "Personal"]],
                     "models": [["id": "claude-opus-5-5", "name": "Claude Opus 5.5", "efforts": ["low", "medium", "high", "max"]],
                                ["id": "claude-sonnet-5", "name": "Claude Sonnet 5", "efforts": ["low", "medium", "high"]]]],
                    ["id": "codex", "name": "Codex", "accounts": [["id": "acc_codex", "label": "Work"]],
                     "models": [["id": "gpt-5.5-codex", "name": "GPT-5.5 Codex", "efforts": ["low", "medium", "high", "xhigh"]]]],
                    ["id": "gemini", "name": "Gemini CLI", "accounts": [["id": "acc_g", "label": "Personal"]],
                     "models": [["id": "gemini-3-pro", "name": "Gemini 3 Pro", "efforts": []]]],
                ],
            ]
        case "agent.launch":
            launched += 1
            let id = "thr_demo_\(launched)"
            let workspace = DemoWorkstation.workspaces.first { $0.id == args["workspaceId"]?.stringValue } ?? DemoWorkstation.workspaces[0]
            let providerId = args["providerId"]?.stringValue ?? "claude-code"
            let prompt = args["prompt"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let title = prompt.isEmpty ? "New agent \(launched)" : String(prompt.split(separator: "\n").first ?? "").prefix(60).description
            let agent = Agent(id: id, name: title, workspaceId: workspace.id, workspaceName: workspace.name,
                              providerId: providerId, providerName: DemoWorkstation.providers[providerId] ?? providerId,
                              accountLabel: "Work", model: args["model"]?.stringValue, effort: args["effort"]?.stringValue,
                              state: .starting, status: "starting", activity: "Preparing worktree",
                              branch: "kal/demo-\(launched)", worktree: true, createdAt: now, lastActivityAt: now, runtime: "pane")
            update(model) { $0.agents.insert(agent, at: 0) }
            if !prompt.isEmpty { sent[id] = [(prompt, now)] }
            later(model, seconds: 2.5) { fleet in
                edit(&fleet, id) { $0.state = .working; $0.status = "running"; $0.activity = "Reading the workspace" }
            }
            result = ["agentId": id, "summary": "Launched 1 agent in \(workspace.name ?? "KalCode")"]
        case "agent.prompt":
            let text = args["text"]?.stringValue ?? ""
            sent[agentId, default: []].append((text, now))
            update(model) { fleet in
                fleet.needsYou.removeAll { $0.agentId == agentId && $0.kind == .question }
                edit(&fleet, agentId) { $0.state = .working; $0.status = "running"; $0.activity = "Working on your follow-up" }
            }
            result = ["summary": "Sent to \(fleet.agent(agentId)?.providerName ?? "the agent")"]
        case "agent.stop":
            update(model) { fleet in
                fleet.needsYou.removeAll { $0.agentId == agentId }
                edit(&fleet, agentId) { $0.state = .stopped; $0.status = "stopped"; $0.activity = nil; $0.pendingApprovals = 0 }
            }
            result = ["summary": "Stopped \(fleet.agent(agentId)?.displayName ?? "agent")"]
        case "agent.retry":
            update(model) { fleet in
                fleet.needsYou.removeAll { $0.agentId == agentId && $0.kind == .failed }
                edit(&fleet, agentId) { $0.state = .starting; $0.status = "starting"; $0.error = nil; $0.activity = "Retrying from the last checkpoint" }
            }
            later(model, seconds: 2.5) { fleet in
                edit(&fleet, agentId) { $0.state = .working; $0.status = "running"; $0.activity = "Rebuilding with the pinned toolchain" }
            }
            result = ["summary": "Retrying \(fleet.agent(agentId)?.displayName ?? "agent")"]
        case "needs.decide":
            let approvalId = args["approvalId"]?.stringValue
            let deny = args["decision"]?.stringValue == "deny"
            let owner = fleet.needsYou.first { $0.approvalId == approvalId }?.agentId
            update(model) { fleet in
                fleet.needsYou.removeAll { $0.approvalId == approvalId }
                guard let owner else { return }
                edit(&fleet, owner) { a in
                    a.pendingApprovals = 0
                    a.state = deny ? .waiting : .working
                    a.status = deny ? "waiting_for_input" : "running_command"
                    a.activity = deny ? "Denied — waiting for direction" : "Running cargo test -p auth"
                }
            }
            if !deny, let owner {
                later(model, seconds: 4) { fleet in
                    edit(&fleet, owner) { $0.state = .testing; $0.status = "running_tests"; $0.activity = "cargo test -p auth — 38 passed" }
                }
            }
            result = ["status": deny ? "denied" : "approved"]
        case "voice.command":
            let text = (args["text"]?.stringValue ?? "").lowercased()
            if text.contains("delete") {
                result = ["summary": "Deleting worktrees isn't something KalVoice does without a confirmed target.", "outcome": "refused"]
            } else if text.trimmingCharacters(in: .whitespaces).count < 8 {
                result = ["summary": "Which agent do you mean?", "outcome": "clarify"]
            } else {
                let active = fleet.agents.filter { $0.state.isActive }.count
                let needs = fleet.needsYou.count
                let first = fleet.needsYou.first?.title.map { " First up: \($0)" } ?? ""
                result = ["summary": "\(active) agents are working and \(needs == 0 ? "nothing needs you" : "\(needs) need\(needs == 1 ? "s" : "") you").\(first)", "outcome": "done"]
            }
        case "run.detail":
            let runId = args["runId"]?.stringValue ?? ""
            result = [
                "run": try JSONSerialization.jsonObject(with: JSONEncoder.demo.encode(fleet.run(runId) ?? Run(id: runId))),
                "logs": ["$ cargo test -p git", "   Compiling git v0.3.2 (crates/git)", "    Finished test [unoptimized + debuginfo] target(s) in 41.2s",
                         "     Running unittests src/lib.rs", "test status::tests::clean_tree ... ok", "test status::tests::untracked ... ok",
                         "test status::tests::rename_detection ... FAILED", "warning: 2 tests took longer than 5s", "error: test failed, to rerun pass `-p git --lib`"],
                "tests": [["name": "status::tests::clean_tree", "status": "passed", "durationMs": 12],
                          ["name": "status::tests::untracked", "status": "passed", "durationMs": 31],
                          ["name": "status::tests::rename_detection", "status": "failed", "durationMs": 5_400],
                          ["name": "diff::tests::binary_files_are_skipped", "status": "passed", "durationMs": 8]],
            ]
        case "tidy.closeIdle":
            let idle = fleet.agents.filter { $0.state == .idle }.count
            update(model) { $0.agents.removeAll { $0.state == .idle } }
            result = ["summary": idle == 1 ? "Closed 1 idle agent" : "Closed \(idle) idle agents"]
        default:
            throw RemoteRequestError.remote(code: "invalid", message: "Unknown op \(op)")
        }
        let data = try JSONSerialization.data(withJSONObject: ["result": result])
        return try JSONDecoder.remote.decode(ResultEnvelope<T>.self, from: data).result
    }

    // MARK: Simulated fleet changes

    private static func update(_ model: AppModel, _ change: (inout FleetState) -> Void) {
        guard model.client.isSimulated else { return }
        var fleet = model.client.fleet
        change(&fleet)
        model.client.simulate(fleet: fleet, status: model.client.status, workstation: model.client.workstation)
    }

    private static func later(_ model: AppModel, seconds: Double, _ change: @escaping (inout FleetState) -> Void) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
            update(model, change)
        }
    }

    private static func edit(_ fleet: inout FleetState, _ id: String, _ change: (inout Agent) -> Void) {
        guard let i = fleet.agents.firstIndex(where: { $0.id == id }) else { return }
        change(&fleet.agents[i])
        fleet.agents[i].lastActivityAt = Date()
    }

    // MARK: Content

    private static func conversation(_ agent: Agent, iso: (TimeInterval) -> String) -> [[String: Any]] {
        if agent.id == "thr_login" {
            return [
                ["role": "user", "text": "The login redirect drops the `next` param after the OAuth callback. Fix it and add a test.", "at": iso(1_400)],
                ["role": "assistant", "text": "I traced it to `handleCallback` in auth/session.rs — it rebuilds the URL from the provider's state and loses the query string. I'll preserve `next` through the state blob and validate it's a same-origin path.", "at": iso(1_300)],
                ["role": "assistant", "text": "Patched `handleCallback` and `encode_state`. Added `callback_preserves_next_param` and a same-origin guard test. Running the auth tests now.", "at": iso(60)],
            ]
        }
        var out: [[String: Any]] = [
            ["role": "user", "text": agent.displayName + ".", "at": iso(1_200)],
            ["role": "assistant", "text": "On it. I'll work on `\(agent.branch ?? "main")` in \(agent.workspaceName ?? "the workspace") and report back with a diff.", "at": iso(1_150)],
        ]
        if let error = agent.error {
            out.append(["role": "assistant", "text": "I hit a blocker: \(error). Retry once the toolchain is updated, or tell me to pin the previous version.", "at": iso(300)])
        } else if let activity = agent.activity {
            out.append(["role": "assistant", "text": "\(activity).", "at": iso(30)])
        }
        return out
    }

    private static func tools(_ agent: Agent, iso: (TimeInterval) -> String) -> [[String: Any]] {
        if agent.id == "thr_login" {
            return [
                ["name": "read_file", "summary": "crates/auth/src/session.rs", "status": "completed", "at": iso(1_350)],
                ["name": "edit_file", "summary": "crates/auth/src/session.rs (+18 −4)", "status": "completed", "at": iso(900)],
                ["name": "edit_file", "summary": "crates/auth/tests/callback.rs (+42)", "status": "completed", "at": iso(700)],
                ["name": "bash", "summary": "cargo test -p auth", "status": agent.state == .needsYou ? "waiting" : "completed", "at": iso(40)],
            ]
        }
        return [
            ["name": "search", "summary": "\(agent.workspaceName ?? "workspace") — \(agent.filesChanged ?? 1) matching files", "status": "completed", "at": iso(1_100)],
            ["name": "edit_file", "summary": "\(agent.filesChanged ?? 1) file\((agent.filesChanged ?? 1) == 1 ? "" : "s") changed", "status": "completed", "at": iso(600)],
        ]
    }

    private static let diff: [String: Any] = [
        "truncated": false,
        "files": [
            ["path": "crates/auth/src/session.rs", "status": "modified", "additions": 18, "deletions": 4, "hunks": [
                ["header": "@@ -112,14 +112,28 @@ pub fn handle_callback(req: &Request) -> Result<Redirect> {", "lines": [
                    ["ctx", "    let state = decode_state(&req.query(\"state\")?)?;"],
                    ["ctx", "    let session = exchange_code(&req.query(\"code\")?).await?;"],
                    ["del", "    let target = format!(\"{}/\", config().app_origin);"],
                    ["del", "    Ok(Redirect::to(target))"],
                    ["add", "    // Preserve where the person was going, but only within our own origin."],
                    ["add", "    let next = state.next.as_deref().filter(|p| is_same_origin_path(p)).unwrap_or(\"/\");"],
                    ["add", "    let target = format!(\"{}{}\", config().app_origin, next);"],
                    ["add", "    tracing::debug!(%target, \"oauth callback redirect\");"],
                    ["add", "    Ok(Redirect::to(target))"],
                    ["ctx", "}"],
                    ["ctx", ""],
                    ["add", "fn is_same_origin_path(p: &str) -> bool {"],
                    ["add", "    p.starts_with('/') && !p.starts_with(\"//\") && !p.contains(\"://\")"],
                    ["add", "}"],
                ]],
            ]],
            ["path": "crates/auth/tests/callback.rs", "status": "added", "additions": 42, "deletions": 0, "hunks": [
                ["header": "@@ -0,0 +1,12 @@", "lines": [
                    ["add", "use auth::session::*;"],
                    ["add", ""],
                    ["add", "#[tokio::test]"],
                    ["add", "async fn callback_preserves_next_param() {"],
                    ["add", "    let req = fake_callback(\"/projects/kalcode?tab=agents\");"],
                    ["add", "    let redirect = handle_callback(&req).await.unwrap();"],
                    ["add", "    assert_eq!(redirect.location(), \"https://app.kalcoded.com/projects/kalcode?tab=agents\");"],
                    ["add", "}"],
                ]],
            ]],
            ["path": "apps/desktop/src/features/auth/components/OAuthCallbackBoundary.tsx", "status": "modified", "additions": 3, "deletions": 1, "hunks": [
                ["header": "@@ -40,6 +40,8 @@ export function OAuthCallbackBoundary({ children }: Props) {", "lines": [
                    ["ctx", "  const params = useSearchParams();"],
                    ["del", "  const next = '/';"],
                    ["add", "  const next = params.get('next') ?? '/';"],
                    ["add", "  // keep in sync with is_same_origin_path"],
                    ["add", "  if (!next.startsWith('/') || next.startsWith('//')) return <Navigate to=\"/\" replace />;"],
                    ["ctx", "  return <Navigate to={next} replace />;"],
                ]],
            ]],
            ["path": "docs/auth.md", "status": "deleted", "additions": 0, "deletions": 2, "hunks": []],
        ],
    ]
}

private extension JSONEncoder {
    static var demo: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(RFC3339.format(date))
        }
        return e
    }
}
