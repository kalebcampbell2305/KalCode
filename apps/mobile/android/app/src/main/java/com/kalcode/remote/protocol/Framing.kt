package com.kalcode.remote.protocol

import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.InputStream

/**
 * Wire framing (protocol §3).
 *
 * A wire frame is a 2-byte big-endian length followed by one Noise message (≤ 65535 bytes).
 * After the handshake the decrypted plaintexts of consecutive frames form one byte stream of
 * application messages: a 4-byte big-endian length followed by UTF-8 JSON (≤ 8 MiB). A sender
 * splits a message so each frame carries at most [MAX_FRAME_PLAINTEXT] plaintext bytes.
 */
object Framing {
    const val MAX_FRAME_PLAINTEXT = Noise.MAX_MESSAGE - Noise.TAG_LEN // 65519
    /** Desktop → device. */
    const val MAX_APP_MESSAGE = 8 * 1024 * 1024
    /** Device → desktop: the desktop closes the connection above this. */
    const val MAX_DEVICE_MESSAGE = 256 * 1024

    fun frame(message: ByteArray): ByteArray {
        require(message.size <= Noise.MAX_MESSAGE) { "Noise message too large: ${message.size}" }
        val out = ByteArray(2 + message.size)
        out[0] = (message.size ushr 8).toByte()
        out[1] = message.size.toByte()
        message.copyInto(out, 2)
        return out
    }

    /** Reads one wire frame. A clean end of stream before the first length byte is [EOFException]. */
    fun readFrame(input: InputStream): ByteArray {
        val hi = input.read()
        if (hi < 0) throw EOFException("connection closed")
        val lo = input.read()
        if (lo < 0) throw EOFException("connection closed mid-frame")
        val len = (hi shl 8) or lo
        val buf = ByteArray(len)
        var read = 0
        while (read < len) {
            val n = input.read(buf, read, len - read)
            if (n < 0) throw EOFException("connection closed mid-frame")
            read += n
        }
        return buf
    }

    /** `[len:u32 BE][json]` for one application message. */
    fun appMessage(json: ByteArray): ByteArray {
        require(json.size <= MAX_APP_MESSAGE) { "application message too large: ${json.size}" }
        val out = ByteArray(4 + json.size)
        out[0] = (json.size ushr 24).toByte()
        out[1] = (json.size ushr 16).toByte()
        out[2] = (json.size ushr 8).toByte()
        out[3] = json.size.toByte()
        json.copyInto(out, 4)
        return out
    }

    /**
     * Encrypts one application message into wire frames (length-prefixed), splitting the
     * plaintext into ≤ [MAX_FRAME_PLAINTEXT] chunks. Returns the bytes to write in one go.
     */
    fun encodeAppMessage(json: ByteArray, cipher: CipherState): ByteArray {
        val plain = appMessage(json)
        val out = ByteArrayOutputStream(plain.size + (plain.size / MAX_FRAME_PLAINTEXT + 1) * (2 + Noise.TAG_LEN))
        var offset = 0
        while (offset < plain.size) {
            val end = minOf(plain.size, offset + MAX_FRAME_PLAINTEXT)
            out.write(frame(cipher.encrypt(ByteArray(0), plain.copyOfRange(offset, end))))
            offset = end
        }
        return out.toByteArray()
    }
}

/** Reassembles application messages from decrypted frame plaintexts. */
class AppMessageDecoder {
    private var buffer = ByteArray(0)
    private var size = 0

    fun feed(plaintext: ByteArray) {
        if (size + plaintext.size > buffer.size) {
            buffer = buffer.copyOf(maxOf(buffer.size * 2, size + plaintext.size, 1024))
        }
        plaintext.copyInto(buffer, size)
        size += plaintext.size
    }

    /** The next complete message's JSON bytes, or null when more frames are needed. */
    fun next(): ByteArray? {
        if (size < 4) return null
        val len = ((buffer[0].toInt() and 0xff) shl 24) or ((buffer[1].toInt() and 0xff) shl 16) or
            ((buffer[2].toInt() and 0xff) shl 8) or (buffer[3].toInt() and 0xff)
        if (len < 0 || len > Framing.MAX_APP_MESSAGE) throw NoiseException("application message too large: $len")
        if (size < 4 + len) return null
        val message = buffer.copyOfRange(4, 4 + len)
        buffer.copyInto(buffer, 0, 4 + len, size)
        size -= 4 + len
        return message
    }

    val pendingBytes: Int get() = size
}
