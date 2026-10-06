package com.kalcode.remote.protocol

import kotlinx.serialization.Serializable
import java.net.URI
import java.net.URLDecoder
import java.util.Base64

/** `kalcode-remote://pair?d=<base64url(JSON)>` (protocol §2). */
@Serializable
data class PairingPayload(
    val v: Int,
    val wid: String,
    val name: String,
    val pk: String,
    val code: String,
    val addrs: List<String>,
    val exp: Long,
) {
    val publicKey: ByteArray? get() = Base64Any.decode(pk)?.takeIf { it.size == 32 }
    fun isExpired(nowMillis: Long = System.currentTimeMillis()) = nowMillis / 1000 >= exp
}

enum class PairingLinkError(val message: String) {
    NOT_A_PAIRING_LINK("That isn't a KalCode pairing link."),
    MALFORMED("This pairing link is damaged. Copy it again from KalCode on your desktop."),
    UNSUPPORTED_VERSION("This pairing link is from a newer KalCode. Update KalCode Remote."),
    INVALID_KEY("This pairing link is damaged. Copy it again from KalCode on your desktop."),
    NO_ADDRESSES("This pairing link has no reachable address."),
    EXPIRED("This pairing code has expired. Show a new code in KalCode on your desktop."),
}

class PairingLinkException(val error: PairingLinkError) : Exception(error.message)

object PairingLink {
    const val SCHEME = "kalcode-remote"

    /** Accepts the full link, or the link with whitespace/line breaks pasted around or inside it. */
    fun parse(text: String, nowMillis: Long = System.currentTimeMillis()): PairingPayload {
        val compact = text.filterNot { it.isWhitespace() }
        val prefix = "$SCHEME://pair?"
        if (!compact.startsWith(prefix, ignoreCase = true)) throw PairingLinkException(PairingLinkError.NOT_A_PAIRING_LINK)
        val query = compact.substring(prefix.length)
        val d = query.split('&').firstNotNullOfOrNull { it.removePrefix("d=").takeIf { v -> it.startsWith("d=") } }
            ?: throw PairingLinkException(PairingLinkError.MALFORMED)
        val json = Base64Any.decode(URLDecoder.decode(d, "UTF-8")) ?: throw PairingLinkException(PairingLinkError.MALFORMED)
        val payload = runCatching { WireJson.decodeFromString(PairingPayload.serializer(), String(json, Charsets.UTF_8)) }
            .getOrElse { throw PairingLinkException(PairingLinkError.MALFORMED) }
        if (payload.v != 1) throw PairingLinkException(PairingLinkError.UNSUPPORTED_VERSION)
        if (payload.publicKey == null || Base64Any.decode(payload.code)?.size != 32) {
            throw PairingLinkException(PairingLinkError.INVALID_KEY)
        }
        if (payload.addrs.none { HostPort.parse(it) != null }) throw PairingLinkException(PairingLinkError.NO_ADDRESSES)
        if (payload.isExpired(nowMillis)) throw PairingLinkException(PairingLinkError.EXPIRED)
        return payload
    }

    fun looksLikePairingLink(text: String) = text.trim().startsWith("$SCHEME://pair", ignoreCase = true)
}

/** `"192.168.1.20:47820"` → host + port. */
data class HostPort(val host: String, val port: Int) {
    override fun toString() = if (':' in host) "[$host]:$port" else "$host:$port"

    companion object {
        fun parse(text: String): HostPort? {
            val s = text.trim()
            val colon = s.lastIndexOf(':')
            if (colon <= 0) return null
            val port = s.substring(colon + 1).toIntOrNull()?.takeIf { it in 1..65535 } ?: return null
            var host = s.substring(0, colon)
            if (host.startsWith("[") && host.endsWith("]")) host = host.substring(1, host.length - 1)
            if (host.isEmpty()) return null
            return HostPort(host, port)
        }
    }
}

object Base64Any {
    /** Decodes standard or URL-safe base64, with or without padding. */
    fun decode(text: String): ByteArray? {
        val s = text.trim().replace('-', '+').replace('_', '/').trimEnd('=')
        if (s.length % 4 == 1) return null
        return runCatching { Base64.getDecoder().decode(s + "=".repeat((4 - s.length % 4) % 4)) }.getOrNull()
    }

    fun encode(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    fun encodeUrl(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}

/** Notification and navigation links (protocol §6). */
sealed interface DeepLink {
    data class Pair(val link: String) : DeepLink
    data class AgentLink(val id: String) : DeepLink
    data class Needs(val id: String) : DeepLink
    data class RunLink(val id: String) : DeepLink
    data class Diff(val id: String) : DeepLink
    data object Fleet : DeepLink

    companion object {
        fun parse(link: String?): DeepLink? {
            if (link.isNullOrBlank()) return null
            val trimmed = link.trim()
            if (PairingLink.looksLikePairingLink(trimmed)) return Pair(trimmed)
            val uri = runCatching { URI(trimmed) }.getOrNull() ?: return null
            if (!uri.scheme.equals(PairingLink.SCHEME, ignoreCase = true)) return null
            val host = uri.host?.lowercase() ?: return null
            val id = uri.rawPath?.trim('/')?.split('/')?.firstOrNull()
                ?.let { URLDecoder.decode(it, "UTF-8") }
                ?.takeIf { it.isNotEmpty() }
            return when (host) {
                "fleet" -> Fleet
                "agent" -> id?.let(::AgentLink)
                "needs" -> id?.let(::Needs)
                "run" -> id?.let(::RunLink)
                "diff" -> id?.let(::Diff)
                else -> null
            }
        }
    }
}
