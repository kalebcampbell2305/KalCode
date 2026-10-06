package com.kalcode.remote.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class FleetStateTest {
    // The exact shapes the Rust host emits (wire.rs / diff.rs).
    private val snapshotJson = """
        {"t":"snapshot","rev":1,"state":{
          "workstation":{"id":"ws_1","name":"Dev Workstation","platform":"windows","version":"0.1.9","build":2007,"activeWorkspaceId":"wsp_KalCode"},
          "workspaces":[{"id":"wsp_KalCode","name":"KalCode","path":"C:/Users/dev/KalCode","lastActiveAt":"2026-10-05T21:09:27Z"}],
          "agents":[
            {"id":"thr_0001","name":"Fix login redirect","workspaceId":"wsp_KalCode","workspaceName":"KalCode","providerId":"claude-code","providerName":"Claude Code","accountLabel":"Work","model":"claude-opus-5-5","effort":"high","state":"working","status":"running_tool","activity":"Running npm test","branch":"kal/fix-login","worktree":true,"filesChanged":4,"pendingApprovals":0,"error":null,"createdAt":"2026-10-05T21:09:27Z","lastActivityAt":"2026-10-05T21:10:27Z","runtime":"pane"},
            {"id":"thr_0002","name":"Add CSV export","workspaceId":"wsp_KalCode","workspaceName":"KalCode","providerId":"codex","providerName":"Codex","accountLabel":null,"model":null,"effort":null,"state":"needs_you","status":"awaiting_approval","activity":null,"branch":null,"worktree":false,"filesChanged":0,"pendingApprovals":1,"error":null,"createdAt":"2026-10-05T21:00:00Z","lastActivityAt":"2026-10-05T21:10:27Z","runtime":"headless"}
          ],
          "needsYou":[{"id":"approval:apr_1","kind":"approval","title":"Run `cargo test`?","detail":"Codex wants to run a command in KalCode","agentId":"thr_0002","approvalId":"apr_1","createdAt":"2026-10-05T21:10:00Z","actions":["approve_once","deny","open"]}],
          "runs":[{"id":"op_nightly","title":"Nightly tests","kind":"test","status":"running","agentId":null,"branch":"main","currentAction":"cargo test -p git","outcome":null,"updatedAt":"2026-10-05T21:10:00Z"}],
          "services":[{"id":"svc_web","name":"web","status":"running","url":"http://localhost:5173"}],
          "environments":[{"id":"env_prod","name":"Production","kind":"production","deploymentStatus":"deployed","health":"healthy","url":"https://kalcoded.com","lastDeployAt":null}]
        }}
    """.trimIndent()

    private fun snapshot(): FleetState {
        val m = HostMessage.parse(snapshotJson) as HostMessage.Snapshot
        return FleetState().applySnapshot(m.rev, m.state)
    }

    private fun patch(json: String): Patch = (HostMessage.parse(json) as HostMessage.PatchMessage).patch

    @Test
    fun snapshotReplacesEverything() {
        val s = snapshot()
        assertEquals(1L, s.rev)
        assertEquals("Dev Workstation", s.workstation?.name)
        assertEquals(2, s.agents.size)
        assertEquals(AgentState.WORKING, s.agent("thr_0001")?.state)
        assertEquals(1_791_234_567_000L, s.agent("thr_0001")?.createdAt)
        assertNull(s.agent("thr_0002")?.model)
        assertTrue(s.needsYou.single().canApprove)
        assertEquals("KalCode", s.activeWorkspace?.name)
        assertNull(s.environments.single().lastDeployAt)
        // A second snapshot replaces, never merges.
        val again = s.applySnapshot(7, RemoteState(Workstation("ws_1")))
        assertEquals(7L, again.rev)
        assertTrue(again.agents.isEmpty())
    }

    @Test
    fun patchUpsertsRemovesAndAdvancesRev() {
        val s = snapshot()
        val p = patch(
            """{"t":"patch","rev":2,"upsert":{"agents":[{"id":"thr_0001","name":"Fix login redirect","state":"done","status":"completed","worktree":true,"filesChanged":5,"pendingApprovals":0,"createdAt":"2026-10-05T21:09:27Z","lastActivityAt":"2026-10-05T21:12:00Z","runtime":"pane","workspaceId":"w","workspaceName":"KalCode","providerId":"claude-code","providerName":"Claude Code"},
                {"id":"thr_0003","name":"New","state":"starting","status":"starting","worktree":false,"filesChanged":0,"pendingApprovals":0,"createdAt":"2026-10-05T21:12:00Z","lastActivityAt":"2026-10-05T21:12:00Z","runtime":"pane","workspaceId":"w","workspaceName":"KalCode","providerId":"gemini","providerName":"Gemini"}]},
               "remove":{"needsYou":["approval:apr_1"]},
               "workstation":{"id":"ws_1","name":"Renamed","platform":"windows","version":"0.2.0","build":2100,"activeWorkspaceId":null}}""",
        )
        val out = s.applyPatch(p) as FleetState.PatchOutcome.Applied
        val n = out.state
        assertEquals(2L, n.rev)
        assertEquals(listOf("thr_0001", "thr_0002", "thr_0003"), n.agents.map { it.id }) // order kept, new appended
        assertEquals(AgentState.DONE, n.agent("thr_0001")?.state)
        assertEquals(5, n.agent("thr_0001")?.filesChanged)
        assertTrue(n.needsYou.isEmpty())
        assertEquals("Renamed", n.workstation?.name)
        assertEquals(1, n.runs.size) // untouched collections keep their items
    }

    @Test
    fun emptyPatchFromRustShapeApplies() {
        val p = patch("""{"t":"patch","rev":2,"upsert":{},"remove":{"needsYou":["approval:a"]}}""")
        assertTrue(snapshot().applyPatch(p) is FleetState.PatchOutcome.Applied)
    }

    @Test
    fun revGapIsReportedNeverGuessed() {
        val s = snapshot()
        val skipped = s.applyPatch(Patch(rev = 3))
        assertEquals(FleetState.PatchOutcome.Gap(2, 3), skipped)
        val repeated = s.applyPatch(Patch(rev = 1))
        assertTrue(repeated is FleetState.PatchOutcome.Gap)
        // A patch before any snapshot is a gap too.
        assertEquals(FleetState.PatchOutcome.Gap(null, 1), FleetState().applyPatch(Patch(rev = 1)))
    }

    @Test
    fun unknownAgentStateFromANewerDesktopIsUnknown() {
        val p = patch("""{"t":"patch","rev":2,"upsert":{"agents":[{"id":"x","state":"hyperdrive"}]}}""")
        val n = (snapshot().applyPatch(p) as FleetState.PatchOutcome.Applied).state
        assertEquals(AgentState.UNKNOWN, n.agent("x")?.state)
    }

    @Test
    fun sortingPutsNeedsYouFirstAndFiltersCount() {
        val s = snapshot()
        assertEquals("thr_0002", s.sortedAgents().first().id)
        assertEquals(1, s.count(FleetFilter.NEEDS_YOU))
        assertEquals(1, s.count(FleetFilter.WORKING))
        assertEquals(0, s.count(FleetFilter.FAILED))
        assertFalse(FleetFilter.DONE.matches(s.agent("thr_0001")!!))
    }

    @Test
    fun resAndNotifyAndUnknownMessagesParse() {
        val ok = HostMessage.parse("""{"t":"res","id":"9","ok":true,"result":{"summary":"Sent"}}""") as HostMessage.Res
        assertTrue(ok.ok)
        val bad = HostMessage.parse("""{"t":"res","id":"9","ok":false,"error":{"code":"not_found","message":"gone"}}""") as HostMessage.Res
        assertEquals("not_found", bad.error?.code)
        val n = HostMessage.parse("""{"t":"notify","id":"ntf_1","kind":"agent_done","title":"Done","body":"b","link":"kalcode-remote://agent/thr_1"}""")
        assertEquals("agent_done", (n as HostMessage.NotifyMessage).notify.kind)
        assertEquals(HostMessage.Unknown("future"), HostMessage.parse("""{"t":"future"}"""))
    }

    @Test
    fun diffLinesArePairs() {
        val json = WireJson.parseToJsonElement(
            """{"files":[{"path":"a.ts","status":"modified","additions":1,"deletions":1,"hunks":[{"header":"@@ -1 +1 @@","lines":[["del","x"],["add","y"],["ctx","z"]]}]}],"truncated":true}""",
        )
        val d = DiffResult.parse(json)
        assertTrue(d.truncated)
        assertEquals(listOf(DiffLineKind.DEL, DiffLineKind.ADD, DiffLineKind.CTX), d.files[0].hunks[0].lines.map { it.kind })
    }
}
