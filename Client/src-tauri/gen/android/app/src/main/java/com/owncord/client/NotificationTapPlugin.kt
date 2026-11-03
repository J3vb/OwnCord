package com.owncord.client

import android.app.Activity
import android.content.Intent
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// Which notification the user tapped. tauri-plugin-notification tells the
// webview that a notification was tapped, but not which one; its tap intent
// does carry the notification's id, so this plugin keeps it until the
// webview takes it (take_notification_tap in android_notifications.rs) and
// opens the channel or message that notification was for.
//
// Only taps on a running app (onNewIntent) count: a tap that starts the
// process reaches the webview before it listens, and that process never
// showed the notification, so the tap just opens the app. One id per tap,
// in order, so two quick taps each get their own.
@TauriPlugin
class NotificationTapPlugin(private val activity: Activity) : Plugin(activity) {
  private val tapped = ArrayDeque<Int>()

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (intent.getStringExtra(ACTION_KEY) != TAP_ACTION) return
    val id = intent.getIntExtra(ID_KEY, Int.MIN_VALUE)
    if (id == Int.MIN_VALUE) return
    synchronized(tapped) {
      // A tap the webview never took (its listener was not up) must not linger.
      while (tapped.size >= MAX_PENDING) tapped.removeFirst()
      tapped.addLast(id)
    }
  }

  @Command
  fun takeTap(invoke: Invoke) {
    val result = JSObject()
    synchronized(tapped) { tapped.removeFirstOrNull() }?.let { result.put("id", it) }
    invoke.resolve(result)
  }

  companion object {
    // The extras tauri-plugin-notification puts on its tap intent
    // (TauriNotificationManager.kt in the plugin's Android sources).
    private const val ID_KEY = "NotificationId"
    private const val ACTION_KEY = "NotificationUserAction"
    private const val TAP_ACTION = "tap"
    private const val MAX_PENDING = 8
  }
}
