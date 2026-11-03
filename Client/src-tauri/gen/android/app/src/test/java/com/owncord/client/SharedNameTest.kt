package com.owncord.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedNameTest {
  @Test
  fun keepsAPlainName() {
    assertEquals("IMG_1234.jpg", SharedName.of("IMG_1234.jpg", "jpg", 0))
  }

  @Test
  fun addsTheTypeExtensionWhenTheNameHasNone() {
    assertEquals("1000012345.jpg", SharedName.of("1000012345", "jpg", 0))
    assertEquals("1000012345", SharedName.of("1000012345", null, 0))
  }

  @Test
  fun dropsPathsReservedCharactersAndLeadingDots() {
    assertEquals("secret.txt", SharedName.of("../../.secret.txt", "txt", 0))
    assertEquals("ab.png", SharedName.of("a<b>?.png", "png", 0))
  }

  @Test
  fun anEmptyNameGetsANumberedFallback() {
    assertEquals("shared.png", SharedName.of(null, "png", 0))
    assertEquals("shared-3", SharedName.of("  ", null, 2))
  }

  @Test
  fun aLongNameKeepsItsExtension() {
    val name = SharedName.of("x".repeat(300) + ".mp4", "mp4", 0)
    assertEquals(SharedName.MAX_NAME_BYTES, SharedName.utf8Bytes(name))
    assertTrue(name.endsWith(".mp4"))
  }

  @Test
  fun aLongWideNameFitsTheFileSystemWithoutSplittingACharacter() {
    val name = SharedName.of("写真".repeat(100) + "😀".repeat(20) + ".jpg", "jpg", 0)
    assertTrue(SharedName.utf8Bytes(name) <= SharedName.MAX_NAME_BYTES)
    assertTrue(name.endsWith(".jpg"))
    assertFalse(name.contains('\uFFFD'))
    val emoji = SharedName.of("😀".repeat(80), null, 0)
    assertTrue(SharedName.utf8Bytes(emoji) <= SharedName.MAX_NAME_BYTES)
    assertEquals(0, emoji.codePointCount(0, emoji.length) * 2 - emoji.length)
  }

  @Test
  fun textFallsBackToTheSubject() {
    assertEquals("https://example.com", SharedName.text(" https://example.com ", "Title"))
    assertEquals("Title", SharedName.text(null, "Title"))
    assertEquals("", SharedName.text("", null))
  }
}
