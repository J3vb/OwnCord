package com.owncord.client

import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// Seals one stored value with AES-GCM. The account name is bound in as
// associated data, so a value moved to another account no longer opens.
// No Android API here, so the rules run in a JVM test.
object SecretSeal {
  private const val TRANSFORMATION = "AES/GCM/NoPadding"
  private const val FORMAT: Byte = 1
  private const val IV_BYTES = 12
  private const val TAG_BITS = 128

  // Same associated data as the Rust fallback file (`fallback_aad`).
  fun associatedData(account: String): ByteArray =
    "com.owncord.client\u0001$account".toByteArray(Charsets.UTF_8)

  fun seal(key: SecretKey, account: String, secret: String): String {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, key)
    cipher.updateAAD(associatedData(account))
    val sealed = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
    val iv = cipher.iv
    check(iv.size == IV_BYTES) { "unexpected nonce size ${iv.size}" }
    return Base64.getEncoder().encodeToString(byteArrayOf(FORMAT) + iv + sealed)
  }

  fun open(key: SecretKey, account: String, stored: String): String {
    val blob = Base64.getDecoder().decode(stored)
    require(blob.size > 1 + IV_BYTES && blob[0] == FORMAT) { "stored value has an unknown format" }
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, blob, 1, IV_BYTES))
    cipher.updateAAD(associatedData(account))
    val plain = cipher.doFinal(blob, 1 + IV_BYTES, blob.size - 1 - IV_BYTES)
    return String(plain, Charsets.UTF_8)
  }
}
