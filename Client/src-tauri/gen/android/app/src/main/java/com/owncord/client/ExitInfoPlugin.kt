package com.owncord.client

import android.app.Activity
import android.app.ActivityManager
import android.os.Build
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class StartArgs {
  var logFile: String = ""
}

// Crash and exit facts for the native log, which the support bundle carries:
// how the earlier runs ended (Android 11+ keeps that per app), the webview's
// render process going away, and the app moving to the background and back.
// Lines only; nothing here changes what the app does.
@TauriPlugin
class ExitInfoPlugin(private val activity: Activity) : Plugin(activity) {
  override fun load(webView: WebView) {
    // The webview client is set just after this, in the same main-thread
    // step, so wrap it on the next one.
    webView.post { RenderGoneClient.wrap(webView) }
  }

  @Command
  fun start(invoke: Invoke) {
    val args = invoke.parseArgs(StartArgs::class.java)
    if (args.logFile.isNotEmpty()) NativeLog.setPath(activity, args.logFile)
    reportEarlierExits()
    invoke.resolve()
  }

  override fun onStop() {
    NativeLog.info(ExitInfo.appVisibility(false))
  }

  override fun onRestart() {
    NativeLog.info(ExitInfo.appVisibility(true))
  }

  private fun reportEarlierExits() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      NativeLog.info(ExitInfo.notAvailableMessage(Build.VERSION.SDK_INT))
      return
    }
    val prefs = NativeLog.prefs(activity)
    val last = prefs.getLong(NativeLog.KEY_LAST_EXIT_MS, 0L)
    val exits = try {
      activity.getSystemService(ActivityManager::class.java)
        .getHistoricalProcessExitReasons(activity.packageName, 0, 0)
        .map {
          ExitInfo.Exit(
            reason = it.reason,
            status = it.status,
            importance = it.importance,
            timestampMs = it.timestamp,
            rssKb = it.rss,
          )
        }
    } catch (e: Exception) {
      NativeLog.warn(ExitInfo.readFailedMessage(e))
      return
    }
    val fresh = ExitInfo.unreported(exits, last)
    if (fresh.isEmpty()) {
      NativeLog.info(ExitInfo.nothingNewMessage())
      return
    }
    val now = System.currentTimeMillis()
    for (exit in fresh) {
      val message = ExitInfo.exitMessage(exit, now)
      if (ExitInfo.isCrash(exit.reason)) NativeLog.warn(message) else NativeLog.info(message)
    }
    prefs.edit().putLong(NativeLog.KEY_LAST_EXIT_MS, fresh.last().timestampMs).commit()
  }
}
