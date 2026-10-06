package com.kalcode.remote.client

import com.kalcode.remote.protocol.Backoff
import com.kalcode.remote.protocol.Base64Any
import com.kalcode.remote.protocol.DeviceHello
import com.kalcode.remote.protocol.DeviceMessages
import com.kalcode.remote.protocol.FleetState
import com.kalcode.remote.protocol.HostMessage
import com.kalcode.remote.protocol.HostPort
import com.kalcode.remote.protocol.KeyPair
import com.kalcode.remote.protocol.Notify
import com.kalcode.remote.protocol.OfflineQueue
import com.kalcode.remote.protocol.PairingPayload
import com.kalcode.remote.protocol.QueuedRequest
import com.kalcode.remote.protocol.RejectReasons
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.selects.onTimeout
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import com.kalcode.remote.protocol.Framing
import com.kalcode.remote.protocol.handshakeField
import kotlinx.coroutines.selects.select
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/** Device connection states (protocol §7). */
sealed interface ConnectionStatus {
    data object Unpaired : ConnectionStatus
    /** The first attempt after launch or pairing. */
    data object Connecting : ConnectionStatus
    /** Handshake done and snapshot received. */
    data object Online : ConnectionStatus
    /** A paired workstation dropped; retrying. The UI keeps the last state, dimmed. */
    data class Reconnecting(val since: Long) : ConnectionStatus
    data class Offline(val reason: OfflineReason) : ConnectionStatus
    data class Removed(val reason: RemovedReason, val workstationName: String) : ConnectionStatus
}

enum class OfflineReason(val message: String) {
    UNREACHABLE("Can't reach your workstation. KalCode Remote keeps trying."),
    SHUTDOWN("KalCode closed on your workstation."),
    DISABLED("Remote was turned off on your workstation."),
    NOT_ENTITLED("Remote needs KalCode MAX on your workstation."),
    VERSION("This workstation runs a different KalCode version. Update both apps."),
    REPLACED("This device opened a newer session to your workstation. Tap Try again to use this one."),
    INVALID("Your workstation refused this device's details. Update KalCode Remote."),
}

enum class RemovedReason { REVOKED, UNPAIRED }

/** A request that didn't produce a result. [code] is a §5 error code or a device-side one. */
open class RemoteCallException(val code: String, message: String) : Exception(message) {
    /** The desktop's per-device rate limit (§3 limits). Never retried automatically. */
    val isRateLimited: Boolean get() = code == "refused" && message == RATE_LIMITED_TEXT

    companion object {
        const val RATE_LIMITED = "rate limited"
        const val RATE_LIMITED_TEXT = "Slow down a moment. Your workstation limits how fast this device can act. Try again in a minute."

        /** Turns a `res` error into what the person reads. */
        fun from(code: String?, message: String?): RemoteCallException {
            val c = code ?: "internal"
            val m = message?.takeIf { it.isNotBlank() }
            return when {
                c == "refused" && m == RATE_LIMITED -> RemoteCallException(c, RATE_LIMITED_TEXT)
                c == "unavailable" && m == null -> RemoteCallException(c, "Your workstation is busy. Try again in a moment.")
                c == "not_entitled" -> RemoteCallException(c, m ?: "Remote needs KalCode MAX on your workstation.")
                else -> RemoteCallException(c, m ?: "Something went wrong.")
            }
        }
    }
}
class MessageTooLargeException : RemoteCallException("too_large", "This is too long to send from your phone. Shorten it and try again.")
class NotConnectedException : RemoteCallException("not_connected", "Not connected to your workstation.")
class QueueExpiredException : RemoteCallException("queue_expired", "Not sent. Your workstation didn't come back within a minute.")
class WentOfflineException : RemoteCallException("offline", "Not sent. Your workstation went offline.")
class ConnectionLostException : RemoteCallException("connection_lost", "The connection dropped before your workstation answered.")
class RequestTimeoutException : RemoteCallException("timeout", "Your workstation didn't answer in time.")

/** Pairing failed. [reason] is a §3 rejection reason, or null when nothing could be reached. */
class PairingFailedException(val reason: String?, message: String) : Exception(message)

data class ClientConfig(
    val pingMillis: Long = 15_000,
    val silenceMillis: Int = 35_000,
    val offlineAfterMillis: Long = 30_000,
    val requestTimeoutMillis: Long = 30_000,
    val backoffInitialMillis: Long = 500,
    val backoffMaxMillis: Long = 10_000,
)

/**
 * The device side of KalCode Remote: pairing, the Noise session, the mirrored fleet state,
 * requests, the offline queue and reconnects. One instance per process.
 */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class RemoteClient(
    private val store: PairingStore,
    private val device: DeviceInfo,
    private val config: ClientConfig = ClientConfig(),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _status = MutableStateFlow<ConnectionStatus>(ConnectionStatus.Unpaired)
    val status: StateFlow<ConnectionStatus> = _status.asStateFlow()

    private val _fleet = MutableStateFlow(FleetState())
    val fleet: StateFlow<FleetState> = _fleet.asStateFlow()

    private val _queue = MutableStateFlow(OfflineQueue())
    val queue: StateFlow<OfflineQueue> = _queue.asStateFlow()

    private val _workstation = MutableStateFlow<PairedWorkstation?>(null)
    val workstation: StateFlow<PairedWorkstation?> = _workstation.asStateFlow()

    /** Wall time of the last snapshot/patch, for "Updated 12 s ago" while not live. */
    private val _lastUpdate = MutableStateFlow<Long?>(null)
    val lastUpdate: StateFlow<Long?> = _lastUpdate.asStateFlow()

    private val _notifications = MutableSharedFlow<Notify>(extraBufferCapacity = 32)
    val notifications: SharedFlow<Notify> = _notifications

    private class Pending(val id: String, val op: String, val args: JsonObject, val result: CompletableDeferred<HostMessage.Res>) {
        @Volatile var sent = false
        @Volatile var sends = 0
    }

    private val sync = Any()
    private val pending = ConcurrentHashMap<String, Pending>()
    @Volatile private var connection: RemoteConnection? = null
    private var loopJob: Job? = null
    private val wake = Channel<Unit>(Channel.CONFLATED)

    /** The desktop runs at most 16 requests per connection (§3 limits); never ask for more. */
    private val inFlight = Semaphore(MAX_IN_FLIGHT)

    init {
        scope.launch { watchdog() }
    }

    /** Restores the pinned workstation and connects. Safe to call more than once. */
    fun start() {
        val ws = store.loadWorkstation()
        val key = store.loadDeviceKey()
        if (ws == null || key == null) {
            if (_status.value !is ConnectionStatus.Removed) _status.value = ConnectionStatus.Unpaired
            return
        }
        _workstation.value = ws
        if (loopJob?.isActive == true) return
        _status.value = ConnectionStatus.Connecting
        loopJob = scope.launch { connectionLoop(ws, key, null) }
    }

    /** Retry immediately (pull-to-refresh, "Try again", app foreground). */
    fun retryNow() {
        if (loopJob?.isActive != true) {
            if (_workstation.value != null) start()
            return
        }
        wake.trySend(Unit)
    }

    fun onForeground() {
        if (_status.value !is ConnectionStatus.Online) retryNow()
    }

    /**
     * Pairs with the workstation in [payload]: a fresh device key, the pairing code inside the
     * encrypted first handshake message, then the pinned record. Replaces any earlier pairing.
     */
    suspend fun pair(payload: PairingPayload): PairedWorkstation {
        val hostPublic = payload.publicKey ?: throw PairingFailedException(null, "This pairing link is damaged.")
        val addrs = payload.addrs.mapNotNull(HostPort::parse)
        stopLoop()
        store.wipe()
        _fleet.value = FleetState()
        _status.value = ConnectionStatus.Connecting
        val key = KeyPair.generate()
        val conn = try {
            connectAny(addrs, key, hostPublic, payload.code)
        } catch (e: HandshakeRejectedException) {
            _status.value = ConnectionStatus.Unpaired
            throw PairingFailedException(e.reason, pairingMessage(e.reason))
        } catch (e: CancellationException) {
            _status.value = ConnectionStatus.Unpaired
            throw e
        } catch (e: Exception) {
            _status.value = ConnectionStatus.Unpaired
            throw PairingFailedException(
                null,
                "Couldn't reach ${payload.name}. Make sure this device is on the same network or Tailscale, then try again.",
            )
        }
        val reply = conn.reply
        val ws = PairedWorkstation(
            wid = reply.wid ?: payload.wid,
            name = reply.name ?: payload.name,
            publicKey = Base64Any.encode(hostPublic),
            // The address that answered first goes first next time.
            addrs = (listOf(conn.address.toString()) + payload.addrs).distinct(),
            deviceId = reply.deviceId ?: "",
            hostPlatform = reply.host?.platform ?: "",
            hostVersion = reply.host?.version ?: "",
            hostBuild = reply.host?.build ?: 0,
            pairedAt = clock(),
        )
        store.saveDeviceKey(key)
        store.saveWorkstation(ws)
        _workstation.value = ws
        loopJob = scope.launch { connectionLoop(ws, key, conn) }
        return ws
    }

    /** Forgets the workstation on this device and destroys the device key. */
    fun unpair() {
        stopLoop()
        store.wipe()
        _workstation.value = null
        _fleet.value = FleetState()
        _lastUpdate.value = null
        failEverything { NotConnectedException() }
        _status.value = ConnectionStatus.Unpaired
    }

    /** After Removed: back to the pairing screen. */
    fun acknowledgeRemoved() {
        if (_status.value is ConnectionStatus.Removed) _status.value = ConnectionStatus.Unpaired
    }

    /**
     * Runs operation [op] (§5). `agent.prompt` and `voice.command` wait in the offline queue while
     * Reconnecting (same id on resend); everything else needs a live connection.
     */
    suspend fun request(op: String, args: JsonObject = JsonObject(emptyMap())): JsonElement {
        val id = UUID.randomUUID().toString()
        val bytes = DeviceMessages.req(id, op, args)
        if (bytes.size > Framing.MAX_DEVICE_MESSAGE) throw MessageTooLargeException()
        return inFlight.withPermit { send(Pending(id, op, args, CompletableDeferred()), bytes) }
    }

    private suspend fun send(p: Pending, bytes: ByteArray): JsonElement {
        val id = p.id
        val queueable = OfflineQueue.canQueue(p.op)
        val conn: RemoteConnection?
        synchronized(sync) {
            val live = connection.takeIf { _status.value == ConnectionStatus.Online }
            when {
                live != null -> {
                    pending[id] = p
                    p.sent = true
                    p.sends++
                    conn = live
                }
                queueable && _status.value is ConnectionStatus.Reconnecting -> {
                    pending[id] = p
                    _queue.value = _queue.value.enqueue(QueuedRequest(id, p.op, p.args, clock()))
                    conn = null
                }
                else -> throw NotConnectedException()
            }
        }
        if (conn != null) {
            try {
                withContext(Dispatchers.IO) { conn.send(bytes) }
            } catch (e: IOException) {
                // The session is ending; the loop re-queues or fails this request.
                conn.close()
            }
        }
        val timeout = if (queueable) OfflineQueue.TTL_MILLIS + config.requestTimeoutMillis else config.requestTimeoutMillis
        val res = withTimeoutOrNull(timeout) { p.result.await() }
        if (res == null) {
            pending.remove(id)
            synchronized(sync) { _queue.value = _queue.value.remove(id) }
            throw RequestTimeoutException()
        }
        if (res.ok) return res.result ?: JsonNull
        throw RemoteCallException.from(res.error?.code, res.error?.message)
    }

    /** Drops a queued request before it's sent (the person cancelled it). */
    fun cancelQueued(id: String) {
        synchronized(sync) { _queue.value = _queue.value.remove(id) }
        pending.remove(id)?.result?.completeExceptionally(CancellationException("cancelled"))
    }

    // ---- connection loop ----------------------------------------------------------------------

    private fun stopLoop() {
        loopJob?.cancel()
        loopJob = null
        connection?.close()
        connection = null
    }

    private fun hello(pairCode: String?) = DeviceHello(
        device = handshakeField(device.name).ifEmpty { "Android device" },
        model = handshakeField(device.model).ifEmpty { "Android" },
        app = handshakeField(device.appVersion),
        pair = pairCode,
        ts = clock() / 1000,
    )

    private suspend fun connectionLoop(ws: PairedWorkstation, key: KeyPair, initial: RemoteConnection?) {
        val backoff = Backoff(config.backoffInitialMillis, config.backoffMaxMillis)
        val hostPublic = Base64Any.decode(ws.publicKey) ?: return
        val addrs = ws.addrs.mapNotNull(HostPort::parse)
        var first: RemoteConnection? = initial
        while (scope.isActive) {
            var conn: RemoteConnection? = null
            var immediate = false
            try {
                conn = first ?: connectAny(addrs, key, hostPublic, null)
                first = null
                connection = conn
                when (val end = runSession(conn)) {
                    SessionEnd.RevGap -> immediate = true
                    SessionEnd.Dropped -> Unit
                    is SessionEnd.Bye -> when (end.reason) {
                        "revoked" -> return removed(RemovedReason.REVOKED, ws)
                        "disabled" -> goOffline(OfflineReason.DISABLED)
                        "not_entitled" -> goOffline(OfflineReason.NOT_ENTITLED)
                        "replaced" -> {
                            // A newer session of this device owns the workstation now. Change no
                            // state and don't fight it: wait for the person to ask.
                            _status.value = ConnectionStatus.Offline(OfflineReason.REPLACED)
                            return
                        }
                        else -> goOffline(OfflineReason.SHUTDOWN)
                    }
                }
                backoff.reset()
            } catch (e: CancellationException) {
                throw e
            } catch (e: HandshakeRejectedException) {
                when (e.reason) {
                    RejectReasons.REVOKED -> return removed(RemovedReason.REVOKED, ws)
                    RejectReasons.UNPAIRED -> return removed(RemovedReason.UNPAIRED, ws)
                    RejectReasons.VERSION -> {
                        goOffline(OfflineReason.VERSION)
                        return
                    }
                    RejectReasons.INVALID -> {
                        goOffline(OfflineReason.INVALID)
                        return
                    }
                    RejectReasons.NOT_ENTITLED -> goOffline(OfflineReason.NOT_ENTITLED)
                    else -> Unit // busy: retry with backoff
                }
            } catch (e: Exception) {
                // Unreachable, silent, closed or tampered: reconnect.
            } finally {
                synchronized(sync) { if (connection === conn) connection = null }
                conn?.close()
                onSessionLost()
            }
            if (_status.value !is ConnectionStatus.Offline && _status.value !is ConnectionStatus.Reconnecting) {
                _status.value = ConnectionStatus.Reconnecting(clock())
            }
            if (!immediate) {
                val delayMillis = backoff.next()
                select<Unit> {
                    wake.onReceive { }
                    onTimeout(delayMillis) { }
                }
            }
        }
    }

    private sealed interface SessionEnd {
        data object RevGap : SessionEnd
        data object Dropped : SessionEnd
        data class Bye(val reason: String) : SessionEnd
    }

    private suspend fun runSession(conn: RemoteConnection): SessionEnd = coroutineScope {
        val end = CompletableDeferred<SessionEnd>()
        val pinger = launch {
            var n = 1L
            while (isActive) {
                delay(config.pingMillis)
                try {
                    conn.send(DeviceMessages.ping(n++))
                } catch (e: IOException) {
                    conn.close()
                    return@launch
                }
            }
        }
        val reader = launch(Dispatchers.IO) {
            try {
                while (isActive) {
                    val message = HostMessage.parse(conn.receive())
                    val outcome = handle(conn, message)
                    if (outcome != null) {
                        end.complete(outcome)
                        return@launch
                    }
                }
            } catch (e: Exception) {
                end.complete(SessionEnd.Dropped)
            }
        }
        try {
            end.await()
        } finally {
            conn.close() // unblocks the reader
            pinger.cancel()
            reader.cancel()
        }
    }

    /** Applies one message; returns non-null when the session must end. */
    private fun handle(conn: RemoteConnection, message: HostMessage): SessionEnd? {
        when (message) {
            is HostMessage.Snapshot -> {
                _fleet.value = _fleet.value.applySnapshot(message.rev, message.state)
                _lastUpdate.value = clock()
                if (_status.value != ConnectionStatus.Online) {
                    synchronized(sync) { _status.value = ConnectionStatus.Online }
                    flushQueue(conn)
                }
            }
            is HostMessage.PatchMessage -> when (val outcome = _fleet.value.applyPatch(message.patch)) {
                is FleetState.PatchOutcome.Applied -> {
                    _fleet.value = outcome.state
                    _lastUpdate.value = clock()
                }
                is FleetState.PatchOutcome.Gap -> return SessionEnd.RevGap
            }
            is HostMessage.Res -> {
                val p = pending[message.id]
                if (p != null && !message.ok && message.error?.code == "conflict" && p.sends > 1) {
                    // Our resend reached the desktop while the first copy still runs there; its
                    // result answers a later resend of the same id. Ask again shortly.
                    scope.launch {
                        delay(CONFLICT_RETRY_MILLIS)
                        if (pending[p.id] === p && connection === conn) {
                            p.sends++
                            runCatching { conn.send(DeviceMessages.req(p.id, p.op, p.args)) }
                        }
                    }
                } else {
                    pending.remove(message.id)?.result?.complete(message)
                }
            }
            is HostMessage.NotifyMessage -> _notifications.tryEmit(message.notify)
            is HostMessage.Bye -> return SessionEnd.Bye(message.reason)
            is HostMessage.Pong, is HostMessage.Unknown -> Unit
        }
        return null
    }

    private fun flushQueue(conn: RemoteConnection) {
        val (send, expired) = synchronized(sync) {
            val drained = _queue.value.drain(clock())
            _queue.value = OfflineQueue()
            drained
        }
        expired.forEach { pending.remove(it.id)?.result?.completeExceptionally(QueueExpiredException()) }
        for (item in send) {
            val p = pending[item.id] ?: continue
            p.sent = true
            p.sends++
            try {
                conn.send(DeviceMessages.req(item.id, item.op, item.args))
            } catch (e: IOException) {
                conn.close()
                return
            }
        }
    }

    /** In-flight prompts and voice commands go back to the queue with their ids; the rest fail. */
    private fun onSessionLost() {
        synchronized(sync) {
            for (p in pending.values) {
                if (!p.sent) continue
                if (OfflineQueue.canQueue(p.op)) {
                    p.sent = false
                    _queue.value = _queue.value.enqueue(QueuedRequest(p.id, p.op, p.args, clock()))
                } else {
                    pending.remove(p.id)
                    p.result.completeExceptionally(ConnectionLostException())
                }
            }
        }
    }

    private fun goOffline(reason: OfflineReason) {
        _status.value = ConnectionStatus.Offline(reason)
        failQueued { WentOfflineException() }
    }

    private fun removed(reason: RemovedReason, ws: PairedWorkstation) {
        store.wipe()
        _workstation.value = null
        _fleet.value = FleetState()
        _lastUpdate.value = null
        failEverything { NotConnectedException() }
        _status.value = ConnectionStatus.Removed(reason, ws.name)
    }

    private fun failQueued(error: () -> Exception) {
        val items = synchronized(sync) {
            val all = _queue.value.items
            _queue.value = OfflineQueue()
            all
        }
        items.forEach { pending.remove(it.id)?.result?.completeExceptionally(error()) }
    }

    private fun failEverything(error: () -> Exception) {
        failQueued(error)
        val all = pending.values.toList()
        pending.clear()
        all.forEach { it.result.completeExceptionally(error()) }
    }

    /** Reconnecting → Offline after 30 s; queued requests expire after 60 s. */
    private suspend fun watchdog() {
        while (scope.isActive) {
            delay(250)
            val now = clock()
            val st = _status.value
            if (st is ConnectionStatus.Reconnecting && now - st.since >= config.offlineAfterMillis) {
                goOffline(OfflineReason.UNREACHABLE)
            }
            val expired = synchronized(sync) {
                if (_queue.value.isEmpty) return@synchronized emptyList()
                val (live, gone) = _queue.value.expire(now)
                _queue.value = live
                gone
            }
            expired.forEach { pending.remove(it.id)?.result?.completeExceptionally(QueueExpiredException()) }
        }
    }

    /**
     * Tries every address in parallel and keeps the first that completes a handshake. A refusal
     * is authoritative (it is encrypted to our key by the pinned workstation) except
     * `pairing_expired`, which a sibling attempt may cause by burning the code first.
     */
    private suspend fun connectAny(
        addrs: List<HostPort>,
        key: KeyPair,
        hostPublic: ByteArray,
        pairCode: String?,
    ): RemoteConnection = coroutineScope {
        if (addrs.isEmpty()) throw IOException("no addresses")
        val winner = CompletableDeferred<RemoteConnection>()
        val sockets = java.util.concurrent.ConcurrentLinkedQueue<java.net.Socket>()
        val failures = AtomicInteger(0)
        val softRejection = java.util.concurrent.atomic.AtomicReference<HandshakeRejectedException?>(null)
        val hello = hello(pairCode)
        val jobs = addrs.map { address ->
            launch(Dispatchers.IO) {
                try {
                    val conn = RemoteConnection.open(address, key, hostPublic, hello, config.silenceMillis) { sockets.add(it) }
                    if (!winner.complete(conn)) conn.close()
                } catch (e: HandshakeRejectedException) {
                    if (e.reason == RejectReasons.PAIRING_EXPIRED) {
                        softRejection.set(e)
                        if (failures.incrementAndGet() == addrs.size) winner.completeExceptionally(e)
                    } else {
                        winner.completeExceptionally(e)
                    }
                } catch (e: Exception) {
                    if (failures.incrementAndGet() == addrs.size) {
                        winner.completeExceptionally(softRejection.get() ?: e)
                    }
                }
            }
        }
        try {
            winner.await()
        } finally {
            val won = runCatching { winner.getCompleted() }.getOrNull()
            for (s in sockets) if (won == null || !won.owns(s)) runCatching { s.close() }
            jobs.forEach { it.cancel() }
        }
    }

    private fun pairingMessage(reason: String): String = when (reason) {
        RejectReasons.PAIRING_EXPIRED -> "This pairing code expired or was already used. Show a new code in KalCode on your desktop."
        RejectReasons.REVOKED -> "This device was removed from the workstation. Pair again from a new code."
        RejectReasons.NOT_ENTITLED -> "Remote needs KalCode MAX on your workstation."
        RejectReasons.BUSY -> "Your workstation is busy. Try again in a moment."
        RejectReasons.VERSION -> "This workstation runs a different KalCode version. Update both apps."
        RejectReasons.INVALID -> "Your workstation refused this device's details. Update KalCode Remote."
        else -> "Your workstation refused the pairing ($reason)."
    }

    private companion object {
        const val MAX_IN_FLIGHT = 16
        const val CONFLICT_RETRY_MILLIS = 1_000L
    }

    /** For tests: stops all work. */
    fun close() {
        stopLoop()
        scope.coroutineContext[Job]?.cancel()
    }
}
