package fi.lagrange.trader.db

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * AES-256-GCM encrypt/decrypt for trader API credentials.
 * Uses the same WALLET_ENCRYPTION_KEY as WalletService — one key for all secrets at rest.
 * Format: base64(IV[12] || ciphertext+GCM-tag)
 */
class SecretEncryptor(encryptionKeyBase64: String) {

    private val keyBytes: ByteArray = Base64.getDecoder().decode(encryptionKeyBase64).also {
        require(it.size == 32) { "Encryption key must be exactly 32 bytes (base64-encoded)" }
    }

    fun encrypt(plaintext: String): String {
        val iv = ByteArray(12).also { SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, iv))
        val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Base64.getEncoder().encodeToString(iv + encrypted)
    }

    fun decrypt(cipherBase64: String): String {
        val combined = Base64.getDecoder().decode(cipherBase64)
        val iv = combined.copyOfRange(0, 12)
        val ciphertext = combined.copyOfRange(12, combined.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(keyBytes, "AES"), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(ciphertext), Charsets.UTF_8)
    }
}
