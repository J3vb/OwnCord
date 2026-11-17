package com.owncord.client

import javax.crypto.AEADBadTagException
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SecretSealTest {
  private fun key(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

  @Test
  fun sealedValueOpensForItsOwnAccount() {
    val key = key()
    val stored = SecretSeal.seal(key, "login:chat.example", "{\"token\":\"t\"}")
    assertEquals("{\"token\":\"t\"}", SecretSeal.open(key, "login:chat.example", stored))
  }

  @Test
  fun valueMovedToAnotherAccountIsRefused() {
    val key = key()
    val stored = SecretSeal.seal(key, "identity:a.example", "secret")
    assertThrows(AEADBadTagException::class.java) {
      SecretSeal.open(key, "identity:b.example", stored)
    }
  }

  @Test
  fun valueSealedUnderAnotherKeyIsRefused() {
    val stored = SecretSeal.seal(key(), "login:a.example", "secret")
    assertThrows(AEADBadTagException::class.java) {
      SecretSeal.open(key(), "login:a.example", stored)
    }
  }

  @Test
  fun eachSealUsesAFreshNonce() {
    val key = key()
    assertNotEquals(SecretSeal.seal(key, "a", "same"), SecretSeal.seal(key, "a", "same"))
  }

  @Test
  fun unknownFormatIsRefused() {
    assertThrows(IllegalArgumentException::class.java) {
      SecretSeal.open(key(), "a", "AAAA")
    }
  }
}
