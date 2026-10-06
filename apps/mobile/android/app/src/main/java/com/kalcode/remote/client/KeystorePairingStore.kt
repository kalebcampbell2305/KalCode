package com.kalcode.remote.client

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.kalcode.remote.protocol.KeyPair
import com.kalcode.remote.protocol.WireJson
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Device static private key and pinned workstation, each encrypted with a non-exportable
 * AES-256-GCM key held by the Android Keystore, in app-private no-backup storage. The raw
 * X25519 key never touches disk in the clear and is excluded from backups.
 */
class KeystorePairingStore(context: Context) : PairingStore {
    private val dir = File(context.noBackupFilesDir, "remote").apply { mkdirs() }
    private val keyFile = File(dir, "device-key.bin")
    private val workstationFile = File(dir, "workstation.bin")

    private fun wrappingKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun seal(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        val iv = cipher.iv
        val sealed = cipher.doFinal(plain)
        return byteArrayOf(iv.size.toByte()) + iv + sealed
    }

    private fun open(blob: ByteArray): ByteArray {
        val ivLen = blob[0].toInt()
        val iv = blob.copyOfRange(1, 1 + ivLen)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, iv))
        return cipher.doFinal(blob, 1 + ivLen, blob.size - 1 - ivLen)
    }

    private fun write(file: File, plain: ByteArray) {
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeBytes(seal(plain))
        if (!tmp.renameTo(file)) {
            file.delete()
            tmp.renameTo(file)
        }
    }

    @Synchronized
    override fun loadDeviceKey(): KeyPair? = runCatching {
        if (!keyFile.exists()) return null
        val raw = open(keyFile.readBytes())
        KeyPair.fromPrivate(raw).also { raw.fill(0) }
    }.getOrNull()

    @Synchronized
    override fun saveDeviceKey(key: KeyPair) = write(keyFile, key.private)

    @Synchronized
    override fun loadWorkstation(): PairedWorkstation? = runCatching {
        if (!workstationFile.exists()) return null
        WireJson.decodeFromString(PairedWorkstation.serializer(), String(open(workstationFile.readBytes()), Charsets.UTF_8))
    }.getOrNull()

    @Synchronized
    override fun saveWorkstation(workstation: PairedWorkstation) =
        write(workstationFile, WireJson.encodeToString(PairedWorkstation.serializer(), workstation).toByteArray())

    @Synchronized
    override fun wipe() {
        keyFile.delete()
        workstationFile.delete()
        // A new wrapping key too: nothing sealed before the wipe can be opened again.
        runCatching { KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }.deleteEntry(ALIAS) }
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "kalcode-remote-wrap"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
