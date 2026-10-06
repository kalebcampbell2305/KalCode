package com.kalcode.remote.protocol

import androidx.compose.runtime.Immutable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** A request held while the workstation is Reconnecting (protocol §5 "Offline queue"). */
@Immutable
data class QueuedRequest(
    /** Never changes, so a request that reached the desktop before a drop is answered from the
     *  desktop's result cache instead of running twice. */
    val id: String,
    val op: String,
    val args: JsonObject,
    val queuedAt: Long,
) {
    val agentId: String? get() = (args["agentId"] as? JsonPrimitive)?.contentOrNull
    val text: String? get() = (args["text"] as? JsonPrimitive)?.contentOrNull
}

class NotQueueableException(op: String) : IllegalArgumentException("$op needs a live connection")

/** Pure queue rules; the client owns the clock and the transport. Immutable. */
@Immutable
data class OfflineQueue(val items: List<QueuedRequest> = emptyList()) {
    val isEmpty: Boolean get() = items.isEmpty()

    fun enqueue(request: QueuedRequest): OfflineQueue {
        if (!canQueue(request.op)) throw NotQueueableException(request.op)
        val i = items.indexOfFirst { it.id == request.id }
        // The same id re-queued after a drop keeps one entry.
        return if (i >= 0) copy(items = items.toMutableList().also { it[i] = request }) else copy(items = items + request)
    }

    /** Splits into (still valid, expired at [now]). */
    fun expire(now: Long): Pair<OfflineQueue, List<QueuedRequest>> {
        val (expired, live) = items.partition { now - it.queuedAt >= TTL_MILLIS }
        return OfflineQueue(live) to expired
    }

    /** On reconnect: the live requests in FIFO order (to send with their original ids) and the
     *  expired ones (to fail). The queue becomes empty. */
    fun drain(now: Long): Pair<List<QueuedRequest>, List<QueuedRequest>> {
        val (live, expired) = expire(now)
        return live.items to expired
    }

    fun remove(id: String): OfflineQueue = copy(items = items.filterNot { it.id == id })

    companion object {
        const val TTL_MILLIS = 60_000L
        val QUEUEABLE_OPS = setOf(Ops.AGENT_PROMPT, Ops.VOICE_COMMAND)
        fun canQueue(op: String) = op in QUEUEABLE_OPS
    }
}

/** Reconnect backoff: 0.5 s doubling to a 10 s cap. */
class Backoff(private val initialMillis: Long = 500, private val maxMillis: Long = 10_000) {
    var attempt = 0
        private set

    fun next(): Long {
        val delay = minOf(maxMillis, initialMillis shl minOf(attempt, 20))
        attempt = minOf(attempt + 1, 30)
        return delay
    }

    fun reset() {
        attempt = 0
    }
}
