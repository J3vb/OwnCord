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
}
