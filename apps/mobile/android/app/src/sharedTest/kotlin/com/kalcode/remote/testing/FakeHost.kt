package com.kalcode.remote.testing

import com.kalcode.remote.protocol.Agent
import com.kalcode.remote.protocol.AgentState
import com.kalcode.remote.protocol.AppMessageDecoder
import com.kalcode.remote.protocol.Base64Any
import com.kalcode.remote.protocol.DeviceHello
import com.kalcode.remote.protocol.Environment
import com.kalcode.remote.protocol.Framing
import com.kalcode.remote.protocol.HandshakeReply
import com.kalcode.remote.protocol.HandshakeState
import com.kalcode.remote.protocol.HostBuild
import com.kalcode.remote.protocol.KeyPair
import com.kalcode.remote.protocol.NeedsYouItem
import com.kalcode.remote.protocol.PairingPayload
import com.kalcode.remote.protocol.Patch
import com.kalcode.remote.protocol.RemoteState
import com.kalcode.remote.protocol.Removals
import com.kalcode.remote.protocol.Run
import com.kalcode.remote.protocol.Service
import com.kalcode.remote.protocol.TransportState
import com.kalcode.remote.protocol.Upserts
import com.kalcode.remote.protocol.WireJson
import com.kalcode.remote.protocol.Workspace
import com.kalcode.remote.protocol.Workstation
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.io.BufferedInputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.Collections
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * A fake KalCode workstation speaking the real protocol (Noise IK responder, framing, snapshot,
 * patches, requests, notify, bye) on 127.0.0.1. Used by the JVM tests and the on-device UI tests
 * so both exercise the production client end to end.
 */
class FakeHost(agentCount: Int = 4, val name: String = "Test Workstation") {
    val key: KeyPair = KeyPair.generate()
    val wid = "ws_fake0000000000000000test"
    private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    val port: Int get() = server.localPort

    private val random = SecureRandom()
    @Volatile private var code: ByteArray = ByteArray(32).also(random::nextBytes)
    @Volatile private var codeUsed = false
    @Volatile var accepting = true
    @Volatile var rejectWith: String? = null

    private val devices = Collections.synchronizedMap(mutableMapOf<String, String>()) // public b64 → deviceId
    private val revoked = Collections.synchronizedSet(mutableSetOf<String>())

    /** Every request id the host executed, in order (duplicates show a double execution). */
    val executed: MutableList<String> = Collections.synchronizedList(mutableListOf())
    val received: MutableList<Pair<String, JsonObject>> = Collections.synchronizedList(mutableListOf())

    /** When true, the host stops answering pings (a silent, half-dead connection). */
    @Volatile var mute = false

    /** When true, requests are held (not answered) until [releaseHeld]. */
    @Volatile var holdRequests = false
    private val held = CopyOnWriteArrayList<() -> Unit>()

    private val sessions = CopyOnWriteArrayList<Session>()
    @Volatile var state: RemoteState = initialState(agentCount)
        private set
    @Volatile private var closed = false
    private val cache = java.util.concurrent.ConcurrentHashMap<String, String>()
    private val running: MutableSet<String> = Collections.synchronizedSet(mutableSetOf())

    /** Ops answered `refused` / `rate limited` (the desktop's per-device limits). */
    val rateLimited: MutableSet<String> = Collections.synchronizedSet(mutableSetOf())

    init {
        thread(isDaemon = true, name = "fake-host-accept") {
            while (!closed) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                if (!accepting) {
                    runCatching { socket.close() }
                    continue
                }
                thread(isDaemon = true, name = "fake-host-conn") { serve(socket) }
            }
        }
    }

    fun pairingPayload(addr: String = "127.0.0.1:$port", expSeconds: Long = System.currentTimeMillis() / 1000 + 300) =
        PairingPayload(1, wid, name, Base64Any.encode(key.public), Base64Any.encode(code), listOf(addr), expSeconds)

    fun pairingLink(addr: String = "127.0.0.1:$port"): String {
        val json = WireJson.encodeToString(PairingPayload.serializer(), pairingPayload(addr))
        return "kalcode-remote://pair?d=" + Base64Any.encodeUrl(json.toByteArray())
    }

    fun newPairingCode() {
        code = ByteArray(32).also(random::nextBytes)
        codeUsed = false
    }

    val liveSessions: Int get() = sessions.size

    // ---- state changes ----

    fun upsertAgent(agent: Agent) {
        state = state.copy(agents = state.agents.filterNot { it.id == agent.id } + agent)
        broadcastPatch { Patch(rev = it, upsert = Upserts(agents = listOf(agent))) }
    }

    fun removeAgent(id: String) {
        state = state.copy(agents = state.agents.filterNot { it.id == id })
        broadcastPatch { Patch(rev = it, remove = Removals(agents = listOf(id))) }
    }

    fun removeNeeds(id: String) {
        state = state.copy(needsYou = state.needsYou.filterNot { it.id == id })
        broadcastPatch { Patch(rev = it, remove = Removals(needsYou = listOf(id))) }
    }

    /** Sends a patch whose rev skips one, forcing the device to reconnect. */
    fun sendGapPatch() {
        sessions.forEach { s -> s.send(WireJson.encodeToString(Patch.serializer(), Patch(rev = s.rev + 2)).withType("patch")) }
    }

    fun notifyAll(id: String, kind: String, title: String, body: String, link: String) {
        val json = buildJsonObject {
            put("t", "notify"); put("id", id); put("kind", kind); put("title", title); put("body", body); put("link", link)
        }.toString()
        sessions.forEach { it.send(json) }
    }

    fun revokeAll() {
        synchronized(devices) { revoked.addAll(devices.keys) }
        sessions.forEach { it.bye("revoked") }
    }

    fun byeAll(reason: String) = sessions.forEach { it.bye(reason) }

    /** Simulates a network loss: closes every socket without a bye. */
    fun dropAll() = sessions.forEach { it.close() }

    fun releaseHeld() {
        val all = held.toList()
        held.clear()
        all.forEach { it() }
    }

    fun close() {
        closed = true
        runCatching { server.close() }
        dropAll()
    }

    private fun broadcastPatch(make: (Long) -> Patch) {
        sessions.forEach { s ->
            synchronized(s) {
                s.rev += 1
                s.send(WireJson.encodeToString(Patch.serializer(), make(s.rev)).withType("patch"))
            }
        }
    }

    private fun String.withType(t: String) = "{\"t\":\"$t\"," + substring(1)

    // ---- connection ----

    private inner class Session(val socket: Socket, val out: OutputStream, val transport: TransportState) {
        var rev = 0L
        fun send(json: String) {
            synchronized(this) {
                runCatching {
                    out.write(Framing.encodeAppMessage(json.toByteArray(), transport.send))
                    out.flush()
                }
            }
        }
        fun bye(reason: String) {
            send("""{"t":"bye","reason":"$reason"}""")
            close()
        }
        fun close() {
            runCatching { socket.close() }
            sessions.remove(this)
        }
    }

    private fun serve(socket: Socket) {
        try {
            socket.tcpNoDelay = true
            val input = BufferedInputStream(socket.getInputStream())
            val out = socket.getOutputStream()
            val hs = HandshakeState.responder(key)
            val hello = WireJson.decodeFromString(DeviceHello.serializer(), String(hs.readMessage(Framing.readFrame(input))))
            val remote = Base64Any.encode(hs.remoteStatic!!)
            val decision: String? = rejectWith ?: when {
                remote in revoked -> "revoked"
                devices.containsKey(remote) -> null
                hello.pair == null -> "unpaired"
                codeUsed || hello.pair != Base64Any.encode(code) -> "pairing_expired"
                else -> {
                    codeUsed = true
                    devices[remote] = "dev_" + remote.take(8).filter { it.isLetterOrDigit() }
                    null
                }
            }
            val reply = if (decision != null) {
                HandshakeReply(ok = false, error = decision)
            } else {
                HandshakeReply(true, wid, name, devices[remote], HostBuild("windows", "0.1.9", 2007))
            }
            out.write(Framing.frame(hs.writeMessage(WireJson.encodeToString(HandshakeReply.serializer(), reply).toByteArray())))
            out.flush()
            if (decision != null) {
                socket.close()
                return
            }
            val session = Session(socket, out, hs.split())
            val decoder = AppMessageDecoder()
            fun next(): JsonObject {
                while (true) {
                    decoder.next()?.let { return WireJson.parseToJsonElement(String(it)) as JsonObject }
                    decoder.feed(session.transport.receive.decrypt(ByteArray(0), Framing.readFrame(input)))
                }
            }
            if (next()["t"].str() != "hello") return socket.close()
            sessions.add(session)
            synchronized(session) {
                session.rev = 1
                session.send(snapshotJson(1))
            }
            while (true) {
                val msg = next()
                when (msg["t"].str()) {
                    "ping" -> if (!mute) session.send("""{"t":"pong","n":${msg["n"].str()}}""")
                    "hello" -> synchronized(session) {
                        session.rev += 1
                        session.send(snapshotJson(session.rev))
                    }
                    "req" -> {
                        val id = msg["id"].str() ?: ""
                        val op = msg["op"].str() ?: ""
                        val args = msg["args"] as? JsonObject ?: JsonObject(emptyMap())
                        received += op to args
                        val stored = cache[id]
                        when {
                            // §1 replay protection: a repeated id returns the stored result …
                            stored != null -> session.send(stored)
                            // … and a repeat while the first copy still runs is `conflict`.
                            id in running -> session.send(err(id, "conflict", "still running"))
                            rateLimited.contains(op) -> session.send(err(id, "refused", "rate limited"))
                            else -> {
                                running += id
                                executed += id
                                val answer = {
                                    val r = response(id, op, args)
                                    cache[id] = r
                                    running -= id
                                    session.send(r)
                                }
                                if (holdRequests) held += answer else answer()
                            }
                        }
                    }
                }
            }
        } catch (_: Exception) {
            runCatching { socket.close() }
        } finally {
            sessions.removeAll { it.socket === socket }
        }
    }

    private fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.contentOrNull

    private fun snapshotJson(rev: Long): String = buildJsonObject {
        put("t", "snapshot")
        put("rev", rev)
        put("state", WireJson.encodeToJsonElement(RemoteState.serializer(), state))
    }.toString()

    private fun ok(id: String, result: JsonObject) = buildJsonObject {
        put("t", "res"); put("id", id); put("ok", true); put("result", result)
    }.toString()

    private fun err(id: String, code: String, message: String) = buildJsonObject {
        put("t", "res"); put("id", id); put("ok", false)
        putJsonObject("error") { put("code", code); put("message", message) }
    }.toString()

    private fun response(id: String, op: String, args: JsonObject): String {
        val agentId = args["agentId"].str()
        val agent = agentId?.let { a -> state.agents.firstOrNull { it.id == a } }
        return when (op) {
            "agent.detail" -> agent?.let {
                ok(id, buildJsonObject {
                    put("agent", WireJson.encodeToJsonElement(Agent.serializer(), it))
                    putJsonArray("messages") {
                        add(buildJsonObject { put("role", "user"); put("text", it.name); put("at", "2026-10-05T21:09:27Z") })
                        add(buildJsonObject {
                            put("role", "assistant")
                            put("text", "Found it: the query string is dropped in `buildReturnUrl`. Fixing and adding coverage.")
                            put("at", "2026-10-05T21:10:27Z")
                        })
                    }
                    putJsonArray("tools") {
                        add(buildJsonObject { put("name", "Edit"); put("summary", "src/auth/redirect.ts (+12 −3)"); put("status", "succeeded"); put("at", "2026-10-05T21:10:30Z") })
                    }
                    putJsonObject("worktree") { put("path", "C:/dev/.kalcode/worktrees/x"); put("branch", it.branch ?: "main"); put("baseBranch", "main") }
                })
            } ?: err(id, "not_found", "This agent has ended")
            "agent.diff" -> agent?.let {
                ok(id, buildJsonObject {
                    putJsonArray("files") {
                        add(buildJsonObject {
                            put("path", "src/auth/redirect.ts"); put("status", "modified"); put("additions", 2); put("deletions", 1)
                            putJsonArray("hunks") {
                                add(buildJsonObject {
                                    put("header", "@@ -14,3 +14,4 @@ export function buildReturnUrl(req: Request): string {")
                                    put("lines", buildJsonArray {
                                        add(buildJsonArray { add(JsonPrimitive("ctx")); add(JsonPrimitive("  const target = new URL(req.url);")) })
                                        add(buildJsonArray { add(JsonPrimitive("del")); add(JsonPrimitive("  return next.split(\"?\")[0];")) })
                                        add(buildJsonArray { add(JsonPrimitive("add")); add(JsonPrimitive("  if (!next) return \"/\";")) })
                                        add(buildJsonArray { add(JsonPrimitive("add")); add(JsonPrimitive("  return next;")) })
                                    })
                                })
                            }
                        })
                    }
                    put("truncated", false)
                })
            } ?: err(id, "not_found", "This agent has ended")
            "agent.prompt" -> when {
                agent == null -> err(id, "not_found", "This agent has ended")
                agent.pendingApprovals > 0 -> err(id, "refused", "This agent is waiting for an approval. Answer it first.")
                else -> ok(id, buildJsonObject { put("summary", "Sent to ${agent.name}") })
            }
            "agent.stop" -> agent?.let { ok(id, buildJsonObject { put("summary", "Stopped ${it.name}") }) } ?: err(id, "not_found", "This agent has ended")
            "agent.retry" -> agent?.let { ok(id, buildJsonObject { put("summary", "Resumed ${it.name}") }) } ?: err(id, "not_found", "This agent has ended")
            "needs.decide" -> {
                val approval = args["approvalId"].str()
                val item = state.needsYou.firstOrNull { it.approvalId == approval }
                if (item == null) {
                    ok(id, buildJsonObject { put("status", "already_answered") })
                } else {
                    thread { removeNeeds(item.id) }
                    ok(id, buildJsonObject { put("status", if (args["decision"].str() == "deny") "denied" else "approved") })
                }
            }
            "launch.options" -> ok(id, buildJsonObject {
                put("workspaces", WireJson.encodeToJsonElement(kotlinx.serialization.builtins.ListSerializer(Workspace.serializer()), state.workspaces))
                putJsonArray("providers") {
                    add(buildJsonObject {
                        put("id", "claude-code"); put("name", "Claude Code")
                        putJsonArray("accounts") {
                            add(buildJsonObject { put("id", "claude-code:work"); put("label", "Work") })
                            add(buildJsonObject { put("id", "claude-code:personal"); put("label", "Personal") })
                        }
                        putJsonArray("models") {
                            add(buildJsonObject {
                                put("id", "claude-opus-5-5"); put("name", "Claude Opus 5.5")
                                putJsonArray("efforts") { add(JsonPrimitive("low")); add(JsonPrimitive("medium")); add(JsonPrimitive("high")) }
                            })
                        }
                    })
                }
            })
            "agent.launch" -> {
                val newId = "thr_new${state.agents.size}"
                val ws = state.workspaces.firstOrNull { it.id == args["workspaceId"].str() }
                if (ws == null) {
                    err(id, "not_found", "That workspace is not open")
                } else {
                    val now = System.currentTimeMillis()
                    thread {
                        upsertAgent(
                            Agent(
                                id = newId, name = args["prompt"].str() ?: "New agent", workspaceId = ws.id, workspaceName = ws.name,
                                providerId = "claude-code", providerName = "Claude Code", accountLabel = "Work",
                                model = args["model"].str(), effort = args["effort"].str(), state = AgentState.STARTING,
                                status = "starting", activity = "Starting", createdAt = now, lastActivityAt = now,
                            ),
                        )
                    }
                    ok(id, buildJsonObject { put("agentId", newId); put("summary", "Started Claude Code in ${ws.name}") })
                }
            }
            "voice.command" -> ok(id, buildJsonObject {
                put("summary", "${state.agents.count { it.state.isActive }} agents working, ${state.needsYou.size} need you")
                put("outcome", "done")
            })
            "run.detail" -> {
                val run = state.runs.firstOrNull { it.id == args["runId"].str() }
                if (run == null) err(id, "not_found", "This run has finished") else ok(id, buildJsonObject {
                    put("run", WireJson.encodeToJsonElement(Run.serializer(), run))
                    putJsonArray("logs") { add(JsonPrimitive("   Compiling kalcode-git v0.0.0")); add(JsonPrimitive("test result: ok. 214 passed")) }
                    putJsonArray("tests") {
                        add(buildJsonObject { put("name", "diff::renames_are_detected"); put("status", "passed"); put("durationMs", 12) })
                    }
                })
            }
            "tidy.closeIdle" -> ok(id, buildJsonObject { put("summary", "Closed 0 idle agents") })
            else -> err(id, "invalid", "unknown operation $op")
        }
    }

    companion object {
        val NAMES = listOf("Fix login redirect", "Add dark mode toggle", "Refactor billing service", "Write checkout e2e tests", "Speed up cold start", "Migrate settings to SQLite")

        fun initialState(count: Int): RemoteState {
            val now = System.currentTimeMillis()
            val states = listOf(AgentState.NEEDS_YOU, AgentState.WORKING, AgentState.FAILED, AgentState.DONE, AgentState.TESTING, AgentState.IDLE)
            val agents = (0 until count).map { i ->
                val state = states[i % states.size]
                Agent(
                    id = "thr_%04d".format(i + 1),
                    name = NAMES[i % NAMES.size] + if (i >= NAMES.size) " #${i / NAMES.size + 1}" else "",
                    workspaceId = "wsp_KalCode", workspaceName = "KalCode",
                    providerId = "claude-code", providerName = "Claude Code", accountLabel = "Work",
                    model = "claude-opus-5-5", effort = "high", state = state, status = state.wire,
                    activity = if (state.isActive) "Running npm test" else null,
                    branch = "kal/fix-$i", worktree = true, filesChanged = i % 5,
                    pendingApprovals = if (state == AgentState.NEEDS_YOU) 1 else 0,
                    error = if (state == AgentState.FAILED) "Tests failed: 2 of 148" else null,
                    createdAt = now - (i + 1) * 60_000L, lastActivityAt = now - 5_000,
                )
            }
            val needs = agents.filter { it.state == AgentState.NEEDS_YOU }.mapIndexed { i, a ->
                NeedsYouItem(
                    id = "approval:apr_%04d".format(i + 1), kind = "approval", title = "Run `cargo test -p git`?",
                    detail = "Claude Code wants to run a command in KalCode", agentId = a.id, approvalId = "apr_%04d".format(i + 1),
                    createdAt = now - 30_000, actions = listOf("approve_once", "deny", "open"),
                )
            }
            return RemoteState(
                workstation = Workstation("ws_fake0000000000000000test", "Test Workstation", "windows", "0.1.9", 2007, "wsp_KalCode"),
                workspaces = listOf(Workspace("wsp_KalCode", "KalCode", "C:/dev/KalCode", now), Workspace("wsp_website", "website", "C:/dev/website", now - 3_600_000)),
                agents = agents,
                needsYou = needs,
                runs = listOf(
                    Run("op_nightly", "Nightly tests", "test", "running", null, "main", "cargo test -p git", null, now),
                    Run("op_deploy_web", "Deploy website to staging", "deploy", "succeeded", null, "main", null, "Deployed 41a9c2e", now - 600_000),
                ),
                services = listOf(Service("svc_web", "web", "running", "http://localhost:5173"), Service("svc_worker", "worker", "stopped", null)),
                environments = listOf(
                    Environment("env_prod", "Production", "production", "deployed", "healthy", "https://kalcoded.com", now - 86_400_000),
                    Environment("env_staging", "Staging", "staging", "deploying", "healthy", "https://staging.kalcoded.com", now - 3_600_000),
                ),
            )
        }
    }
}
