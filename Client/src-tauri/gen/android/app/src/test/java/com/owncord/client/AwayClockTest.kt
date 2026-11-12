package com.owncord.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AwayClockTest {
  private val delay = 600_000L

  @Test
  fun theAppInViewIsNotAway() {
    val clock = AwayClock()
    assertEquals(0L, clock.awayMs(5_000L))
    assertNull(clock.follow(delay, 5_000L))
  }

  @Test
  fun awayCountsFromTheMomentTheAppLeftView() {
    val clock = AwayClock()
    clock.hide(1_000L)
    assertEquals(0L, clock.awayMs(1_000L))
    assertEquals(90_000L, clock.awayMs(91_000L))
  }

  @Test
  fun backInViewIsNotAwayAndWantsNoLook() {
    val clock = AwayClock()
    clock.follow(delay, 0L)
    clock.hide(1_000L)
    clock.show()
    assertEquals(0L, clock.awayMs(700_000L))
    assertNull(clock.nextLook(700_000L))
  }

  // Coming back is reported by more than one of the activity's events.
  @Test
  fun comingBackSaysOnceThatTheAppHadBeenAway() {
    val clock = AwayClock()
    assertFalse(clock.show())
    clock.hide(1_000L)
    assertTrue(clock.show())
    assertFalse(clock.show())
  }

  @Test
  fun leavingViewAsksForALookWhenTheDelayIsUp() {
    val clock = AwayClock()
    clock.follow(delay, 0L)
    assertEquals(1_000L + delay, clock.hide(1_000L))
  }

  @Test
  fun aFollowerThatStartsOutOfViewLooksWhenTheDelayIsUp() {
    val clock = AwayClock()
    clock.hide(1_000L)
    assertEquals(1_000L + delay, clock.follow(delay, 200_000L))
  }

  @Test
  fun nobodyFollowingWantsNoLook() {
    val clock = AwayClock()
    assertNull(clock.hide(1_000L))
    clock.follow(delay, 2_000L)
    assertNull(clock.follow(0L, 3_000L))
    assertNull(clock.nextLook(900_000L))
  }

  @Test
  fun afterTheDelayItLooksAgainOneDelayOn() {
    val clock = AwayClock()
    clock.follow(delay, 0L)
    clock.hide(1_000L)
    // The alarm came 40 s late; the page may have had a reason to wait.
    val due = 1_000L + delay + 40_000L
    assertEquals(due + delay, clock.nextLook(due))
    assertEquals(1_000L + 2 * delay, clock.nextLook(1_000L + delay))
  }

  @Test
  fun aSecondStopDoesNotRestartTheCount() {
    val clock = AwayClock()
    clock.follow(delay, 0L)
    clock.hide(1_000L)
    assertEquals(1_000L + delay, clock.hide(50_000L))
    assertEquals(49_000L, clock.awayMs(50_000L))
  }

  @Test
  fun aClockThatSteppedBackReadsAsNotAway() {
    val clock = AwayClock()
    clock.hide(10_000L)
    assertEquals(0L, clock.awayMs(4_000L))
  }

  @Test
  fun theLogLineSaysHowLongInWholeMinutes() {
    assertEquals(
      "[idle] out of view for 12 min: the app checks its status",
      ExitInfo.awayLook(12 * 60_000L + 59_000L),
    )
  }
}
