package com.owncord.client

import android.app.Notification
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon

// Mute, Unmute, Leave and Decline: the call notifications' buttons that act
// without opening the app. Not exported, so only this app's own notifications
// reach it.
class CallActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val heard = sink
    if (heard != null) {
      heard(intent)
      return
    }
    // No webview to tell: the process came up for this press alone, or a push
    // showed the ring with no page running. The ring goes at least; the caller
    // is not told, and rings until their call times out.
    if (intent.action != CallActions.DECLINE) return
    if (intent.hasExtra(CallActions.EXTRA_CHANNEL)) {
      CallRingState.buttons.ringDown(intent.getLongExtra(CallActions.EXTRA_CHANNEL, 0))
    }
    CallRing.cancel(context)
  }

  companion object {
    // CallServicePlugin, once it is loaded: it tells the webview.
    var sink: ((Intent) -> Unit)? = null

    // What a button sends here when it is pressed. The action tells the
    // buttons apart, and the request code the conversations, so each keeps an
    // intent of its own.
    fun press(
      context: Context,
      action: String,
      channelId: Long? = null,
      instance: String? = null,
    ): PendingIntent {
      val intent = Intent(action).setClass(context, CallActionReceiver::class.java)
      if (channelId != null) intent.putExtra(CallActions.EXTRA_CHANNEL, channelId)
      if (instance != null) intent.putExtra(CallActions.EXTRA_INSTANCE, instance)
      return PendingIntent.getBroadcast(
        context,
        CallActions.requestCode(channelId),
        intent,
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
      )
    }

    fun button(context: Context, label: String, press: PendingIntent): Notification.Action =
      Notification.Action.Builder(
        Icon.createWithResource(context, R.drawable.ic_call_notification), label, press
      ).build()
  }
}
