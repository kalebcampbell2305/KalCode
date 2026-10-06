package com.kalcode.remote.protocol

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.EOFException

class FramingTest {
    private fun pair(): Pair<TransportState, TransportState> {
        val host = KeyPair.generate()
        val i = HandshakeState.initiator(KeyPair.generate(), host.public)
        val r = HandshakeState.responder(host)
        r.readMessage(i.writeMessage(ByteArray(0)))
        i.readMessage(r.writeMessage(ByteArray(0)))
        return i.split() to r.split()
    }

    @Test
    fun frameIsTwoByteBigEndianLength() {
        val f = Framing.frame(ByteArray(300) { 7 })
        assertEquals(0x01, f[0].toInt())
        assertEquals(0x2c, f[1].toInt() and 0xff)
        assertEquals(302, f.size)
        assertArrayEquals(ByteArray(300) { 7 }, Framing.readFrame(ByteArrayInputStream(f)))
    }

    @Test
    fun appMessageIsFourByteBigEndianLength() {
        val m = Framing.appMessage("{}".toByteArray())
        assertArrayEquals(byteArrayOf(0, 0, 0, 2, '{'.code.toByte(), '}'.code.toByte()), m)
    }

    @Test
    fun largeMessagesSplitAcrossFramesOfAtMost65519PlaintextBytes() {
        val (dev, host) = pair()
        val json = ByteArray(Framing.MAX_FRAME_PLAINTEXT * 2 + 1000) { 'x'.code.toByte() }
        val wire = Framing.encodeAppMessage(json, dev.send)
        val input = ByteArrayInputStream(wire)
        val decoder = AppMessageDecoder()
        var frames = 0
        var message: ByteArray? = null
        while (message == null) {
            val frame = Framing.readFrame(input)
            assertTrue(frame.size <= Noise.MAX_MESSAGE)
            val plain = host.receive.decrypt(ByteArray(0), frame)
            assertTrue(plain.size <= Framing.MAX_FRAME_PLAINTEXT)
            frames++
            decoder.feed(plain)
            message = decoder.next()
        }
        assertEquals(3, frames)
        assertArrayEquals(json, message)
        assertEquals(0, decoder.pendingBytes)
    }

    @Test
    fun decoderHandlesSeveralMessagesAndPartialFeeds() {
        val decoder = AppMessageDecoder()
        val stream = Framing.appMessage("""{"t":"pong","n":1}""".toByteArray()) + Framing.appMessage("""{"t":"pong","n":2}""".toByteArray())
        decoder.feed(stream.copyOfRange(0, 3))
        assertNull(decoder.next())
        decoder.feed(stream.copyOfRange(3, 22))
        assertEquals("""{"t":"pong","n":1}""", String(decoder.next()!!))
        assertNull(decoder.next())
        decoder.feed(stream.copyOfRange(22, stream.size))
        assertEquals("""{"t":"pong","n":2}""", String(decoder.next()!!))
    }

    @Test
    fun oversizedApplicationMessagesAreRejected() {
        val decoder = AppMessageDecoder()
        decoder.feed(byteArrayOf(0x00, 0x80.toByte(), 0x00, 0x01)) // 8 MiB + 1
        try {
            decoder.next()
            fail("accepted an oversized message")
        } catch (_: NoiseException) {
        }
    }

    @Test(expected = EOFException::class)
    fun truncatedFrameIsEof() {
        Framing.readFrame(ByteArrayInputStream(byteArrayOf(0, 5, 1, 2)))
    }

    @Test
    fun noncesIncreaseAndOutOfOrderFramesFail() {
        val (dev, host) = pair()
        val a = Framing.encodeAppMessage("{}".toByteArray(), dev.send)
        val b = Framing.encodeAppMessage("{}".toByteArray(), dev.send)
        assertEquals(2L, dev.send.nonce)
        // Receiving b before a (a gap) fails authentication.
        try {
            host.receive.decrypt(ByteArray(0), b.copyOfRange(2, b.size))
            fail("decrypted out of order")
        } catch (_: NoiseException) {
        }
        assertTrue(a.isNotEmpty())
    }
}
