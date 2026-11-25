package com.owncord.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SharedUriFilterTest {
  private val own = setOf("com.owncord.client.fileprovider", "com.owncord.client.androidx-startup")

  @Test
  fun acceptsContentFromAnotherAppsProvider() {
    assertTrue(SharedUriFilter.accepts("content", "com.android.providers.media.documents", own))
    assertTrue(SharedUriFilter.accepts("content", "media", own))
  }

  @Test
  fun refusesThisAppsOwnProviders() {
    assertFalse(SharedUriFilter.accepts("content", "com.owncord.client.fileprovider", own))
    assertFalse(SharedUriFilter.accepts("content", "com.owncord.client.androidx-startup", own))
  }

  @Test
  fun refusesThisAppsProviderWrittenForAnotherUserOrInOtherCase() {
    assertFalse(SharedUriFilter.accepts("content", "10@com.owncord.client.fileprovider", own))
    assertFalse(SharedUriFilter.accepts("content", "COM.OwnCord.Client.FileProvider", own))
  }

  @Test
  fun refusesOtherSchemesAndMissingAuthorities() {
    assertFalse(SharedUriFilter.accepts("file", "", own))
    assertFalse(SharedUriFilter.accepts("http", "example.com", own))
    assertFalse(SharedUriFilter.accepts(null, "media", own))
    assertFalse(SharedUriFilter.accepts("content", null, own))
    assertFalse(SharedUriFilter.accepts("content", "", own))
    assertFalse(SharedUriFilter.accepts("content", "10@", own))
  }

  @Test
  fun splitsAProvidersListedAuthorities() {
    assertEquals(listOf("a.one", "b.two"), SharedUriFilter.authoritiesOf(" a.one ;B.two;"))
    assertEquals(emptyList<String>(), SharedUriFilter.authoritiesOf(null))
  }
}
