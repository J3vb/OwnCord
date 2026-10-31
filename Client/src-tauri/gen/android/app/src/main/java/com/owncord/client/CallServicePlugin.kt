package com.owncord.client

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class SetCallArgs {
  var active: Boolean = false
  var camera: Boolean = false
}

// The webview's half of CallService: starts it when a call begins (the user
// just tapped Join, so the app is in front, which Android requires), updates
// it when the camera goes on or off, and stops it when the call ends.
@TauriPlugin
class CallServicePlugin(private val activity: Activity) : Plugin(activity) {
  private var askedForNotifications = false

  @Command
  fun setCall(invoke: Invoke) {
    val args = invoke.parseArgs(SetCallArgs::class.java)
    try {
      if (args.active) {
        askForNotificationsOnce()
        CallService.start(activity, args.camera)
      } else {
        CallService.stop(activity)
      }
      invoke.resolve()
    } catch (e: Exception) {
      // Android 12+ refuses a start from the background (a reconnect while
      // the app is hidden); the call itself carries on.
      invoke.reject("call service: $e", e)
    }
  }

  // Without this the service still runs, but its notification is hidden.
  private fun askForNotificationsOnce() {
    if (askedForNotifications || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    askedForNotifications = true
    if (activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED) {
      activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
    }
  }
}
