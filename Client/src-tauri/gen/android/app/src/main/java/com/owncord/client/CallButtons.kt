package com.owncord.client

// The names the call notifications' buttons go by on their intents.
object CallActions {
  const val MUTE = "com.owncord.client.call.MUTE"
  const val UNMUTE = "com.owncord.client.call.UNMUTE"
  const val LEAVE = "com.owncord.client.call.LEAVE"
  const val ACCEPT = "com.owncord.client.call.ACCEPT"
  const val DECLINE = "com.owncord.client.call.DECLINE"
  const val OPEN = "com.owncord.client.call.OPEN"
  const val EXTRA_CHANNEL = "channel"
  const val EXTRA_TOKEN = "token"
  // The push registration a ring from push came in for: which server and account.
  const val EXTRA_INSTANCE = "instance"

  private val ALL = setOf(MUTE, UNMUTE, LEAVE, ACCEPT, DECLINE, OPEN)

  // Whether an intent's action is one of the buttons at all.
  fun names(action: String?): Boolean = action in ALL

  // The request code of a button's pending intent. Android keeps one pending
  // intent per action and request code, and writing it again changes what the
  // one already on screen sends. So the buttons of one conversation's ring
  // have their own, and a ring that takes another's place leaves the buttons
  // of the notification it replaces as they were. Buttons that name no
  // conversation (Mute, Unmute, Leave) share one.
  fun requestCode(channelId: Long?): Int = channelId?.hashCode() ?: 0
}

// A button pressed on one of the call notifications, as the webview hears it.
class CallEvent(val kind: String, val channelId: Long?) {
  companion object {
    const val MUTE = "mute"
    const val UNMUTE = "unmute"
    const val LEAVE = "leave"
    const val ACCEPT = "accept"
    const val DECLINE = "decline"
    const val OPEN = "open"
  }
}

// What the "in a call" notification says and offers, in the webview's words.
data class CallFace(
  val mic: String,
  val text: String,
  val micLabel: String?,
  val leaveLabel: String,
) {
  // The microphone's button: Mute while it is open, Unmute while the member
  // muted it, and none while a moderator did, which is not theirs to lift.
  fun micAction(): String? = when {
    micLabel.isNullOrEmpty() -> null
    mic == LIVE -> CallActions.MUTE
    mic == MUTED -> CallActions.UNMUTE
    else -> null
  }

  companion object {
    const val LIVE = "live"
    const val MUTED = "muted"

    // Before the webview said anything: the plain notification, no buttons.
    val PLAIN = CallFace(LIVE, "", null, "")
  }
}

// Which incoming call the ring notification is up for, and what an intent
// from a call notification means. Apart from Android so the rules run in a
// JVM test.
//
// Mute, Unmute, Leave and Decline come in through a receiver only this app
// can reach. Accept and a tap on the ring open the app, so they come in
// through the activity, which other apps can start too: those two count only
// with the token of the ring last shown.
//
// One per process (CallRingState): the page's rings and the rings a push
// shows with no page running share it. Synchronized, since a push may arrive
// off the main thread.
class CallButtons(private val newToken: () -> String) {
  private var ringing: Long? = null
  private var lastRing: Long? = null
  private var token: String? = null
  // The activity-borne presses already taken since the ring was last shown:
  // each counts once, so an activity rebuilt on the intent that started it
  // acts on nothing.
  private val taken = HashSet<String>()

  // A ring goes up: the token its buttons carry. One that is up already (the
  // call was rung again) keeps its token, so a press that is on its way while
  // it is shown again still counts.
  @Synchronized
  fun ringUp(channelId: Long): String {
    val kept = token
    if (ringing == channelId && kept != null) {
      // Shown again: a tap on it opens the conversation again.
      taken.clear()
      return kept
    }
    val next = newToken()
    ringing = channelId
    lastRing = channelId
    token = next
    taken.clear()
    return next
  }

  // The ring for this channel comes down. False when it is not the one up:
  // a ring for another channel stays.
  @Synchronized
  fun ringDown(channelId: Long): Boolean {
    if (ringing != channelId) return false
    ringing = null
    return true
  }

  // Whether the ring up is this channel's.
  @Synchronized
  fun isUp(channelId: Long): Boolean = ringing == channelId

  // Null for an intent that is not a call button, or not one of ours. A ring
  // that is over still passes its Accept on: the webview then opens the
  // conversation and joins nothing.
  @Synchronized
  fun read(action: String?, channelId: Long?, token: String?, throughActivity: Boolean): CallEvent? =
    when (action) {
      CallActions.MUTE -> inCall(CallEvent.MUTE, throughActivity)
      CallActions.UNMUTE -> inCall(CallEvent.UNMUTE, throughActivity)
      CallActions.LEAVE -> inCall(CallEvent.LEAVE, throughActivity)
      CallActions.DECLINE ->
        if (throughActivity || channelId == null) null else CallEvent(CallEvent.DECLINE, channelId)
      CallActions.ACCEPT -> ofLastRing(CallEvent.ACCEPT, channelId, token, throughActivity)
      CallActions.OPEN -> ofLastRing(CallEvent.OPEN, channelId, token, throughActivity)
      else -> null
    }

  private fun inCall(kind: String, throughActivity: Boolean): CallEvent? =
    if (throughActivity) null else CallEvent(kind, null)

  private fun ofLastRing(
    kind: String,
    channelId: Long?,
    token: String?,
    throughActivity: Boolean,
  ): CallEvent? {
    if (!throughActivity || channelId == null || token == null) return null
    if (token != this.token || channelId != lastRing) return null
    if (!taken.add(kind)) return null
    return CallEvent(kind, channelId)
  }
}
