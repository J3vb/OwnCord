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
import org.json.JSONObject

// What the app keeps per server it registered for push: the notification's
// text (the page hands it over in its own language) and its id. Kept in a
// private preferences file, since a push can arrive with no page running.
object PushStore {
  private const val FILE = "owncord_push"
  private const val TITLE = "title:"
  private const val BODY = "body:"
  private const val ID = "id:"
  private const val RING = "ring:"

  private fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  // False when every notification id is taken: nothing could be shown, so
  // the registration must not go ahead and claim push is on.
  fun save(context: Context, instance: String, title: String, body: String): Boolean {
    val prefs = prefs(context)
    val id = PushSlots.idFor(instance, ids(prefs)) ?: return false
    prefs.edit()
      .putString(TITLE + instance, title)
      .putString(BODY + instance, body)
      .putInt(ID + instance, id)
      .apply()
    return true
  }

  fun forget(context: Context, instance: String) {
    prefs(context).edit()
      .remove(TITLE + instance)
      .remove(BODY + instance)
      .remove(ID + instance)
      .remove(RING + instance)
      .apply()
  }

  // What a ring from push shows for this server: its words, and quiet while
  // the ring sound is off in the app. Which DM rings comes with each push.
  fun saveRing(context: Context, instance: String, ring: ShowRingArgs) {
    val json = JSONObject()
      .put("title", ring.title)
      .put("text", ring.text)
      .put("accept", ring.acceptLabel)
      .put("decline", ring.declineLabel)
      .put("channelName", ring.channelName)
      .put("channelDescription", ring.channelDescription)
      .put("quiet", ring.quiet)
    prefs(context).edit().putString(RING + instance, json.toString()).apply()
  }

  fun ring(context: Context, instance: String): ShowRingArgs? {
    val raw = prefs(context).getString(RING + instance, null) ?: return null
    return try {
      val json = JSONObject(raw)
      ShowRingArgs().apply {
        title = json.getString("title")
        text = json.getString("text")
        acceptLabel = json.getString("accept")
        declineLabel = json.getString("decline")
        channelName = json.getString("channelName")
        channelDescription = json.getString("channelDescription")
        quiet = json.getBoolean("quiet")
      }
    } catch (_: org.json.JSONException) {
      null
    }
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
// and a tap opens the app (on the server it last showed: the push carries no
// channel, and the intent names the server for a later switch). While the app
// is on screen the page shows messages itself, so a push then shows nothing.
object PushAlerts {
  // The channel the page's own message notifications use
  // (android_notifications.rs), so one switch in Android's settings covers both.
  private const val CHANNEL = "messages"
  const val EXTRA_INSTANCE = "com.owncord.client.PUSH_INSTANCE"
  const val ACTION_OPEN = "com.owncord.client.PUSH_OPEN"

  fun onMessage(context: Context, instance: String, content: String) {
    val kind = PushPayload.kindOf(content)
    if (kind == PushPayload.RING || kind == PushPayload.RING_END) {
      PushRing.onMessage(context, instance, kind, content)
      return
    }
    if (kind != PushPayload.ACTIVITY) return
    if (appOnScreen()) return
    val id = PushStore.id(context, instance) ?: return
    val title = PushStore.title(context, instance) ?: return
    val body = PushStore.body(context, instance).orEmpty()
    val manager = context.getSystemService(NotificationManager::class.java)
    ensureChannel(manager, context.applicationInfo.loadLabel(context.packageManager).toString())
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

  fun appOnScreen(): Boolean =
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

// A DM call's ring from push, shown with no page running: the same incoming
// call notification the page shows (CallRing), with the words the page left
// at registration. Its Accept and tap open the app, which joins once signed in
// to that server; its Decline only takes it down, since no page is there to
// tell the server.
object PushRing {
  // As long as the page's own ring; the server remembers the ring past it.
  private const val TIMEOUT_MS = 30_000L

  fun onMessage(context: Context, instance: String, kind: String, content: String) {
    val channelId = PushPayload.channelOf(content)
    val buttons = CallRingState.buttons
    val owner = CallRingState.pushOwner
    val upHere = channelId != null && buttons.isUp(channelId) && CallRing.isUp(context)
    // The page's own ring is for the server it is signed in to, which a push
    // may or may not come from: a push leaves it to the page.
    val alreadyUp = upHere && (owner == null || owner == instance)
    when (PushRingRule.step(kind, channelId, PushAlerts.appOnScreen(), alreadyUp)) {
      PushRingRule.Step.RING -> if (channelId != null) ring(context, instance, channelId)
      PushRingRule.Step.END ->
        if (channelId != null && owner == instance && buttons.ringDown(channelId)) CallRing.cancel(context)
      PushRingRule.Step.NONE -> {}
    }
  }

  private fun ring(context: Context, instance: String, channelId: Long) {
    val args = PushStore.ring(context, instance) ?: return
    args.channelId = channelId
    args.timeoutMs = TIMEOUT_MS
    try {
      val channel = CallRing.channel(context, args)
      if (!CallRing.shows(context, channel)) return
      CallRing.post(context, args, channel, CallRingState.buttons.ringUp(channelId), instance)
      CallRingState.pushOwner = instance
      NativeLog.info(ExitInfo.callRingShown(args.quiet))
    } catch (e: Exception) {
      NativeLog.warn("push ring not shown: ${e.javaClass.simpleName}")
    }
  }
}
