package com.kalcode.remote.client

import com.kalcode.remote.protocol.KeyPair
import kotlinx.serialization.Serializable

/** The pinned workstation, saved after a successful pairing. */
@Serializable
data class PairedWorkstation(
    val wid: String,
    val name: String,
    /** Workstation static public key, standard base64 (pinned). */
    val publicKey: String,
    val addrs: List<String>,
    val deviceId: String,
    val hostPlatform: String = "",
    val hostVersion: String = "",
    val hostBuild: Long = 0,
    val pairedAt: Long,
)

/** Where the device key and the pinned workstation live. Android: Keystore-wrapped files. */
interface PairingStore {
    fun loadDeviceKey(): KeyPair?
    fun saveDeviceKey(key: KeyPair)
    fun loadWorkstation(): PairedWorkstation?
    fun saveWorkstation(workstation: PairedWorkstation)

    /** Forgets the workstation and destroys the device key (unpair / removed). */
    fun wipe()
}

class InMemoryPairingStore : PairingStore {
    @Volatile private var key: KeyPair? = null
    @Volatile private var workstation: PairedWorkstation? = null
    override fun loadDeviceKey() = key
    override fun saveDeviceKey(key: KeyPair) { this.key = key }
    override fun loadWorkstation() = workstation
    override fun saveWorkstation(workstation: PairedWorkstation) { this.workstation = workstation }
    override fun wipe() {
        key?.wipe()
        key = null
        workstation = null
    }
}

/** Identifies this device in the handshake payload. */
data class DeviceInfo(val name: String, val model: String, val appVersion: String)
