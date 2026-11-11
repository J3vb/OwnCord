package com.owncord.client

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MeteredMappingTest {
  @Test
  fun notMeteredCapabilityMeansUnmetered() {
    assertFalse(MeteredMapping.metered(true))
  }

  @Test
  fun missingNotMeteredCapabilityMeansMetered() {
    assertTrue(MeteredMapping.metered(false))
  }
}
