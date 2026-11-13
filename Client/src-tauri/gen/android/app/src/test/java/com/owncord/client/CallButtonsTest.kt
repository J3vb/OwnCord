package com.owncord.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallButtonsTest {
  private var made = 0
  private val buttons = CallButtons { "token-${++made}" }

  // An intent from the receiver only this app can reach.
  private fun received(action: String?, channelId: Long? = null): CallEvent? =
    buttons.read(action, channelId, null, throughActivity = false)

  // An intent that opened the app, which any app can send.
  private fun opened(action: String?, channelId: Long?, token: String?): CallEvent? =
    buttons.read(action, channelId, token, throughActivity = true)

  @Test
  fun theCallsOwnButtonsReachTheWebviewByName() {
    assertEquals(CallEvent.MUTE, received(CallActions.MUTE)?.kind)
    assertEquals(CallEvent.UNMUTE, received(CallActions.UNMUTE)?.kind)
    val leave = received(CallActions.LEAVE)
    assertEquals(CallEvent.LEAVE, leave?.kind)
    assertNull(leave?.channelId)
  }

  @Test
  fun aButtonSentThroughTheActivityIsNotHeard() {
    assertNull(opened(CallActions.MUTE, null, null))
    assertNull(opened(CallActions.UNMUTE, null, null))
    assertNull(opened(CallActions.LEAVE, null, null))
    assertNull(opened(CallActions.DECLINE, 7, null))
  }

  @Test
  fun declineNamesTheCallItDeclines() {
    val decline = received(CallActions.DECLINE, 7)
    assertEquals(CallEvent.DECLINE, decline?.kind)
    assertEquals(7L, decline?.channelId)
    assertNull(received(CallActions.DECLINE))
  }

  @Test
  fun acceptAndATapCountOnlyWithTheTokenOfTheRingShown() {
    val token = buttons.ringUp(7)
    val accept = opened(CallActions.ACCEPT, 7, token)
    assertEquals(CallEvent.ACCEPT, accept?.kind)
    assertEquals(7L, accept?.channelId)
    assertEquals(CallEvent.OPEN, opened(CallActions.OPEN, 7, token)?.kind)

    assertNull(opened(CallActions.ACCEPT, 7, "guess"))
    assertNull(opened(CallActions.ACCEPT, 7, null))
    assertNull(opened(CallActions.ACCEPT, 8, token))
    assertNull(opened(CallActions.ACCEPT, null, token))
    assertNull(buttons.read(CallActions.ACCEPT, 7, token, throughActivity = false))
  }

  @Test
  fun noRingShownMeansNoTokenFits() {
    assertNull(opened(CallActions.ACCEPT, 7, "token-1"))
    assertNull(opened(CallActions.OPEN, 7, null))
  }

  @Test
  fun aRingThatIsOverStillPassesItsAcceptOn() {
    val token = buttons.ringUp(7)
    assertTrue(buttons.ringDown(7))
    // The webview opens the conversation for it and joins nothing.
    assertEquals(CallEvent.ACCEPT, opened(CallActions.ACCEPT, 7, token)?.kind)
  }

  @Test
  fun aNewerRingTakesTheTokenOver() {
    val first = buttons.ringUp(7)
    val second = buttons.ringUp(9)
    assertNull(opened(CallActions.ACCEPT, 7, first))
    assertEquals(9L, opened(CallActions.ACCEPT, 9, second)?.channelId)
  }

  @Test
  fun aRingShownAgainKeepsItsToken() {
    val first = buttons.ringUp(7)
    // Rung again while it is up: a press already on its way still counts.
    assertEquals(first, buttons.ringUp(7))
    assertEquals(CallEvent.ACCEPT, opened(CallActions.ACCEPT, 7, first)?.kind)

    // The same conversation calls again after that ring came down: a new ring.
    assertTrue(buttons.ringDown(7))
    val later = buttons.ringUp(7)
    assertNotEquals(first, later)
    assertNull(opened(CallActions.ACCEPT, 7, first))
    assertEquals(CallEvent.ACCEPT, opened(CallActions.ACCEPT, 7, later)?.kind)
  }

  @Test
  fun eachConversationsRingKeepsButtonsOfItsOwn() {
    assertNotEquals(CallActions.requestCode(7), CallActions.requestCode(9))
    assertEquals(CallActions.requestCode(7), CallActions.requestCode(7))
    // The call's own buttons name no conversation and share one.
    assertEquals(0, CallActions.requestCode(null))
  }

  @Test
  fun onlyTheRingThatIsUpComesDown() {
    buttons.ringUp(7)
    assertFalse(buttons.ringDown(9))
    assertTrue(buttons.ringDown(7))
    assertFalse(buttons.ringDown(7))
  }

  @Test
  fun anIntentThatIsNotACallButtonIsNothing() {
    assertNull(received(null))
    assertNull(received("android.intent.action.MAIN"))
    assertNull(opened("android.intent.action.SEND", 7, "token-1"))
    assertFalse(CallActions.names(null))
    assertFalse(CallActions.names("android.intent.action.MAIN"))
    for (action in listOf(
      CallActions.MUTE, CallActions.UNMUTE, CallActions.LEAVE,
      CallActions.ACCEPT, CallActions.DECLINE, CallActions.OPEN,
    )) {
      assertTrue(CallActions.names(action))
    }
  }

  @Test
  fun theMicrophoneButtonFollowsWhoMutedIt() {
    assertEquals(CallActions.MUTE, CallFace(CallFace.LIVE, "In a call", "Mute", "Leave").micAction())
    assertEquals(CallActions.UNMUTE, CallFace(CallFace.MUTED, "Muted", "Unmute", "Leave").micAction())
    // Muted by a moderator: not the member's to lift, so no button.
    assertNull(CallFace("locked", "Muted by a moderator", "Unmute", "Leave").micAction())
    assertNull(CallFace(CallFace.LIVE, "In a call", null, "Leave").micAction())
    assertNull(CallFace.PLAIN.micAction())
  }

  @Test
  fun saysWhichRingIsUp() {
    assertFalse(buttons.isUp(5))
    buttons.ringUp(5)
    assertTrue(buttons.isUp(5))
    assertFalse(buttons.isUp(6))
    buttons.ringDown(5)
    assertFalse(buttons.isUp(5))
  }

  @Test
  fun aPressThroughTheActivityCountsOnce() {
    val token = buttons.ringUp(50)
    assertEquals(CallEvent.OPEN, opened(CallActions.OPEN, 50, token)?.kind)
    assertEquals(CallEvent.ACCEPT, opened(CallActions.ACCEPT, 50, token)?.kind)
    // The activity rebuilt on the intent that started it: nothing again.
    assertNull(opened(CallActions.ACCEPT, 50, token))
    assertNull(opened(CallActions.OPEN, 50, token))
    buttons.ringDown(50)
    val next = buttons.ringUp(50)
    assertEquals(CallEvent.ACCEPT, opened(CallActions.ACCEPT, 50, next)?.kind)
  }
}
