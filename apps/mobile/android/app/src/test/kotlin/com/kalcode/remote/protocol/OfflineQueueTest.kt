package com.kalcode.remote.protocol

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class OfflineQueueTest {
    private fun req(id: String, op: String = Ops.AGENT_PROMPT, at: Long = 0) =
        QueuedRequest(id, op, JsonObject(mapOf("agentId" to JsonPrimitive("thr_1"), "text" to JsonPrimitive("hi"))), at)

    @Test
    fun onlyPromptsAndVoiceCommandsMayWait() {
        assertTrue(OfflineQueue.canQueue(Ops.AGENT_PROMPT))
        assertTrue(OfflineQueue.canQueue(Ops.VOICE_COMMAND))
        for (op in listOf(Ops.AGENT_STOP, Ops.AGENT_RETRY, Ops.NEEDS_DECIDE, Ops.AGENT_LAUNCH, Ops.AGENT_DETAIL, Ops.TIDY_CLOSE_IDLE)) {
            try {
                OfflineQueue().enqueue(req("1", op))
                throw AssertionError("$op was queued")
            } catch (_: NotQueueableException) {
            }
        }
    }

    @Test
    fun sameIdKeepsOneEntryAndOrderIsFifo() {
        val q = OfflineQueue().enqueue(req("a", at = 1)).enqueue(req("b", at = 2)).enqueue(req("a", at = 3))
        assertEquals(listOf("a", "b"), q.items.map { it.id })
        assertEquals(3L, q.items[0].queuedAt)
        assertEquals("thr_1", q.items[0].agentId)
        assertEquals("hi", q.items[0].text)
    }

    @Test
    fun itemsExpireAfterSixtySeconds() {
        val q = OfflineQueue().enqueue(req("old", at = 0)).enqueue(req("new", at = 30_000))
        val (live, expired) = q.expire(59_999)
        assertEquals(2, live.items.size)
        assertTrue(expired.isEmpty())
        val (live2, expired2) = q.expire(60_000)
        assertEquals(listOf("new"), live2.items.map { it.id })
        assertEquals(listOf("old"), expired2.map { it.id })
    }

    @Test
    fun drainReturnsLiveInOrderWithOriginalIds() {
        val q = OfflineQueue().enqueue(req("a", at = 0)).enqueue(req("b", Ops.VOICE_COMMAND, at = 10_000)).enqueue(req("c", at = 20_000))
        val (send, expired) = q.drain(65_000)
        assertEquals(listOf("b", "c"), send.map { it.id })
        assertEquals(listOf("a"), expired.map { it.id })
        assertEquals(listOf("a", "c"), q.remove("b").items.map { it.id })
    }

    @Test
    fun backoffDoublesFromHalfASecondToTenSeconds() {
        val b = Backoff()
        assertEquals(listOf(500L, 1000L, 2000L, 4000L, 8000L, 10_000L, 10_000L), List(7) { b.next() })
        b.reset()
        assertEquals(500L, b.next())
    }
}
