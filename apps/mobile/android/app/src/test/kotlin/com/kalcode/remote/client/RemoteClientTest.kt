package com.kalcode.remote.client

import com.kalcode.remote.protocol.AgentState
import com.kalcode.remote.protocol.FleetState
import com.kalcode.remote.protocol.Ops
import com.kalcode.remote.protocol.PairingLink
import com.kalcode.remote.testing.FakeHost
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The production client against a fake workstation speaking the real protocol over TCP. */
class RemoteClientTest {
    private val host = FakeHost(agentCount = 6)
    private val store = InMemoryPairingStore()
    private val fast = ClientConfig(
        pingMillis = 200, silenceMillis = 1_500, offlineAfterMillis = 2_500,
        requestTimeoutMillis = 5_000, backoffInitialMillis = 50, backoffMaxMillis = 200,
    )
    private val client = RemoteClient(store, DeviceInfo("Test Pixel", "Pixel 9", "1.0 (1)"), fast)

    @After
    fun tearDown() {
        client.close()
        host.close()
    }

    private fun args(vararg pairs: Pair<String, String>) = JsonObject(pairs.associate { it.first to JsonPrimitive(it.second) })

    private suspend fun awaitStatus(timeout: Long = 8_000, p: (ConnectionStatus) -> Boolean): ConnectionStatus =
        withTimeout(timeout) { client.status.first(p) }

    private suspend fun awaitFleet(p: (FleetState) -> Boolean) = withTimeout(8_000) { client.fleet.first(p) }

    private fun pairNow() = runBlocking<Unit> {
        client.pair(PairingLink.parse(host.pairingLink()))
        awaitStatus { it == ConnectionStatus.Online }
    }

    @Test
    fun pairsReceivesSnapshotAndPersistsThePinnedWorkstation() = runBlocking<Unit> {
        val ws = client.pair(PairingLink.parse(host.pairingLink()))
        awaitStatus { it == ConnectionStatus.Online }
        assertEquals("Test Workstation", ws.name)
        assertTrue(ws.deviceId.startsWith("dev_"))
        assertNotNull(store.loadDeviceKey())
        assertEquals(ws, store.loadWorkstation())
        assertEquals(6, client.fleet.value.agents.size)
        assertEquals(1L, client.fleet.value.rev)
    }

    @Test
    fun aUsedPairingCodeIsRefused() = runBlocking<Unit> {
        pairNow()
        val other = RemoteClient(InMemoryPairingStore(), DeviceInfo("B", "B", "1"), fast)
        try {
            other.pair(PairingLink.parse(host.pairingLink()))
            fail("paired with a used code")
        } catch (e: PairingFailedException) {
            assertEquals("pairing_expired", e.reason)
        } finally {
            other.close()
        }
    }

    @Test
    fun requestsPatchesAndNotifications() = runBlocking<Unit> {
        pairNow()
        val detail = client.request(Ops.AGENT_DETAIL, args("agentId" to "thr_0001")).jsonObject
        assertEquals("thr_0001", detail["agent"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        try {
            client.request(Ops.AGENT_DETAIL, args("agentId" to "thr_gone"))
            fail("expected not_found")
        } catch (e: RemoteCallException) {
            assertEquals("not_found", e.code)
        }
        val agent = client.fleet.value.agent("thr_0002")!!
        host.upsertAgent(agent.copy(state = AgentState.DONE))
        awaitFleet { it.agent("thr_0002")?.state == AgentState.DONE }
        assertEquals(2L, client.fleet.value.rev)

        val note = async { withTimeout(5_000) { client.notifications.first() } }
        delay(100)
        host.notifyAll("ntf_1", "agent_done", "Fix finished", "4 files", "kalcode-remote://agent/thr_0002")
        assertEquals("kalcode-remote://agent/thr_0002", note.await().link)
    }

    @Test
    fun revGapReconnectsAndReceivesAFreshSnapshot() = runBlocking<Unit> {
        pairNow()
        host.sendGapPatch()
        awaitStatus { it is ConnectionStatus.Reconnecting }
        awaitStatus { it == ConnectionStatus.Online }
        assertEquals(1L, client.fleet.value.rev) // a new connection starts at snapshot rev 1
    }

    @Test
    fun droppedConnectionReconnectsWithBackoff() = runBlocking<Unit> {
        pairNow()
        host.dropAll()
        awaitStatus { it is ConnectionStatus.Reconnecting }
        awaitStatus { it == ConnectionStatus.Online }
        assertEquals(6, client.fleet.value.agents.size)
    }

    @Test
    fun silenceIsDetectedAndTheSessionIsReplaced() = runBlocking<Unit> {
        pairNow()
        host.mute = true // connected, but no pongs and no patches: dead after the silence window
        awaitStatus(timeout = 4_000) { it is ConnectionStatus.Reconnecting }
        host.mute = false
        awaitStatus { it == ConnectionStatus.Online }
    }

    @Test
    fun unreachableForThirtySecondsGoesOfflineAndRecovers() = runBlocking<Unit> {
        pairNow()
        host.accepting = false
        host.dropAll()
        awaitStatus { it is ConnectionStatus.Reconnecting }
        val offline = awaitStatus { it is ConnectionStatus.Offline }
        assertEquals(OfflineReason.UNREACHABLE, (offline as ConnectionStatus.Offline).reason)
        host.accepting = true
        client.retryNow()
        awaitStatus { it == ConnectionStatus.Online }
    }

    @Test
    fun promptsQueueWhileReconnectingAndResendWithTheSameId() = runBlocking<Unit> {
        pairNow()
        host.accepting = false
        host.dropAll()
        awaitStatus { it is ConnectionStatus.Reconnecting }
        val sent = async { client.request(Ops.AGENT_PROMPT, args("agentId" to "thr_0002", "text" to "Use the new API")) }
        withTimeout(2_000) { client.queue.first { !it.isEmpty } }
        val queuedId = client.queue.value.items.single().id
        // Anything other than prompt/voice needs a live connection.
        try {
            client.request(Ops.AGENT_STOP, args("agentId" to "thr_0002"))
            fail("stop was queued")
        } catch (e: NotConnectedException) {
        }
        host.accepting = true
        client.retryNow()
        val result = withTimeout(8_000) { sent.await() }.jsonObject
        assertTrue(result["summary"]!!.jsonPrimitive.content.startsWith("Sent to"))
        assertEquals(listOf(queuedId), host.executed.toList())
        assertTrue(client.queue.value.isEmpty)
    }

    @Test
    fun anInFlightPromptIsNeverExecutedTwice() = runBlocking<Unit> {
        pairNow()
        host.holdRequests = true
        val sent = async { client.request(Ops.AGENT_PROMPT, args("agentId" to "thr_0002", "text" to "go")) }
        withTimeout(3_000) { while (host.received.isEmpty()) delay(20) }
        host.dropAll() // the desktop got it but the answer never arrived
        awaitStatus { it is ConnectionStatus.Reconnecting }
        // After reconnecting the client resends the same id; while the first copy still runs the
        // desktop answers `conflict`, and the client asks again until the stored result answers.
        withTimeout(6_000) { while (host.received.size < 3) delay(20) }
        host.holdRequests = false
        host.releaseHeld()
        withTimeout(8_000) { sent.await() }
        assertEquals(1, host.executed.size)
        assertTrue(host.received.size >= 3)
    }

    @Test
    fun rateLimitedIsShownPlainlyAndNeverRetried() = runBlocking<Unit> {
        pairNow()
        host.rateLimited += Ops.AGENT_LAUNCH
        try {
            client.request(Ops.AGENT_LAUNCH, args("workspaceId" to "wsp_KalCode", "providerId" to "claude-code"))
            fail("expected refused")
        } catch (e: RemoteCallException) {
            assertTrue(e.isRateLimited)
            assertEquals(RemoteCallException.RATE_LIMITED_TEXT, e.message)
        }
        delay(500)
        assertEquals(1, host.received.count { it.first == Ops.AGENT_LAUNCH })
    }

    @Test
    fun oversizedRequestsAreRefusedOnTheDevice() = runBlocking<Unit> {
        pairNow()
        try {
            client.request(Ops.AGENT_PROMPT, args("agentId" to "thr_0002", "text" to "x".repeat(300 * 1024)))
            fail("sent an oversized message")
        } catch (e: MessageTooLargeException) {
        }
        assertTrue(host.received.isEmpty())
        assertEquals(ConnectionStatus.Online, client.status.value)
    }

    @Test
    fun byeReplacedStopsWithoutAReconnectLoop() = runBlocking<Unit> {
        pairNow()
        host.byeAll("replaced")
        val st = awaitStatus { it is ConnectionStatus.Offline }
        assertEquals(OfflineReason.REPLACED, (st as ConnectionStatus.Offline).reason)
        delay(1_000)
        assertEquals(0, host.liveSessions)
        assertNotNull(store.loadWorkstation()) // no state changed
        client.retryNow()
        awaitStatus { it == ConnectionStatus.Online }
    }

    @Test
    fun queuedRequestsFailWhenTheWorkstationGoesOffline() = runBlocking<Unit> {
        pairNow()
        host.accepting = false
        host.dropAll()
        awaitStatus { it is ConnectionStatus.Reconnecting }
        val sent = async { runCatching { client.request(Ops.VOICE_COMMAND, args("text" to "status")) } }
        val result = withTimeout(8_000) { sent.await() }
        assertTrue(result.exceptionOrNull() is WentOfflineException)
    }

    @Test
    fun byeShutdownGoesOffline() = runBlocking<Unit> {
        pairNow()
        host.accepting = false
        host.byeAll("shutdown")
        val st = awaitStatus { it is ConnectionStatus.Offline }
        assertEquals(OfflineReason.SHUTDOWN, (st as ConnectionStatus.Offline).reason)
    }

    @Test
    fun revokedRemovesTheDeviceAndDeletesItsKey() = runBlocking<Unit> {
        pairNow()
        host.revokeAll()
        val st = awaitStatus { it is ConnectionStatus.Removed }
        assertEquals(RemovedReason.REVOKED, (st as ConnectionStatus.Removed).reason)
        assertEquals("Test Workstation", st.workstationName)
        assertNull(store.loadDeviceKey())
        assertNull(store.loadWorkstation())
        assertTrue(client.fleet.value.agents.isEmpty())
    }

    @Test
    fun revokedOnReconnectAlsoRemoves() = runBlocking<Unit> {
        pairNow()
        host.rejectWith = "revoked"
        host.dropAll()
        val st = awaitStatus { it is ConnectionStatus.Removed }
        assertEquals(RemovedReason.REVOKED, (st as ConnectionStatus.Removed).reason)
        assertNull(store.loadDeviceKey())
    }

    @Test
    fun rePairingGeneratesANewDeviceKey() = runBlocking<Unit> {
        pairNow()
        val first = store.loadDeviceKey()!!.public.copyOf()
        host.newPairingCode()
        client.pair(PairingLink.parse(host.pairingLink()))
        awaitStatus { it == ConnectionStatus.Online }
        assertTrue(!first.contentEquals(store.loadDeviceKey()!!.public))
    }

    @Test
    fun unpairForgetsEverything() = runBlocking<Unit> {
        pairNow()
        client.unpair()
        assertEquals(ConnectionStatus.Unpaired, client.status.value)
        assertNull(store.loadWorkstation())
        assertNull(client.workstation.value)
    }

    @Test
    fun parallelAttemptsPickTheReachableAddress() = runBlocking<Unit> {
        // 10.255.255.1 is unroutable: that attempt hangs until the reachable one wins.
        val payload = PairingLink.parse(host.pairingLink()).let { it.copy(addrs = listOf("10.255.255.1:47820") + it.addrs) }
        val ws = withTimeout(5_000) { client.pair(payload) }
        assertEquals("127.0.0.1:${host.port}", ws.addrs.first())
    }
}
