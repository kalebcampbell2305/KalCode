package com.kalcode.remote.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.File

/**
 * Reproduces `crates/remote/tests/vectors/noise_ik.json` (the Rust crate's committed vectors)
 * byte for byte: keys, both handshake messages, the handshake hash, the transport ciphertexts
 * and the wire frames.
 */
class NoiseVectorTest {
    private val v: JsonObject by lazy {
        val path = System.getProperty("kalcode.noiseVectors") ?: error("kalcode.noiseVectors not set")
        Json.parseToJsonElement(File(path).readText()).jsonObject
    }

    private fun hex(s: String): ByteArray = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it) }
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private val keys get() = v["keys"]!!.jsonObject
    private val handshake get() = v["handshake"] as JsonArray
    private val transport get() = v["transport"] as JsonArray

    @Test
    fun protocolNameAndPrologue() {
        assertEquals(Noise.PROTOCOL_NAME, v.s("protocol_name"))
        assertEquals(v.s("prologue_hex"), Noise.PROLOGUE.hex())
    }

    @Test
    fun publicKeysDeriveFromPrivates() {
        for (role in listOf("initiator_static", "initiator_ephemeral", "responder_static", "responder_ephemeral")) {
            val pair = KeyPair.fromPrivate(hex(keys.s("${role}_private")))
            assertEquals(role, keys.s("${role}_public"), pair.public.hex())
        }
    }

    @Test
    fun rfc7748AliceVector() {
        val alice = KeyPair.fromPrivate(hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"))
        assertEquals("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a", alice.public.hex())
    }

    @Test
    fun handshakeAndTransportMatchByteForByte() {
        val iStatic = KeyPair.fromPrivate(hex(keys.s("initiator_static_private")))
        val iEph = KeyPair.fromPrivate(hex(keys.s("initiator_ephemeral_private")))
        val rStatic = KeyPair.fromPrivate(hex(keys.s("responder_static_private")))
        val rEph = KeyPair.fromPrivate(hex(keys.s("responder_ephemeral_private")))

        val initiator = HandshakeState.initiator(iStatic, rStatic.public, fixedEphemeral = iEph)
        val responder = HandshakeState.responder(rStatic, fixedEphemeral = rEph)

        val m1 = handshake[0].jsonObject
        val payload1 = hex(m1.s("payload_hex"))
        val message1 = initiator.writeMessage(payload1)
        assertEquals(m1.s("message_hex"), message1.hex())
        assertEquals(m1.s("wire_frame_hex"), Framing.frame(message1).hex())
        assertArrayEquals(payload1, responder.readMessage(message1))
        assertArrayEquals(iStatic.public, responder.remoteStatic)

        val m2 = handshake[1].jsonObject
        val payload2 = hex(m2.s("payload_hex"))
        val message2 = responder.writeMessage(payload2)
        assertEquals(m2.s("message_hex"), message2.hex())
        assertEquals(m2.s("wire_frame_hex"), Framing.frame(message2).hex())
        assertArrayEquals(payload2, initiator.readMessage(message2))

        assertEquals(v.s("handshake_hash"), initiator.handshakeHash.hex())
        assertEquals(v.s("handshake_hash"), responder.handshakeHash.hex())

        val i = initiator.split()
        val r = responder.split()
        for (entry in transport) {
            val t = entry.jsonObject
            val json = t.s("json").toByteArray()
            val plaintext = Framing.appMessage(json)
            assertEquals(t.s("plaintext_hex"), plaintext.hex())
            val fromInitiator = t.s("direction") == "initiator_to_responder"
            val (send, recv) = if (fromInitiator) i.send to r.receive else r.send to i.receive
            assertEquals(t["nonce"]!!.jsonPrimitive.long, send.nonce)
            val wire = Framing.encodeAppMessage(json, send)
            assertEquals(t.s("wire_frame_hex"), wire.hex())
            assertEquals(t.s("ciphertext_hex"), wire.copyOfRange(2, wire.size).hex())
            // And the receiving side decrypts and reassembles it.
            val decoder = AppMessageDecoder()
            decoder.feed(recv.decrypt(ByteArray(0), Framing.readFrame(ByteArrayInputStream(wire))))
            assertArrayEquals(json, decoder.next())
        }
    }

    @Test
    fun ourHelloAndDeviceMessagesSerializeExactlyLikeTheVector() {
        val m1 = handshake[0].jsonObject
        val hello = DeviceHello(
            device = "Test iPhone", platform = "ios", model = "iPhone17,1", app = "1.0 (1)",
            pair = Base64Any.encode(ByteArray(32) { 0x42 }), ts = 1_791_234_567,
        )
        assertEquals(m1.s("payload_utf8"), WireJson.encodeToString(DeviceHello.serializer(), hello))
        assertEquals(transport[0].jsonObject.s("json"), String(DeviceMessages.hello()))
        assertEquals(transport[1].jsonObject.s("json"), String(DeviceMessages.ping(1)))
        val reply = WireJson.decodeFromString(HandshakeReply.serializer(), handshake[1].jsonObject.s("payload_utf8"))
        assertTrue(reply.ok)
        assertEquals("dev_00000000000000000000test", reply.deviceId)
        assertEquals(2007L, reply.host?.build)
    }

    @Test
    fun hostMessagesInTheVectorParse() {
        assertEquals(HostMessage.Pong(1), HostMessage.parse(transport[2].jsonObject.s("json")))
        assertEquals(HostMessage.Bye("shutdown"), HostMessage.parse(transport[3].jsonObject.s("json")))
    }

    @Test
    fun tamperedOrReplayedTransportFramesAreFatal() {
        val host = KeyPair.generate()
        val dev = KeyPair.generate()
        val i = HandshakeState.initiator(dev, host.public)
        val r = HandshakeState.responder(host)
        r.readMessage(i.writeMessage(ByteArray(0)))
        i.readMessage(r.writeMessage(ByteArray(0)))
        val it = i.split()
        val rt = r.split()
        val ct = it.send.encrypt(ByteArray(0), "hi".toByteArray())
        val tampered = ct.copyOf().also { b -> b[0] = (b[0].toInt() xor 1).toByte() }
        try {
            rt.receive.decrypt(ByteArray(0), tampered)
            fail("tampered frame decrypted")
        } catch (_: NoiseException) {
        }
        // Wrong key (pinned workstation differs): the responder can't read message 1.
        val impostor = HandshakeState.responder(KeyPair.generate())
        try {
            impostor.readMessage(HandshakeState.initiator(dev, host.public).writeMessage("x".toByteArray()))
            fail("impostor read the handshake")
        } catch (_: NoiseException) {
        }
    }
}
