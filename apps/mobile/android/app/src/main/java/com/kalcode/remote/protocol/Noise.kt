package com.kalcode.remote.protocol

import org.bouncycastle.crypto.InvalidCipherTextException
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.math.ec.rfc7748.X25519
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * `Noise_IK_25519_ChaChaPoly_SHA256` (protocol §3), written against the Noise specification
 * revision 34. Both roles are implemented: the app is always the initiator; the responder backs
 * the JVM and on-device tests' fake workstation.
 */
object Noise {
    const val PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_SHA256"
    val PROLOGUE: ByteArray = "kalcode-remote/1".toByteArray(Charsets.US_ASCII)
    const val DH_LEN = 32
    const val HASH_LEN = 32
    const val TAG_LEN = 16
    const val MAX_MESSAGE = 65535
}

class NoiseException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** An X25519 keypair. [private] is the raw 32-byte scalar (clamped on use, as RFC 7748 says). */
class KeyPair(val private: ByteArray, val public: ByteArray) {
    init {
        require(private.size == Noise.DH_LEN && public.size == Noise.DH_LEN)
    }

    fun wipe() = private.fill(0)

    companion object {
        private val random = SecureRandom()

        fun generate(): KeyPair {
            val private = ByteArray(Noise.DH_LEN).also(random::nextBytes)
            return fromPrivate(private)
        }

        fun fromPrivate(private: ByteArray): KeyPair {
            require(private.size == Noise.DH_LEN) { "X25519 private keys are 32 bytes" }
            val public = ByteArray(Noise.DH_LEN)
            X25519.scalarMultBase(private, 0, public, 0)
            return KeyPair(private.copyOf(), public)
        }
    }
}

internal fun dh(private: ByteArray, public: ByteArray): ByteArray {
    val out = ByteArray(Noise.DH_LEN)
    if (!X25519.calculateAgreement(private, 0, public, 0, out, 0)) {
        throw NoiseException("X25519 produced a low-order result")
    }
    return out
}

internal fun sha256(vararg parts: ByteArray): ByteArray {
    val digest = MessageDigest.getInstance("SHA-256")
    parts.forEach(digest::update)
    return digest.digest()
}

internal fun hmacSha256(key: ByteArray, vararg parts: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    parts.forEach(mac::update)
    return mac.doFinal()
}

/** Noise HKDF with HMAC-SHA256, two outputs. */
internal fun hkdf2(chainingKey: ByteArray, ikm: ByteArray): Pair<ByteArray, ByteArray> {
    val temp = hmacSha256(chainingKey, ikm)
    val out1 = hmacSha256(temp, byteArrayOf(1))
    val out2 = hmacSha256(temp, out1, byteArrayOf(2))
    return out1 to out2
}

/** A ChaCha20-Poly1305 cipher with Noise's counter nonce: 4 zero bytes + 8-byte little-endian n. */
class CipherState internal constructor(private var key: ByteArray? = null) {
    /** The next nonce. Strictly increasing; a gap or repeat makes decryption fail. */
    var nonce: Long = 0L
        private set

    val hasKey: Boolean get() = key != null

    private fun nonceBytes(): ByteArray {
        val bytes = ByteArray(12)
        var n = nonce
        for (i in 4 until 12) {
            bytes[i] = (n and 0xff).toByte()
            n = n ushr 8
        }
        return bytes
    }

    fun encrypt(ad: ByteArray, plaintext: ByteArray): ByteArray {
        val k = key ?: return plaintext
        if (nonce == -1L) throw NoiseException("nonce exhausted")
        val aead = ChaCha20Poly1305()
        aead.init(true, AEADParameters(KeyParameter(k), Noise.TAG_LEN * 8, nonceBytes(), ad))
        val out = ByteArray(aead.getOutputSize(plaintext.size))
        var len = aead.processBytes(plaintext, 0, plaintext.size, out, 0)
        len += aead.doFinal(out, len)
        nonce++
        return if (len == out.size) out else out.copyOf(len)
    }

    fun decrypt(ad: ByteArray, ciphertext: ByteArray): ByteArray {
        val k = key ?: return ciphertext
        if (ciphertext.size < Noise.TAG_LEN) throw NoiseException("ciphertext shorter than its tag")
        val aead = ChaCha20Poly1305()
        aead.init(false, AEADParameters(KeyParameter(k), Noise.TAG_LEN * 8, nonceBytes(), ad))
        val out = ByteArray(aead.getOutputSize(ciphertext.size))
        try {
            var len = aead.processBytes(ciphertext, 0, ciphertext.size, out, 0)
            len += aead.doFinal(out, len)
            nonce++
            return if (len == out.size) out else out.copyOf(len)
        } catch (e: InvalidCipherTextException) {
            throw NoiseException("decryption failed", e)
        }
    }

    fun wipe() {
        key?.fill(0)
        key = null
    }
}

private class SymmetricState(protocolName: String) {
    var ck: ByteArray
    var h: ByteArray
    var cipher = CipherState()
        private set

    init {
        val name = protocolName.toByteArray(Charsets.US_ASCII)
        h = if (name.size <= Noise.HASH_LEN) name.copyOf(Noise.HASH_LEN) else sha256(name)
        ck = h.copyOf()
    }

    fun mixKey(ikm: ByteArray) {
        val (newCk, tempK) = hkdf2(ck, ikm)
        ck = newCk
        cipher.wipe()
        cipher = CipherState(tempK.copyOf(32))
    }

    fun mixHash(data: ByteArray) {
        h = sha256(h, data)
    }

    fun encryptAndHash(plaintext: ByteArray): ByteArray {
        val ct = cipher.encrypt(h, plaintext)
        mixHash(ct)
        return ct
    }

    fun decryptAndHash(ciphertext: ByteArray): ByteArray {
        val pt = cipher.decrypt(h, ciphertext)
        mixHash(ciphertext)
        return pt
    }

    fun split(): Pair<CipherState, CipherState> {
        val (k1, k2) = hkdf2(ck, ByteArray(0))
        return CipherState(k1.copyOf(32)) to CipherState(k2.copyOf(32))
    }
}

/** The two transport ciphers after a completed handshake. */
class TransportState(val send: CipherState, val receive: CipherState, val handshakeHash: ByteArray)

/**
 * The IK handshake. Pre-message: `<- s`. Message 1 (initiator → responder): `e, es, s, ss`.
 * Message 2 (responder → initiator): `e, ee, se`.
 *
 * [fixedEphemeral] exists only so tests can reproduce the committed vectors.
 */
class HandshakeState private constructor(
    private val initiator: Boolean,
    private val s: KeyPair,
    private var rs: ByteArray?,
    private val fixedEphemeral: KeyPair?,
) {
    private val ss = SymmetricState(Noise.PROTOCOL_NAME)
    private var e: KeyPair? = null
    private var re: ByteArray? = null
    private var step = 0

    init {
        ss.mixHash(Noise.PROLOGUE)
        // `<- s`: both sides hash the responder's static key.
        ss.mixHash(if (initiator) rs!! else s.public)
    }

    /** The peer's static public key: the pinned workstation (initiator) or the device (responder). */
    val remoteStatic: ByteArray? get() = rs?.copyOf()

    private fun newEphemeral(): KeyPair = fixedEphemeral ?: KeyPair.generate()

    /** Writes the next handshake message carrying [payload]. */
    fun writeMessage(payload: ByteArray): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        when {
            initiator && step == 0 -> {
                val eph = newEphemeral().also { e = it }
                out.write(eph.public)
                ss.mixHash(eph.public)
                ss.mixKey(dh(eph.private, rs!!)) // es
                out.write(ss.encryptAndHash(s.public)) // s
                ss.mixKey(dh(s.private, rs!!)) // ss
            }
            !initiator && step == 1 -> {
                val eph = newEphemeral().also { e = it }
                out.write(eph.public)
                ss.mixHash(eph.public)
                ss.mixKey(dh(eph.private, re!!)) // ee
                ss.mixKey(dh(eph.private, rs!!)) // se
            }
            else -> throw NoiseException("handshake message out of order")
        }
        out.write(ss.encryptAndHash(payload))
        step++
        val message = out.toByteArray()
        if (message.size > Noise.MAX_MESSAGE) throw NoiseException("handshake message too large")
        return message
    }

    /** Reads the next handshake message and returns its decrypted payload. */
    fun readMessage(message: ByteArray): ByteArray {
        var offset = 0
        fun take(n: Int): ByteArray {
            if (message.size - offset < n) throw NoiseException("handshake message too short")
            return message.copyOfRange(offset, offset + n).also { offset += n }
        }
        when {
            !initiator && step == 0 -> {
                val remoteE = take(Noise.DH_LEN).also { re = it }
                ss.mixHash(remoteE)
                ss.mixKey(dh(s.private, remoteE)) // es
                val remoteS = ss.decryptAndHash(take(Noise.DH_LEN + Noise.TAG_LEN)) // s
                rs = remoteS
                ss.mixKey(dh(s.private, remoteS)) // ss
            }
            initiator && step == 1 -> {
                val remoteE = take(Noise.DH_LEN).also { re = it }
                ss.mixHash(remoteE)
                ss.mixKey(dh(e!!.private, remoteE)) // ee
                ss.mixKey(dh(s.private, remoteE)) // se
            }
            else -> throw NoiseException("handshake message out of order")
        }
        val payload = ss.decryptAndHash(message.copyOfRange(offset, message.size))
        step++
        return payload
    }

    val isComplete: Boolean get() = step >= 2

    val handshakeHash: ByteArray get() = ss.h.copyOf()

    /** Splits into transport ciphers. The initiator sends with the first key. */
    fun split(): TransportState {
        check(isComplete) { "handshake not complete" }
        val (c1, c2) = ss.split()
        e?.takeIf { it !== fixedEphemeral }?.wipe()
        return if (initiator) TransportState(c1, c2, ss.h.copyOf()) else TransportState(c2, c1, ss.h.copyOf())
    }

    companion object {
        fun initiator(local: KeyPair, remoteStatic: ByteArray, fixedEphemeral: KeyPair? = null): HandshakeState {
            require(remoteStatic.size == Noise.DH_LEN) { "the workstation key is 32 bytes" }
            return HandshakeState(true, local, remoteStatic.copyOf(), fixedEphemeral)
        }

        fun responder(local: KeyPair, fixedEphemeral: KeyPair? = null): HandshakeState =
            HandshakeState(false, local, null, fixedEphemeral)
    }
}
