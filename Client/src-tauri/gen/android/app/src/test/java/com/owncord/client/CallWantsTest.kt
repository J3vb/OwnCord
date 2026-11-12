package com.owncord.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CallWantsTest {
  private val wants = CallWants()

  // A call that is joined with its service running, as the tests below start.
  private fun joined(camera: Boolean = false) {
    wants.take(active = true, camera = camera, videoOnScreen = false, running = false)
  }

  @Test
  fun aCallStartsTheServiceAndItsEndStopsIt() {
    val join = wants.take(active = true, camera = false, videoOnScreen = false, running = false)
    assertEquals(CallWants.Service.START, join.service)
    assertFalse(join.screenOn)

    val leave = wants.take(active = false, camera = false, videoOnScreen = false, running = true)
    assertEquals(CallWants.Service.STOP, leave.service)
    assertFalse(wants.active)
  }

  @Test
  fun theCameraGoingOnOrOffStartsTheServiceAgain() {
    joined()
    val on = wants.take(active = true, camera = true, videoOnScreen = false, running = true)
    assertEquals(CallWants.Service.START, on.service)
    assertTrue(wants.camera)

    val off = wants.take(active = true, camera = false, videoOnScreen = false, running = true)
    assertEquals(CallWants.Service.START, off.service)
    assertFalse(wants.camera)
  }

  @Test
  fun aPictureOnScreenChangesTheScreenAndLeavesARunningServiceAlone() {
    joined(camera = true)
    val shown = wants.take(active = true, camera = true, videoOnScreen = true, running = true)
    assertEquals(CallWants.Service.KEEP, shown.service)
    assertTrue(shown.screenOn)

    val gone = wants.take(active = true, camera = true, videoOnScreen = false, running = true)
    assertEquals(CallWants.Service.KEEP, gone.service)
    assertFalse(gone.screenOn)
  }

  @Test
  fun aCallThatEndsWithAPictureStillUpLetsTheScreenSleep() {
    joined()
    wants.take(active = true, camera = false, videoOnScreen = true, running = true)
    val leave = wants.take(active = false, camera = false, videoOnScreen = true, running = true)
    assertEquals(CallWants.Service.STOP, leave.service)
    assertFalse(leave.screenOn)
  }

  @Test
  fun aPictureOutsideACallKeepsNothingOn() {
    val step = wants.take(active = false, camera = false, videoOnScreen = true, running = false)
    assertEquals(CallWants.Service.KEEP, step.service)
    assertFalse(step.screenOn)
  }

  @Test
  fun aStartThatDidNotTakeIsAskedAgainByTheNextUpdate() {
    joined()
    // The first start was refused or waits for the mic permission.
    val next = wants.take(active = true, camera = false, videoOnScreen = true, running = false)
    assertEquals(CallWants.Service.START, next.service)
    assertTrue(next.screenOn)
  }
}
