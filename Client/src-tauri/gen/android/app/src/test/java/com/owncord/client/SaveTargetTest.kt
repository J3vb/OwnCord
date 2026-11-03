package com.owncord.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SaveTargetTest {
  @Test
  fun picturesGoToTheOwnCordAlbum() {
    assertEquals("Pictures/OwnCord", SaveTarget.relativePath("pictures"))
    assertTrue(SaveTarget.isPictures("pictures"))
  }

  @Test
  fun everythingElseGoesToDownloads() {
    for (folder in listOf("downloads", "", "Pictures", "unknown")) {
      assertEquals("Download", SaveTarget.relativePath(folder))
      assertFalse(SaveTarget.isPictures(folder))
    }
  }
}
