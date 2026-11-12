package com.owncord.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import app.tauri.annotation.InvokeArg

@InvokeArg
class ShowRingArgs {
  var channelId: Long = 0
  var title: String = ""
  var text: String = ""
  var acceptLabel: String = ""
  var declineLabel: String = ""
  var channelName: String = ""
  var channelDescription: String = ""
  var quiet: Boolean = false
  var timeoutMs: Long = 35_000
}

@InvokeArg
class ClearRingArgs {
  var channelId: Long = 0
}

// The incoming call's notification: who calls, with Accept and Decline, over
// whatever is on screen and on the lock screen. It rings by itself, through
// its channel: the phone's own ringtone, for as long as it is up, so the ring
// volume, silent mode and Do Not Disturb all apply. A quiet one (the ring
// sound is off in the app's settings) goes on a second channel that makes no
// sound.
//
// Android takes it down by itself after `timeoutMs`: a ring must never
// outlast a webview that is gone.
//
// Shown again (the call was rung again), it must alert again: Android stops
// the ringtone of a ring whose update makes no sound. So it never sets "only
// alert once". Android 13 and newer then let the ringtone play on; older ones
// start it over.
object CallRing {
  private const val NOTIFICATION_ID = 4102
  private const val CHANNEL = "ring"
  private const val QUIET_CHANNEL = "ring-quiet"

  // Where tauri-plugin-notification showed the ring before this did.
  private const val OLD_CHANNEL = "incoming-calls"
  private const val REQUEST_FRONT = 10

  // The channel this ring goes on, made if it is not there yet. Android keeps
  // what the user changed on a channel: making it again only renames it.
  fun channel(context: Context, args: ShowRingArgs): NotificationChannel {
    val manager = manager(context)
    manager.deleteNotificationChannel(OLD_CHANNEL)
    val id = if (args.quiet) QUIET_CHANNEL else CHANNEL
    val made = NotificationChannel(id, args.channelName, NotificationManager.IMPORTANCE_HIGH).apply {
      description = args.channelDescription
      setShowBadge(false)
      if (args.quiet) {
        setSound(null, null)
        enableVibration(false)
      } else {
        setSound(
          RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 1000, 1000)
      }
    }
    manager.createNotificationChannel(made)
    return manager.getNotificationChannel(id) ?: made
  }

  // Whether Android shows it at all: the app's notifications and each
  // channel can be switched off in the system settings.
  fun shows(context: Context, channel: NotificationChannel): Boolean =
    manager(context).areNotificationsEnabled() &&
      channel.importance != NotificationManager.IMPORTANCE_NONE

  fun post(context: Context, args: ShowRingArgs, channel: NotificationChannel, token: String) {
    val accept = intoApp(context, CallActions.ACCEPT, args.channelId, token)
    val decline = CallActionReceiver.press(context, CallActions.DECLINE, args.channelId)
    val builder = Notification.Builder(context, channel.id)
      .setSmallIcon(R.drawable.ic_call_notification)
      .setContentTitle(args.title)
      .setContentText(args.text)
      .setCategory(Notification.CATEGORY_CALL)
      .setOngoing(true)
      .setContentIntent(intoApp(context, CallActions.OPEN, args.channelId, token))
      // Screen off: Android lights it and brings the app up, behind the lock
      // screen if there is one. Screen on: the notification stays on top.
      .setFullScreenIntent(toFront(context), true)
      .setTimeoutAfter(args.timeoutMs)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      // Android's own incoming-call look, with its Answer and Decline.
      val caller = Person.Builder().setName(args.title.ifBlank { "OwnCord" }).setImportant(true).build()
      builder.setStyle(Notification.CallStyle.forIncomingCall(caller, decline, accept))
    } else {
      builder.addAction(CallActionReceiver.button(context, args.declineLabel, decline))
      builder.addAction(CallActionReceiver.button(context, args.acceptLabel, accept))
    }
    val notification = builder.build()
    // Rings until it is answered or taken down, as a phone call does.
    if (!args.quiet) notification.flags = notification.flags or Notification.FLAG_INSISTENT
    manager(context).notify(NOTIFICATION_ID, notification)
  }

  fun cancel(context: Context) {
    manager(context).cancel(NOTIFICATION_ID)
  }

  private fun manager(context: Context): NotificationManager =
    context.getSystemService(NotificationManager::class.java)

  // Accept, and a tap on the ring itself, open the app. Android does not let
  // a receiver do that for a notification, so these two go to the activity,
  // with the ring's token (see CallButtons). Each conversation's ring keeps
  // intents of its own (CallActions.requestCode).
  private fun intoApp(context: Context, action: String, channelId: Long, token: String): PendingIntent {
    val intent = Intent(action)
      .setClass(context, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(CallActions.EXTRA_CHANNEL, channelId)
      .putExtra(CallActions.EXTRA_TOKEN, token)
    return PendingIntent.getActivity(
      context,
      CallActions.requestCode(channelId),
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  private fun toFront(context: Context): PendingIntent {
    val intent = Intent(context, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      context, REQUEST_FRONT, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
  }
}
