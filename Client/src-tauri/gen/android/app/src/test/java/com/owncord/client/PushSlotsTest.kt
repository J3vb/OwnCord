package com.owncord.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PushSlotsTest {
  @Test
  fun aServerKeepsItsIdSoItsNextPushReplacesTheLast() {
    val taken = mapOf("a.example:8443" to 4203)
    assertEquals(4203, PushSlots.idFor("a.example:8443", taken))
  }

  @Test
  fun aNewServerTakesTheLowestFreeId() {
    val taken = mapOf("a" to PushSlots.FIRST_ID, "b" to PushSlots.FIRST_ID + 2)
    assertEquals(PushSlots.FIRST_ID + 1, PushSlots.idFor("c", taken))
  }

  @Test
  fun noIdIsLeftOnceEveryOneIsTaken() {
    val taken = (0 until PushSlots.COUNT).associate { "s$it" to PushSlots.FIRST_ID + it }
    assertNull(PushSlots.idFor("new", taken))
  }

  @Test
  fun idsStayClearOfTheCallNotifications() {
    val ids = PushSlots.FIRST_ID until PushSlots.FIRST_ID + PushSlots.COUNT
    assert(4101 !in ids && 4102 !in ids)
  }

  @Test
  fun readsTheKindOfAPush() {
    assertEquals(PushPayload.ACTIVITY, PushPayload.kindOf("""{"t":"activity"}"""))
    assertEquals(PushPayload.ACTIVITY, PushPayload.kindOf("""{ "t" : "activity" }"""))
    assertNull(PushPayload.kindOf("""{"x":"activity"}"""))
    assertNull(PushPayload.kindOf("not json"))
  }

  @Test
  fun readsTheDmARingIsFor() {
    assertEquals(PushPayload.RING, PushPayload.kindOf("""{"t":"ring","c":42}"""))
    assertEquals(42L, PushPayload.channelOf("""{"t":"ring","c":42}"""))
    assertEquals(7L, PushPayload.channelOf("""{"t":"ring_end", "c" : 7}"""))
    assertNull(PushPayload.channelOf("""{"t":"ring"}"""))
    assertNull(PushPayload.channelOf("""{"t":"ring","c":0}"""))
    assertNull(PushPayload.channelOf("""{"t":"ring","c":1234567890123456789}"""))
  }

  @Test
  fun aRingShowsOnlyWhileTheAppIsAwayAndNothingRingsYet() {
    val ring = PushPayload.RING
    assertEquals(PushRingRule.Step.RING, PushRingRule.step(ring, 5, onScreen = false, alreadyUp = false))
    assertEquals(PushRingRule.Step.NONE, PushRingRule.step(ring, 5, onScreen = true, alreadyUp = false))
    assertEquals(PushRingRule.Step.NONE, PushRingRule.step(ring, 5, onScreen = false, alreadyUp = true))
    assertEquals(PushRingRule.Step.NONE, PushRingRule.step(ring, null, onScreen = false, alreadyUp = false))
  }

  @Test
  fun theEndOfARingAlwaysTakesItDown() {
    val end = PushPayload.RING_END
    assertEquals(PushRingRule.Step.END, PushRingRule.step(end, 5, onScreen = true, alreadyUp = true))
    assertEquals(PushRingRule.Step.END, PushRingRule.step(end, 5, onScreen = false, alreadyUp = false))
    assertEquals(PushRingRule.Step.NONE, PushRingRule.step(end, null, onScreen = false, alreadyUp = true))
    assertEquals(PushRingRule.Step.NONE, PushRingRule.step(PushPayload.ACTIVITY, 5, onScreen = false, alreadyUp = false))
  }
}
