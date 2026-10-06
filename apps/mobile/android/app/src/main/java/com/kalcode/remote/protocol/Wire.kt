package com.kalcode.remote.protocol

import androidx.compose.runtime.Immutable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.time.OffsetDateTime

/** Wire types (protocol §2–§5, §8). Field names are camelCase; timestamps are RFC 3339. */
val WireJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
}

/** RFC 3339 → epoch millis; null or unparseable → null (never a fake time). */
@OptIn(ExperimentalSerializationApi::class)
object Rfc3339Millis : KSerializer<Long?> {
    override val descriptor = PrimitiveSerialDescriptor("Rfc3339Millis", PrimitiveKind.STRING).nullable

    override fun deserialize(decoder: Decoder): Long? {
        if (!decoder.decodeNotNullMark()) return decoder.decodeNull()
        return runCatching { OffsetDateTime.parse(decoder.decodeString()).toInstant().toEpochMilli() }.getOrNull()
    }

    override fun serialize(encoder: Encoder, value: Long?) {
        if (value == null) encoder.encodeNull() else encoder.encodeString(java.time.Instant.ofEpochMilli(value).toString())
    }
}

// ---- §3 handshake payloads --------------------------------------------------------------------

@Serializable
data class DeviceHello(
    val v: Int = 1,
    val device: String,
    val platform: String = "android",
    val model: String,
    val app: String,
    val pair: String? = null,
    val ts: Long,
)

@Serializable
data class HostBuild(val platform: String = "", val version: String = "", val build: Long = 0)

@Serializable
data class HandshakeReply(
    val ok: Boolean,
    val wid: String? = null,
    val name: String? = null,
    val deviceId: String? = null,
    val host: HostBuild? = null,
    val error: String? = null,
)

// ---- §4.1 state -------------------------------------------------------------------------------

@Immutable
@Serializable
data class Workstation(
    val id: String,
    val name: String = "",
    val platform: String = "",
    val version: String = "",
    val build: Long = 0,
    val activeWorkspaceId: String? = null,
)

@Immutable
@Serializable
data class Workspace(
    val id: String,
    val name: String = "",
    val path: String = "",
    @Serializable(with = Rfc3339Millis::class) val lastActiveAt: Long? = null,
)

/** Provider-agnostic agent state. Unknown values from a newer desktop map to [UNKNOWN]. */
@Serializable(with = AgentStateSerializer::class)
enum class AgentState(val wire: String) {
    STARTING("starting"), READY("ready"), WORKING("working"), TESTING("testing"), WAITING("waiting"),
    NEEDS_YOU("needs_you"), IDLE("idle"), DONE("done"), FAILED("failed"), STOPPED("stopped"), UNKNOWN("unknown");

    /** Starting, working or testing now (the desktop deck's "active"). */
    val isActive: Boolean get() = this == STARTING || this == WORKING || this == TESTING
    val needsAttention: Boolean get() = this == NEEDS_YOU || this == WAITING
    val isFinished: Boolean get() = this == DONE || this == STOPPED

    companion object {
        fun of(wire: String?): AgentState = entries.firstOrNull { it.wire == wire } ?: UNKNOWN
    }
}

object AgentStateSerializer : KSerializer<AgentState> {
    override val descriptor = PrimitiveSerialDescriptor("AgentState", PrimitiveKind.STRING)
    override fun deserialize(decoder: Decoder) = AgentState.of(decoder.decodeString())
    override fun serialize(encoder: Encoder, value: AgentState) = encoder.encodeString(value.wire)
}

@Immutable
@Serializable
data class Agent(
    val id: String,
    val name: String = "",
    val workspaceId: String = "",
    val workspaceName: String = "",
    val providerId: String = "",
    val providerName: String = "",
    val accountLabel: String? = null,
    val model: String? = null,
    val effort: String? = null,
    val state: AgentState = AgentState.UNKNOWN,
    val status: String = "",
    val activity: String? = null,
    val branch: String? = null,
    val worktree: Boolean = false,
    val filesChanged: Int = 0,
    val pendingApprovals: Int = 0,
    val error: String? = null,
    @Serializable(with = Rfc3339Millis::class) val createdAt: Long? = null,
    @Serializable(with = Rfc3339Millis::class) val lastActivityAt: Long? = null,
    val runtime: String = "pane",
)

@Immutable
@Serializable
data class NeedsYouItem(
    val id: String,
    /** approval | question | failed | auth | stalled | review */
    val kind: String = "",
    val title: String = "",
    val detail: String = "",
    val agentId: String? = null,
    val approvalId: String? = null,
    @Serializable(with = Rfc3339Millis::class) val createdAt: Long? = null,
    /** approve_once | deny | open */
    val actions: List<String> = emptyList(),
) {
    val canApprove: Boolean get() = approvalId != null && "approve_once" in actions
    val canDeny: Boolean get() = approvalId != null && "deny" in actions
}

@Immutable
@Serializable
data class Run(
    val id: String,
    val title: String = "",
    val kind: String = "",
    val status: String = "",
    val agentId: String? = null,
    val branch: String? = null,
    val currentAction: String? = null,
    val outcome: String? = null,
    @Serializable(with = Rfc3339Millis::class) val updatedAt: Long? = null,
)

@Immutable
@Serializable
data class Service(val id: String, val name: String = "", val status: String = "", val url: String? = null)

@Immutable
@Serializable
data class Environment(
    val id: String,
    val name: String = "",
    val kind: String = "",
    val deploymentStatus: String = "",
    val health: String? = null,
    val url: String? = null,
    @Serializable(with = Rfc3339Millis::class) val lastDeployAt: Long? = null,
)

@Serializable
data class RemoteState(
    val workstation: Workstation,
    val workspaces: List<Workspace> = emptyList(),
    val agents: List<Agent> = emptyList(),
    val needsYou: List<NeedsYouItem> = emptyList(),
    val runs: List<Run> = emptyList(),
    val services: List<Service> = emptyList(),
    val environments: List<Environment> = emptyList(),
)

@Serializable
data class Upserts(
    val agents: List<Agent> = emptyList(),
    val needsYou: List<NeedsYouItem> = emptyList(),
    val runs: List<Run> = emptyList(),
    val services: List<Service> = emptyList(),
    val environments: List<Environment> = emptyList(),
    val workspaces: List<Workspace> = emptyList(),
)

@Serializable
data class Removals(
    val agents: List<String> = emptyList(),
    val needsYou: List<String> = emptyList(),
    val runs: List<String> = emptyList(),
    val services: List<String> = emptyList(),
    val environments: List<String> = emptyList(),
    val workspaces: List<String> = emptyList(),
)

@Serializable
data class Patch(
    val rev: Long,
    val upsert: Upserts = Upserts(),
    val remove: Removals = Removals(),
    val workstation: Workstation? = null,
)

@Serializable
data class RemoteError(val code: String = "internal", val message: String = "")

@Serializable
data class Notify(
    val id: String,
    /** needs_you | agent_failed | agent_done | run_failed | deployment */
    val kind: String = "",
    val title: String = "",
    val body: String = "",
    val link: String = "",
)

// ---- §4 application messages ------------------------------------------------------------------

/** Desktop → device. */
sealed interface HostMessage {
    data class Snapshot(val rev: Long, val state: RemoteState) : HostMessage
    data class PatchMessage(val patch: Patch) : HostMessage
    data class Res(val id: String, val ok: Boolean, val result: JsonElement?, val error: RemoteError?) : HostMessage
    data class NotifyMessage(val notify: Notify) : HostMessage
    data class Pong(val n: Long) : HostMessage
    /** revoked | disabled | shutdown | not_entitled */
    data class Bye(val reason: String) : HostMessage
    data class Unknown(val t: String?) : HostMessage

    companion object {
        fun parse(bytes: ByteArray): HostMessage = parse(String(bytes, Charsets.UTF_8))

        fun parse(text: String): HostMessage {
            val obj = WireJson.parseToJsonElement(text) as? JsonObject ?: return Unknown(null)
            val t = (obj["t"] as? JsonPrimitive)?.contentOrNull
            return when (t) {
                "snapshot" -> Snapshot(
                    obj.long("rev"),
                    WireJson.decodeFromJsonElement(RemoteState.serializer(), obj["state"] ?: JsonNull),
                )
                "patch" -> PatchMessage(WireJson.decodeFromJsonElement(Patch.serializer(), obj))
                "res" -> Res(
                    id = obj.string("id") ?: "",
                    ok = (obj["ok"] as? JsonPrimitive)?.contentOrNull == "true",
                    result = obj["result"]?.takeUnless { it is JsonNull },
                    error = obj["error"]?.takeUnless { it is JsonNull }
                        ?.let { WireJson.decodeFromJsonElement(RemoteError.serializer(), it) },
                )
                "notify" -> NotifyMessage(WireJson.decodeFromJsonElement(Notify.serializer(), obj))
                "pong" -> Pong(obj.long("n"))
                "bye" -> Bye(obj.string("reason") ?: "")
                else -> Unknown(t)
            }
        }

        private fun JsonObject.long(key: String): Long = (this[key] as? JsonPrimitive)?.longOrNull ?: 0
        private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
    }
}

/** Device → desktop. */
object DeviceMessages {
    fun hello(): ByteArray = """{"t":"hello"}""".toByteArray()

    fun ping(n: Long): ByteArray = """{"t":"ping","n":$n}""".toByteArray()

    fun req(id: String, op: String, args: JsonObject): ByteArray =
        WireJson.encodeToString(
            JsonObject.serializer(),
            buildJsonObject {
                put("t", "req")
                put("id", id)
                put("op", op)
                put("args", args)
            },
        ).toByteArray()
}

// ---- §5 operations ----------------------------------------------------------------------------

object Ops {
    const val AGENT_DETAIL = "agent.detail"
    const val AGENT_DIFF = "agent.diff"
    const val AGENT_LOG = "agent.log"
    const val AGENT_PROMPT = "agent.prompt"
    const val AGENT_STOP = "agent.stop"
    const val AGENT_RETRY = "agent.retry"
    const val AGENT_LAUNCH = "agent.launch"
    const val LAUNCH_OPTIONS = "launch.options"
    const val NEEDS_DECIDE = "needs.decide"
    const val VOICE_COMMAND = "voice.command"
    const val RUN_DETAIL = "run.detail"
    const val TIDY_CLOSE_IDLE = "tidy.closeIdle"
}

@Serializable data class Summary(val summary: String = "")

@Immutable
@Serializable
data class AgentMessage(
    val role: String = "",
    val text: String = "",
    @Serializable(with = Rfc3339Millis::class) val at: Long? = null,
)

@Immutable
@Serializable
data class ToolCall(
    val name: String = "",
    val summary: String = "",
    /** running | succeeded | failed | denied */
    val status: String = "",
    @Serializable(with = Rfc3339Millis::class) val at: Long? = null,
)

@Serializable data class WorktreeInfo(val path: String = "", val branch: String = "", val baseBranch: String? = null)

@Immutable
@Serializable
data class AgentDetail(
    val agent: Agent,
    val messages: List<AgentMessage> = emptyList(),
    val tools: List<ToolCall> = emptyList(),
    val worktree: WorktreeInfo? = null,
)

enum class DiffLineKind { ADD, DEL, CTX }

@Immutable
data class DiffLine(val kind: DiffLineKind, val text: String)

@Immutable
data class DiffHunk(val header: String, val lines: List<DiffLine>)

@Immutable
data class DiffFile(
    val path: String,
    /** added | modified | deleted | renamed */
    val status: String,
    val additions: Int,
    val deletions: Int,
    val hunks: List<DiffHunk>,
)

@Immutable
data class DiffResult(val files: List<DiffFile>, val truncated: Boolean) {
    companion object {
        /** `lines` are `[kind, text]` pairs (§8: add | del | ctx). */
        fun parse(json: JsonElement): DiffResult {
            val obj = json as JsonObject
            val files = (obj["files"] as? JsonArray).orEmpty().map { f ->
                val fo = f as JsonObject
                DiffFile(
                    path = fo.str("path"),
                    status = fo.str("status"),
                    additions = fo.int("additions"),
                    deletions = fo.int("deletions"),
                    hunks = (fo["hunks"] as? JsonArray).orEmpty().map { h ->
                        val ho = h as JsonObject
                        DiffHunk(
                            header = ho.str("header"),
                            lines = (ho["lines"] as? JsonArray).orEmpty().mapNotNull { l ->
                                val pair = l as? JsonArray ?: return@mapNotNull null
                                val kind = when (pair.getOrNull(0)?.jsonPrimitive?.contentOrNull) {
                                    "add" -> DiffLineKind.ADD
                                    "del" -> DiffLineKind.DEL
                                    else -> DiffLineKind.CTX
                                }
                                DiffLine(kind, pair.getOrNull(1)?.jsonPrimitive?.contentOrNull ?: "")
                            },
                        )
                    },
                )
            }
            return DiffResult(files, (obj["truncated"] as? JsonPrimitive)?.contentOrNull == "true")
        }

        private fun JsonObject.str(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull ?: ""
        private fun JsonObject.int(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull?.toIntOrNull() ?: 0
    }
}

@Serializable data class LaunchAccount(val id: String, val label: String = "")

@Serializable data class LaunchModel(val id: String, val name: String = "", val efforts: List<String> = emptyList())

@Serializable
data class LaunchProvider(
    val id: String,
    val name: String = "",
    val accounts: List<LaunchAccount> = emptyList(),
    val models: List<LaunchModel> = emptyList(),
)

@Serializable
data class LaunchOptions(val workspaces: List<Workspace> = emptyList(), val providers: List<LaunchProvider> = emptyList())

@Serializable data class LaunchResult(val agentId: String? = null, val summary: String = "")

/** approved | denied | already_answered */
@Serializable data class DecideResult(val status: String = "")

/** outcome: done | partial | refused | clarify */
@Serializable data class VoiceResult(val summary: String = "", val outcome: String = "")

@Serializable
data class TestResult(
    val name: String = "",
    /** passed | failed | skipped | running */
    val status: String = "",
    val durationMs: Long? = null,
)

@Serializable
data class RunDetail(val run: Run, val logs: List<String> = emptyList(), val tests: List<TestResult> = emptyList())

@Serializable
data class LogEntry(val id: String, val kind: String = "", val text: String = "", @Serializable(with = Rfc3339Millis::class) val at: Long? = null)

@Serializable data class LogPage(val entries: List<LogEntry> = emptyList(), val more: Boolean = false)

/** Handshake rejection reasons (§3). */
object RejectReasons {
    const val UNPAIRED = "unpaired"
    const val REVOKED = "revoked"
    const val PAIRING_EXPIRED = "pairing_expired"
    const val NOT_ENTITLED = "not_entitled"
    const val BUSY = "busy"
    const val VERSION = "version"
    const val INVALID = "invalid"
}

/** Handshake text fields: ≤ 64 characters, no control characters (§3 limits). */
fun handshakeField(text: String): String {
    val clean = text.filterNot { it.isISOControl() }.trim()
    if (clean.length <= 64) return clean
    var end = 64
    if (Character.isHighSurrogate(clean[end - 1])) end-- // never split a surrogate pair
    return clean.substring(0, end)
}
