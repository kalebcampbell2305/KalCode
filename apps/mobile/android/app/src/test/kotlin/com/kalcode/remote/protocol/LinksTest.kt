package com.kalcode.remote.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

class LinksTest {
    private val pk = Base64Any.encode(ByteArray(32) { 1 })
    private val code = Base64Any.encode(ByteArray(32) { 2 })
    private fun link(exp: Long = 4_000_000_000, v: Int = 1, addrs: List<String> = listOf("192.168.1.20:47820", "100.101.102.103:47820")): String {
        val json = WireJson.encodeToString(PairingPayload.serializer(), PairingPayload(v, "ws_1", "Kaleb's Workstation", pk, code, addrs, exp))
        return "kalcode-remote://pair?d=" + Base64Any.encodeUrl(json.toByteArray())
    }

    private fun expect(error: PairingLinkError, text: String) {
        try {
            PairingLink.parse(text)
            fail("parsed $text")
        } catch (e: PairingLinkException) {
            assertEquals(error, e.error)
        }
    }

    @Test
    fun parsesTheRustLinkFormat() {
        val p = PairingLink.parse(link())
        assertEquals("Kaleb's Workstation", p.name)
        assertEquals(32, p.publicKey?.size)
        assertEquals(HostPort("100.101.102.103", 47820), HostPort.parse(p.addrs[1]))
    }

    @Test
    fun toleratesWhitespacePaddingAndExtraParameters() {
        val l = link()
        PairingLink.parse("  \n" + l.substring(0, 30) + "\n" + l.substring(30) + "==&x=1 ")
    }

    @Test
    fun rejectsBadLinks() {
        expect(PairingLinkError.NOT_A_PAIRING_LINK, "https://example.com")
        expect(PairingLinkError.MALFORMED, "kalcode-remote://pair?d=!!!")
        expect(PairingLinkError.MALFORMED, "kalcode-remote://pair?x=1")
        expect(PairingLinkError.EXPIRED, link(exp = 1))
        expect(PairingLinkError.UNSUPPORTED_VERSION, link(v = 2))
        expect(PairingLinkError.NO_ADDRESSES, link(addrs = listOf("nope")))
    }

    @Test
    fun deepLinks() {
        assertEquals(DeepLink.AgentLink("thr_1"), DeepLink.parse("kalcode-remote://agent/thr_1"))
        assertEquals(DeepLink.Needs("approval:apr_1"), DeepLink.parse("kalcode-remote://needs/approval:apr_1"))
        assertEquals(DeepLink.RunLink("op_1"), DeepLink.parse("kalcode-remote://run/op_1"))
        assertEquals(DeepLink.Diff("thr_2"), DeepLink.parse("kalcode-remote://diff/thr_2"))
        assertEquals(DeepLink.Fleet, DeepLink.parse("kalcode-remote://fleet"))
        assertEquals(DeepLink.Pair(link()), DeepLink.parse(link()))
        assertNull(DeepLink.parse("kalcode-remote://agent/"))
        assertNull(DeepLink.parse("https://agent/thr_1"))
        assertNull(DeepLink.parse("kalcode-remote://shell/rm"))
    }

    @Test
    fun handshakeFieldsAreTruncatedAndCleaned() {
        assertEquals("Kaleb's Pixel", handshakeField(" Kaleb's\u0000 Pixel\n"))
        val long = "P".repeat(80)
        assertEquals(64, handshakeField(long).length)
        assertEquals("ab", handshakeField("a\tb"))
        // An emoji at the cut is never split in half.
        val emoji = "x".repeat(63) + "\uD83D\uDE80"
        assertEquals(63, handshakeField(emoji).length)
    }
}
