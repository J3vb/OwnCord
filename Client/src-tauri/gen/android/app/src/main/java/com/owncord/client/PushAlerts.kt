package com.owncord.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner

// What the app keeps per server it registered for push: the notification's
// text (the page hands it over in its own language) and its id. Kept in a
// private preferences file, since a push can arrive with no page running.
object PushStore {
  private const val FILE = "owncord_push"
  private const val TITLE = "title:"
  private const val BODY = "body:"
  private const val ID = "id:"

  private fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  fun save(context: Context, instance: String, title: String, body: String) {
    val prefs = prefs(context)
    val id = PushSlots.idFor(instance, ids(prefs)) ?: return
    prefs.edit()
      .putString(TITLE + instance, title)
      .putString(BODY + instance, body)
      .putInt(ID + instance, id)
      .apply()
  }

  fun forget(context: Context, instance: String) {
    prefs(context).edit().remove(TITLE + instance).remove(BODY + instance).remove(ID + instance).apply()
  }

  fun title(context: Context, instance: String): String? = prefs(context).getString(TITLE + instance, null)

  fun body(context: Context, instance: String): String? = prefs(context).getString(BODY + instance, null)

  fun id(context: Context, instance: String): Int? = ids(prefs(context))[instance]

  fun allIds(context: Context): Collection<Int> = ids(prefs(context)).values

  private fun ids(prefs: SharedPreferences): Map<String, Int> =
    prefs.all.entries
      .filter { it.key.startsWith(ID) && it.value is Int }
      .associate { it.key.removePrefix(ID) to it.value as Int }
}

// The "new messages" notification a push shows while the app is closed or in
// the background: one per server, replaced by the next rather than stacked,
// and a tap opens the app on that server. While the app is on screen the page
// shows messages itself, so a push then shows nothing.
object PushAlerts {
  // The channel the page's own message notifications use
  // (android_notifications.rs), so one switch in Android's settings covers both.
  private const val CHANNEL = "messages"
  const val EXTRA_INSTANCE = "com.owncord.client.PUSH_INSTANCE"
  const val ACTION_OPEN = "com.owncord.client.PUSH_OPEN"

  fun onMessage(context: Context, instance: String, content: String) {
    if (PushPayload.kindOf(content) != PushPayload.ACTIVITY) return
    if (appOnScreen()) return
    val id = PushStore.id(context, instance) ?: return
    val title = PushStore.title(context, instance) ?: return
    val body = PushStore.body(context, instance).orEmpty()
    val manager = context.getSystemService(NotificationManager::class.java)
    ensureChannel(manager, title)
    val notification = Notification.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.ic_message_notification)
      .setContentTitle(title)
      .setContentText(body)
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setGroup("owncord:$instance")
      .setVisibility(Notification.VISIBILITY_PRIVATE)
      .setAutoCancel(true)
      .setContentIntent(open(context, instance, id))
      .build()
    manager.notify(id, notification)
  }

  // Take every push notification down: the app is open and shows the rest.
  fun clearAll(context: Context) {
    val manager = context.getSystemService(NotificationManager::class.java)
    PushStore.allIds(context).forEach { manager.cancel(it) }
  }

  fun clear(context: Context, instance: String) {
    val id = PushStore.id(context, instance) ?: return
    context.getSystemService(NotificationManager::class.java).cancel(id)
  }

  private fun appOnScreen(): Boolean =
    ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

  // Made only when the page has not made it yet; the page names it later in
  // the app's language. Android keeps what the user changed on a channel.
  private fun ensureChannel(manager: NotificationManager, fallbackName: String) {
    if (manager.getNotificationChannel(CHANNEL) != null) return
    val channel = NotificationChannel(CHANNEL, fallbackName, NotificationManager.IMPORTANCE_HIGH).apply {
      lockscreenVisibility = Notification.VISIBILITY_PRIVATE
      enableVibration(true)
    }
    manager.createNotificationChannel(channel)
  }

  private fun open(context: Context, instance: String, id: Int): PendingIntent {
    val intent = Intent(ACTION_OPEN)
      .setClass(context, MainActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      .putExtra(EXTRA_INSTANCE, instance)
    return PendingIntent.getActivity(
      context, id, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }
}
