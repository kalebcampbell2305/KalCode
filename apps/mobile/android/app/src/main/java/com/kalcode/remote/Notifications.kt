package com.kalcode.remote

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.kalcode.remote.protocol.DeepLink
import com.kalcode.remote.protocol.Notify

/** Local notifications for `notify` events (protocol §6), with deep-link taps. */
object Notifications {
    const val CHANNEL_NEEDS_YOU = "needs_you"
    const val CHANNEL_UPDATES = "updates"
    private const val ACCENT = 0xFF4C8DFF.toInt()

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_NEEDS_YOU, context.getString(R.string.channel_needs_you), NotificationManager.IMPORTANCE_HIGH)
                    .apply { description = context.getString(R.string.channel_needs_you_desc) },
                NotificationChannel(CHANNEL_UPDATES, context.getString(R.string.channel_updates), NotificationManager.IMPORTANCE_DEFAULT)
                    .apply { description = context.getString(R.string.channel_updates_desc) },
            ),
        )
    }

    fun canPost(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED &&
            NotificationManagerCompat.from(context).areNotificationsEnabled()

    fun post(context: Context, note: Notify, workstationId: String?) {
        if (!canPost(context)) return
        // Only kalcode-remote links open from a notification; anything else lands on the Fleet.
        val link = note.link.takeIf { DeepLink.parse(it) != null } ?: "kalcode-remote://fleet"
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link), context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra(EXTRA_WORKSTATION, workstationId)
        }
        val pending = PendingIntent.getActivity(
            context, note.id.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val needsYou = note.kind == "needs_you"
        val notification = NotificationCompat.Builder(context, if (needsYou) CHANNEL_NEEDS_YOU else CHANNEL_UPDATES)
            .setSmallIcon(R.drawable.ic_stat_kalcode)
            .setColor(ACCENT)
            .setContentTitle(note.title)
            .setContentText(note.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(note.body))
            .setCategory(if (needsYou) NotificationCompat.CATEGORY_REMINDER else NotificationCompat.CATEGORY_STATUS)
            .setPriority(if (needsYou) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(pending)
            .setGroup("kalcode-remote")
            .build()
        try {
            // One notification per link: a newer event about the same agent replaces the older one.
            NotificationManagerCompat.from(context).notify(link, 1, notification)
        } catch (_: SecurityException) {
        }
    }

    const val EXTRA_WORKSTATION = "kc.wid"
}
