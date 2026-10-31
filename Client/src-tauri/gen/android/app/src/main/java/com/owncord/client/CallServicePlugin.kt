package com.owncord.client

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
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
//
// On a first call the mic (or camera) permission is asked only after the
// join, and Android refuses a microphone service without it. The wanted
// state is kept, and the service starts or widens when the app comes back
// from the permission dialog (onResume), still in front.
@TauriPlugin
class CallServicePlugin(private val activity: Activity) : Plugin(activity) {
  private var askedForNotifications = false
  private var wantActive = false
  private var wantCamera = false
  private var started = false
  private var startedWithCamera = false

  @Command
  fun setCall(invoke: Invoke) {
    val args = invoke.parseArgs(SetCallArgs::class.java)
    wantActive = args.active
    wantCamera = args.camera
    try {
      if (args.active) {
        startIfAllowed(force = true)
      } else {
        started = false
        startedWithCamera = false
        CallService.stop(activity)
      }
      invoke.resolve()
    } catch (e: Exception) {
      // Android 12+ refuses a start from the background (a reconnect while
      // the app is hidden); the call itself carries on.
      invoke.reject("call service: $e", e)
    }
  }

  override fun onResume() {
    super.onResume()
    if (!wantActive) return
    val cameraNowAllowed = wantCamera && granted(Manifest.permission.CAMERA)
    if (started && (startedWithCamera || !cameraNowAllowed)) return
    try {
      startIfAllowed(force = false)
    } catch (e: Exception) {
      // Same as above: the call goes on without the background keep-alive.
      Log.w("OwnCordCall", "call service start after resume refused: $e")
    }
  }

  private fun startIfAllowed(force: Boolean) {
    val mic = granted(Manifest.permission.RECORD_AUDIO)
    val camera = wantCamera && granted(Manifest.permission.CAMERA)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !mic && !camera) {
      // Nothing Android lets the service cover yet: wait for onResume.
      started = false
      return
    }
    if (!force && started && startedWithCamera == camera) return
    CallService.start(activity, wantCamera)
    started = true
    startedWithCamera = camera
    askForNotificationsOnce()
  }

  private fun granted(permission: String): Boolean =
    activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  // Without this the service still runs, but its notification is hidden.
  // Asked only once the mic is granted, so it never cuts across the
  // webview's own mic prompt (Android drops one of two overlapping asks).
  private fun askForNotificationsOnce() {
    if (askedForNotifications || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    askedForNotifications = true
    if (!granted(Manifest.permission.POST_NOTIFICATIONS)) {
      activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 41)
    }
  }
}
