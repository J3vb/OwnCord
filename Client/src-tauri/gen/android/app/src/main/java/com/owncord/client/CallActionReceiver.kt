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
    // The process came up for this press alone, so there is no webview to
    // tell. A ring the process before it left on screen goes at least.
    if (intent.action == CallActions.DECLINE) CallRing.cancel(context)
  }

  companion object {
    // CallServicePlugin, once it is loaded: it tells the webview.
    var sink: ((Intent) -> Unit)? = null

    // What a button sends here when it is pressed. The action tells the
    // buttons apart, and the request code the conversations, so each keeps an
    // intent of its own.
    fun press(context: Context, action: String, channelId: Long? = null): PendingIntent {
      val intent = Intent(action).setClass(context, CallActionReceiver::class.java)
      if (channelId != null) intent.putExtra(CallActions.EXTRA_CHANNEL, channelId)
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
