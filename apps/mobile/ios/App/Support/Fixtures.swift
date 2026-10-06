#if DEBUG
import Foundation
import RemoteKit

/// Development-only fixtures (`-kc-fixture <name>`) for design review without a workstation.
/// Never compiled into Release.
///
/// Names: fleet (default), reconnecting, offline, connecting, removed, empty, big (200 agents).
@MainActor
enum Fixtures {
    static func load(_ name: String, into model: AppModel) {
        let now = Date()
        let workstation = PairedWorkstation(
            wid: "ws_9f3c2a71", name: "Kaleb's Workstation",
            publicKey: Data(repeating: 7, count: 32),
            addrs: ["192.168.1.20:47820", "100.101.7.40:47820"],
            deviceId: "dev_4e81b0", pairedAt: now.addingTimeInterval(-86_400 * 3),
            host: hostInfo
        )
        switch name {
        case "removed":
            model.removedNameOverride = workstation.name
            model.client.debugLoad(fleet: FleetState(), status: .removed(.revoked), workstation: nil)
        case "empty":
            model.client.debugLoad(fleet: fleet(agents: [], needs: [], now: now), status: .online, workstation: workstation)
        case "big":
            model.client.debugLoad(fleet: fleet(agents: bigAgents(now), needs: needs(now), now: now), status: .online, workstation: workstation)
        case "reconnecting":
            model.client.debugLoad(fleet: fleet(agents: agents(now), needs: needs(now), now: now), status: .reconnecting(since: now), workstation: workstation)
        case "offline":
            model.client.debugLoad(fleet: fleet(agents: agents(now), needs: needs(now), now: now), status: .offline(.unreachable), workstation: workstation)
        case "connecting":
            model.client.debugLoad(fleet: FleetState(), status: .connecting, workstation: workstation)
        default:
            model.client.debugLoad(fleet: fleet(agents: agents(now), needs: needs(now), now: now), status: .online, workstation: workstation)
        }
    }

    static var hostInfo: HostInfo? {
        try? JSONDecoder().decode(HostInfo.self, from: Data(#"{"platform":"windows","version":"0.1.9","build":2007}"#.utf8))
    }

    static func fleet(agents: [Agent], needs: [NeedsYouItem], now: Date) -> FleetState {
        var f = FleetState()
        f.apply(snapshot: FleetSnapshot(
            workstation: Workstation(id: "ws_9f3c2a71", name: "Kaleb's Workstation", platform: "windows", version: "0.1.9", build: 2007, activeWorkspaceId: "wsp_kalcode"),
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
        Workspace(id: "wsp_kalcode", name: "KalCode", path: "C:/Users/Kaleb/Downloads/KalCode"),
        Workspace(id: "wsp_site", name: "kalcoded.com", path: "C:/dev/kalcoded.com"),
        Workspace(id: "wsp_remote", name: "kc-remote-ios", path: "C:/kc-remote-ios"),
    ]

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

    static func bigAgents(_ now: Date) -> [Agent] {
        let base = agents(now)
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

/// Answers operations locally in fixture mode (DEBUG only). Results go through the same
/// decoders as real responses.
@MainActor
enum FixtureResponder {
    static func respond<T: Decodable>(_ op: String, _ args: [String: JSONValue], model: AppModel, as type: T.Type) async throws -> T {
        try await Task.sleep(nanoseconds: 380_000_000)
        let now = Date()
        func iso(_ s: TimeInterval) -> String { RFC3339.format(now.addingTimeInterval(-s)) }
        let agentId = args["agentId"]?.stringValue ?? ""
        let result: Any
        switch op {
        case "agent.detail":
            guard let agent = model.client.fleet.agent(agentId) else { throw RemoteRequestError.remote(code: "not_found", message: nil) }
            let agentJSON = try JSONSerialization.jsonObject(with: JSONEncoder.fixture.encode(agent))
            result = [
                "agent": agentJSON,
                "messages": [
                    ["role": "user", "text": "The login redirect drops the `next` param after the OAuth callback. Fix it and add a test.", "at": iso(1_400)],
                    ["role": "assistant", "text": "I traced it to `handleCallback` in auth/session.rs — it rebuilds the URL from the provider's state and loses the query string. I'll preserve `next` through the state blob and validate it's a same-origin path.", "at": iso(1_300)],
                    ["role": "assistant", "text": "Patched `handleCallback` and `encode_state`. Added `callback_preserves_next_param` and a same-origin guard test. Running the auth tests now.", "at": iso(60)],
                ],
                "tools": [
                    ["name": "read_file", "summary": "crates/auth/src/session.rs", "status": "completed", "at": iso(1_350)],
                    ["name": "edit_file", "summary": "crates/auth/src/session.rs (+18 −4)", "status": "completed", "at": iso(900)],
                    ["name": "edit_file", "summary": "crates/auth/tests/callback.rs (+42)", "status": "completed", "at": iso(700)],
                    ["name": "bash", "summary": "cargo test -p auth", "status": "waiting", "at": iso(40)],
                ],
                "worktree": ["path": "C:/Users/Kaleb/.kalcode/worktrees/kalcode/\(agent.branch ?? "main")", "branch": agent.branch ?? "main", "baseBranch": "main"],
            ]
        case "agent.diff":
            result = [
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
                    ["path": "apps/desktop/src/features/auth/very/deeply/nested/components/OAuthCallbackBoundary.tsx", "status": "modified", "additions": 3, "deletions": 1, "hunks": [
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
                "workspaces": workspacesJSON(),
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
            result = ["agentId": NSNull(), "summary": "Launched 1 agent in KalCode"]
        case "agent.prompt":
            result = ["summary": "Sent to \(model.client.fleet.agent(agentId)?.providerName ?? "the agent")"]
        case "agent.stop":
            result = ["summary": "Stopping \(model.client.fleet.agent(agentId)?.displayName ?? "agent")"]
        case "agent.retry":
            result = ["summary": "Retrying \(model.client.fleet.agent(agentId)?.displayName ?? "agent")"]
        case "needs.decide":
            let approvalId = args["approvalId"]?.stringValue
            var fleet = model.client.fleet
            fleet.needsYou.removeAll { $0.approvalId == approvalId }
            if let i = fleet.agents.firstIndex(where: { $0.id == "thr_login" }) {
                fleet.agents[i].state = .working
                fleet.agents[i].pendingApprovals = 0
                fleet.agents[i].activity = "Running cargo test -p auth"
            }
            model.client.debugLoad(fleet: fleet, status: .online, workstation: model.client.workstation)
            result = ["status": args["decision"]?.stringValue == "deny" ? "denied" : "approved"]
        case "voice.command":
            let text = (args["text"]?.stringValue ?? "").lowercased()
            if text.contains("delete") {
                result = ["summary": "Deleting worktrees isn't something KalVoice does without a confirmed target.", "outcome": "refused"]
            } else if text.count < 8 {
                result = ["summary": "Which agent do you mean?", "outcome": "clarify"]
            } else {
                result = ["summary": "3 agents are working, 1 needs you (Fix login redirect wants to run cargo test).", "outcome": "done"]
            }
        case "run.detail":
            let runId = args["runId"]?.stringValue ?? ""
            result = [
                "run": try JSONSerialization.jsonObject(with: JSONEncoder.fixture.encode(model.client.fleet.run(runId) ?? Run(id: runId))),
                "logs": ["$ cargo test -p git", "   Compiling git v0.3.2 (crates/git)", "    Finished test [unoptimized + debuginfo] target(s) in 41.2s",
                         "     Running unittests src/lib.rs", "test status::tests::clean_tree ... ok", "test status::tests::untracked ... ok",
                         "test status::tests::rename_detection ... FAILED", "warning: 2 tests took longer than 5s", "error: test failed, to rerun pass `-p git --lib`"],
                "tests": [["name": "status::tests::clean_tree", "status": "passed", "durationMs": 12],
                          ["name": "status::tests::untracked", "status": "passed", "durationMs": 31],
                          ["name": "status::tests::rename_detection", "status": "failed", "durationMs": 5_400],
                          ["name": "diff::tests::binary_files_are_skipped", "status": "passed", "durationMs": 8]],
            ]
        case "tidy.closeIdle":
            result = ["summary": "Closed 1 idle agent"]
        default:
            throw RemoteRequestError.remote(code: "invalid", message: "Unknown op \(op)")
        }
        let data = try JSONSerialization.data(withJSONObject: ["result": result])
        return try JSONDecoder.remote.decode(ResultEnvelope<T>.self, from: data).result
    }

    private static func workspacesJSON() -> [[String: Any]] {
        Fixtures.workspaces.map { ["id": $0.id, "name": $0.name ?? "", "path": $0.path ?? ""] }
    }
}

private extension JSONEncoder {
    static var fixture: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .custom { date, encoder in
            var c = encoder.singleValueContainer()
            try c.encode(RFC3339.format(date))
        }
        return e
    }
}
#endif
