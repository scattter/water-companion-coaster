package com.watercompanion.mobile

import javax.crypto.AEADBadTagException
import javax.crypto.KeyGenerator
import org.junit.Assert.*
import org.junit.Test

class SessionCipherTest {
    @Test fun encryptedSessionsAreBoundToServerAndKey() {
        val generator = KeyGenerator.getInstance("AES").apply { init(256) }
        val key = generator.generateKey()
        val token = "a1".repeat(32)
        val encrypted = SessionCipher.encrypt(token, "https://one.invalid", key)
        assertEquals(token, SessionCipher.decrypt(encrypted, "https://one.invalid", key))
        assertThrows(AEADBadTagException::class.java) { SessionCipher.decrypt(encrypted, "https://two.invalid", key) }
        assertThrows(AEADBadTagException::class.java) { SessionCipher.decrypt(encrypted, "https://one.invalid", generator.generateKey()) }
        encrypted[encrypted.lastIndex] = (encrypted.last().toInt() xor 1).toByte()
        assertThrows(AEADBadTagException::class.java) { SessionCipher.decrypt(encrypted, "https://one.invalid", key) }
    }
}
