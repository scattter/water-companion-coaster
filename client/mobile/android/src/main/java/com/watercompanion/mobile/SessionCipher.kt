package com.watercompanion.mobile

import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object SessionCipher {
    fun encrypt(value: String, origin: String, key: SecretKey): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        cipher.updateAAD(origin.toByteArray(Charsets.UTF_8))
        return cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    }

    fun decrypt(bytes: ByteArray, origin: String, key: SecretKey): String {
        require(bytes.size > 28)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        cipher.updateAAD(origin.toByteArray(Charsets.UTF_8))
        return String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8)
    }
}
