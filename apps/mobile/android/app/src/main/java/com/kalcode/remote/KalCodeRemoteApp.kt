package com.kalcode.remote

import android.app.Application
import android.os.Build
import android.provider.Settings
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import com.kalcode.remote.client.DeviceInfo
import com.kalcode.remote.client.KeystorePairingStore
import com.kalcode.remote.client.RemoteClient
import com.kalcode.remote.protocol.DeepLink
import com.kalcode.remote.protocol.Notify
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/** Process-wide objects: the one [RemoteClient], pending deep links and in-app notices. */
class KalCodeRemoteApp : Application() {
    lateinit var client: RemoteClient
        private set

    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    /** The deep link the UI should open next (notification tap, intent, QR). */
    val pendingLink = MutableStateFlow<DeepLink?>(null)

    private val _inAppNotices = MutableSharedFlow<Notify>(extraBufferCapacity = 8)
    /** `notify` events while the app is in front: shown as an in-app banner, not a system one. */
    val inAppNotices: SharedFlow<Notify> = _inAppNotices

    private val _foreground = MutableStateFlow(false)
    val foreground: StateFlow<Boolean> = _foreground

    override fun onCreate() {
        super.onCreate()
        instance = this
        client = RemoteClient(KeystorePairingStore(this), deviceInfo())
        Notifications.createChannels(this)
        LinkService.createChannel(this)
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                _foreground.value = true
                client.onForeground()
                if (client.workstation.value != null) LinkService.onForeground(this@KalCodeRemoteApp)
            }

            override fun onStop(owner: LifecycleOwner) {
                _foreground.value = false
                if (client.workstation.value != null) LinkService.onBackground(this@KalCodeRemoteApp)
            }
        })
        appScope.launch {
            client.notifications.collect { note ->
                if (_foreground.value) {
                    _inAppNotices.tryEmit(note)
                } else {
                    Notifications.post(this@KalCodeRemoteApp, note, client.workstation.value?.wid)
                }
            }
        }
        // Pairing starts the link; unpair / removed ends it.
        appScope.launch {
            client.workstation.collect { ws ->
                if (ws == null) LinkService.stop(this@KalCodeRemoteApp)
                else if (_foreground.value) LinkService.onForeground(this@KalCodeRemoteApp)
            }
        }
        client.start()
    }

    private fun deviceInfo(): DeviceInfo {
        val name = runCatching { Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME) }.getOrNull()
            ?.takeIf { it.isNotBlank() } ?: Build.MODEL
        val pkg = packageManager.getPackageInfo(packageName, 0)
        return DeviceInfo(
            name = name,
            model = "${Build.MANUFACTURER} ${Build.MODEL}".trim(),
            appVersion = "${pkg.versionName} (${pkg.longVersionCode})",
        )
    }

    companion object {
        lateinit var instance: KalCodeRemoteApp
            private set
    }
}
