package com.kalcode.remote.client

import com.kalcode.remote.protocol.AppMessageDecoder
import com.kalcode.remote.protocol.DeviceHello
import com.kalcode.remote.protocol.DeviceMessages
import com.kalcode.remote.protocol.Framing
import com.kalcode.remote.protocol.HandshakeReply
import com.kalcode.remote.protocol.HandshakeState
import com.kalcode.remote.protocol.HostPort
import com.kalcode.remote.protocol.KeyPair
import com.kalcode.remote.protocol.TransportState
import com.kalcode.remote.protocol.WireJson
import java.io.BufferedInputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket

/** The desktop refused the handshake (§3): unpaired, revoked, pairing_expired, not_entitled, busy, version. */
class HandshakeRejectedException(val reason: String) : IOException("handshake rejected: $reason")

/**
 * One encrypted session over TCP. Blocking I/O: call from Dispatchers.IO. [close] from any
 * thread unblocks a pending [receive].
 */
class RemoteConnection private constructor(
    private val socket: Socket,
    private val input: InputStream,
    private val output: OutputStream,
    private val transport: TransportState,
    val reply: HandshakeReply,
    val address: HostPort,
) : Closeable {
    private val decoder = AppMessageDecoder()
    private val writeLock = Any()

    val handshakeHash: ByteArray get() = transport.handshakeHash

    fun owns(s: Socket): Boolean = s === socket

    /** Sends one application message (JSON bytes). */
    fun send(json: ByteArray) {
        synchronized(writeLock) {
            val wire = Framing.encodeAppMessage(json, transport.send)
            output.write(wire)
            output.flush()
        }
    }

    /**
     * The next application message's JSON bytes. Throws [java.net.SocketTimeoutException] after
     * the configured silence, [java.io.EOFException] when the desktop closed, and
     * [com.kalcode.remote.protocol.NoiseException] on any decryption failure (fatal).
     */
    fun receive(): ByteArray {
        while (true) {
            decoder.next()?.let { return it }
            val frame = Framing.readFrame(input)
            decoder.feed(transport.receive.decrypt(ByteArray(0), frame))
        }
    }

    override fun close() {
        runCatching { socket.close() }
        transport.send.wipe()
        transport.receive.wipe()
    }

    companion object {
        const val HANDSHAKE_TIMEOUT_MS = 10_000

        /**
         * Connects to [address], runs the IK handshake pinned to [hostPublic] and sends `hello`.
         * [silenceMillis] becomes the read timeout: 35 s without a byte means the session is dead.
         * [onSocket] receives the socket as soon as it exists so a racing caller can close it.
         */
        fun open(
            address: HostPort,
            deviceKey: KeyPair,
            hostPublic: ByteArray,
            hello: DeviceHello,
            silenceMillis: Int,
            onSocket: (Socket) -> Unit = {},
        ): RemoteConnection {
            val socket = Socket()
            onSocket(socket)
            try {
                socket.tcpNoDelay = true
                socket.keepAlive = true
                socket.connect(InetSocketAddress(address.host, address.port), HANDSHAKE_TIMEOUT_MS)
                socket.soTimeout = HANDSHAKE_TIMEOUT_MS
                val input = BufferedInputStream(socket.getInputStream(), 64 * 1024)
                val output = socket.getOutputStream()

                val handshake = HandshakeState.initiator(deviceKey, hostPublic)
                val payload = WireJson.encodeToString(DeviceHello.serializer(), hello).toByteArray()
                output.write(Framing.frame(handshake.writeMessage(payload)))
                output.flush()
                val replyBytes = handshake.readMessage(Framing.readFrame(input))
                val reply = WireJson.decodeFromString(HandshakeReply.serializer(), String(replyBytes, Charsets.UTF_8))
                if (!reply.ok) throw HandshakeRejectedException(reply.error ?: "unknown")
                if (reply.wid == null || reply.deviceId == null) throw IOException("acceptance is missing wid or deviceId")

                val connection = RemoteConnection(socket, input, output, handshake.split(), reply, address)
                connection.send(DeviceMessages.hello()) // key confirmation
                socket.soTimeout = silenceMillis
                return connection
            } catch (t: Throwable) {
                runCatching { socket.close() }
                throw t
            }
        }
    }
}
