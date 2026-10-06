package com.kalcode.remote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Keeps the workstation link alive for a short while after the person leaves the app, so
 * approvals and failures still arrive as notifications (protocol §6: "foreground or recently
 * backgrounded"). Android 15 cuts network access for background processes within seconds;
 * a `connectedDevice` foreground service is the platform's way to hold a live link to an
 * external device. It never outlives [LINGER_MILLIS] in the background and stops on unpair.
 *
 * The connection itself belongs to [com.kalcode.remote.client.RemoteClient]; this service only
 * keeps the process eligible for network.
 */
class LinkService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val stopLater = Runnable { stopSelf() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DISCONNECT -> {
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_BACKGROUND -> handler.postDelayed(stopLater, LINGER_MILLIS)
            else -> handler.removeCallbacks(stopLater)
        }
        val name = (application as KalCodeRemoteApp).client.workstation.value?.name ?: "your workstation"
        try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(name), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } catch (_: Exception) {
            // Not allowed right now (started from the background): nothing to keep alive.
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(stopLater)
        super.onDestroy()
    }

    private fun notification(name: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val disconnect = PendingIntent.getService(
            this, 1, Intent(this, LinkService::class.java).setAction(ACTION_DISCONNECT), PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_kalcode)
            .setColor(0xFF4C8DFF.toInt())
            .setContentTitle("Connected to $name")
            .setContentText("Approvals and failures reach you for a few minutes after you leave.")
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .setContentIntent(open)
            .addAction(0, "Disconnect", disconnect)
            .build()
    }

    companion object {
        const val CHANNEL = "link"
        private const val NOTIFICATION_ID = 7
        private const val ACTION_BACKGROUND = "com.kalcode.remote.link.BACKGROUND"
        private const val ACTION_DISCONNECT = "com.kalcode.remote.link.DISCONNECT"
        const val LINGER_MILLIS = 10 * 60_000L

        fun createChannel(context: Context) {
            context.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, context.getString(R.string.channel_link), NotificationManager.IMPORTANCE_MIN)
                    .apply { description = context.getString(R.string.channel_link_desc) },
            )
        }

        /** The app came to the front while paired: hold the link (and cancel any pending stop). */
        fun onForeground(context: Context) {
            runCatching { context.startForegroundService(Intent(context, LinkService::class.java)) }
        }

        /** The app left the front: keep the link for [LINGER_MILLIS], then let go. */
        fun onBackground(context: Context) {
            runCatching { context.startService(Intent(context, LinkService::class.java).setAction(ACTION_BACKGROUND)) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LinkService::class.java))
        }
    }
}
