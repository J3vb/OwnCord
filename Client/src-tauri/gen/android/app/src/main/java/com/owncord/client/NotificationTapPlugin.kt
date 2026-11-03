package com.owncord.client

import android.app.Activity
import android.content.Intent
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// Which notification the user tapped. tauri-plugin-notification tells the
// webview that a notification was tapped, but not which one; its tap intent
// does carry the notification's id, so this plugin keeps it until the
// webview takes it (take_notification_tap in notification_tap.rs) and opens
// the channel or message that notification was for.
@TauriPlugin
class NotificationTapPlugin(private val activity: Activity) : Plugin(activity) {
  private var tappedId: Int? = null

  override fun load(webView: WebView) {
    super.load(webView)
    remember(activity.intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    remember(intent)
  }

  private fun remember(intent: Intent?) {
    if (intent == null || intent.getStringExtra(ACTION_KEY) != TAP_ACTION) return
    val id = intent.getIntExtra(ID_KEY, Int.MIN_VALUE)
    if (id != Int.MIN_VALUE) tappedId = id
  }

  @Command
  fun takeTap(invoke: Invoke) {
    val result = JSObject()
    tappedId?.let { result.put("id", it) }
    tappedId = null
    invoke.resolve(result)
  }

  companion object {
    // The extras tauri-plugin-notification puts on its tap intent
    // (TauriNotificationManager.kt in the plugin's Android sources).
    private const val ID_KEY = "NotificationId"
    private const val ACTION_KEY = "NotificationUserAction"
    private const val TAP_ACTION = "tap"
  }
}
