package com.kalcode.remote.ui

import com.kalcode.remote.client.ConnectionLostException
import com.kalcode.remote.client.MessageTooLargeException
import com.kalcode.remote.client.NotConnectedException
import com.kalcode.remote.client.OfflineReason
import com.kalcode.remote.client.QueueExpiredException
import com.kalcode.remote.client.RemoteCallException
import com.kalcode.remote.client.RequestTimeoutException
import com.kalcode.remote.client.WentOfflineException

/** What the person reads, worded exactly as KalCode Remote on iOS (apps/mobile/ios/App/Core/ErrorCopy.swift). */
object Copy {
    fun error(e: Throwable, workstation: String): String = when (e) {
        is kotlinx.coroutines.CancellationException -> "Cancelled."
        is NotConnectedException -> "Not connected to $workstation."
        is ConnectionLostException -> "The connection dropped before KalCode confirmed. Check before trying again."
        is MessageTooLargeException -> "That message is too long to send."
        is QueueExpiredException, is WentOfflineException, is RequestTimeoutException -> e.message ?: "Not sent."
        is RemoteCallException -> when {
            e.isRateLimited -> "Slow down — $workstation limits how fast actions can be sent. Try again in a minute."
            e.code == "conflict" -> "The state changed — refreshed."
            e.code == "not_found" -> e.message?.takeIf { it.isNotBlank() } ?: "That no longer exists on $workstation."
            e.code == "refused" -> e.message?.takeIf { it.isNotBlank() } ?: "KalCode declined this for safety."
            e.code == "not_entitled" -> "Remote is part of KalCode MAX."
            e.code == "unavailable" -> "That isn't available on $workstation right now."
            e.code == "invalid" -> "KalCode couldn't read that request."
            else -> e.message?.takeIf { it.isNotBlank() } ?: "Something went wrong on $workstation."
        }
        else -> "Something went wrong. Try again."
    }

    /** Title and detail for a workstation that's offline (iOS ConnectionBanner). */
    fun offline(reason: OfflineReason, name: String): Pair<String, String> = when (reason) {
        OfflineReason.UNREACHABLE -> "$name isn't reachable" to "Check that it's awake, KalCode is open, and you're on the same network or Tailscale."
        OfflineReason.SHUTDOWN -> "KalCode closed on $name" to "It reconnects automatically when KalCode opens again."
        OfflineReason.DISABLED -> "Remote is turned off on $name" to "Turn it on in KalCode → Settings → Remote."
        OfflineReason.NOT_ENTITLED -> "Remote is part of KalCode MAX" to "$name's plan doesn't include Remote."
        OfflineReason.VERSION -> "Update needed" to "This app and KalCode on $name speak different versions. Update both to the latest."
        OfflineReason.REPLACED -> "This device connected from somewhere else" to "A newer session from this device took over. Try again to reconnect here."
        OfflineReason.INVALID -> "$name didn't accept this device's details" to "Update KalCode Remote, then try again."
    }

    /** Title and detail for a failed pairing (iOS PairFailure). */
    fun pairFailure(reason: String?, name: String): Pair<String, String> = when (reason) {
        "pairing_expired" -> "This code was used or has expired" to
            "Pairing codes work once and only for a few minutes. On $name, show a new code and scan it again."
        "not_entitled" -> "Remote is part of KalCode MAX" to "$name's plan doesn't include Remote."
        "version" -> "Update needed" to "This app and KalCode on $name speak different Remote versions. Update both to the latest release."
        "busy" -> "$name is busy" to "Another device is connecting right now. Try again in a moment."
        "invalid" -> "$name didn't accept this device" to "Its details were refused. Update KalCode Remote and KalCode, then show a new pairing code."
        "revoked", "unpaired" -> "$name didn't accept this device" to "Show a new pairing code on your workstation and try again."
        else -> "Can't reach $name" to
            "Make sure this device is on the same Wi‑Fi or Tailscale network as your workstation and that KalCode is open."
    }
}

/** "phone" or "tablet", for copy like "This phone was removed". */
fun deviceNoun(context: android.content.Context): String =
    if (context.resources.configuration.smallestScreenWidthDp >= 600) "tablet" else "phone"
