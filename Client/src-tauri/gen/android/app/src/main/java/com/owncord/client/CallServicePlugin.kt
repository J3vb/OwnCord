package com.owncord.client

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.view.WindowManager
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class SetCallArgs {
  var active: Boolean = false
  var camera: Boolean = false
  var videoOnScreen: Boolean = false
}

// What the webview last asked for, and what a new ask changes. Apart from the
// plugin so the rules run in a JVM test.
class CallWants {
  enum class Service { KEEP, START, STOP }

  class Step(val service: Service, val screenOn: Boolean)

  var active = false
    private set
  var camera = false
    private set

  // The service is started (again) for what it has to know: a call, its
  // camera, or a start that did not take. A picture coming on screen or
  // leaving it changes the screen only, and a running service is left alone:
  // a restart goes through Android's foreground-service rules once more.
  fun take(active: Boolean, camera: Boolean, videoOnScreen: Boolean, running: Boolean): Step {
    val changed = active != this.active || camera != this.camera
    this.active = active
    this.camera = camera
    val service = when {
      active && (changed || !running) -> Service.START
      !active && changed -> Service.STOP
      else -> Service.KEEP
    }
    return Step(service, active && videoOnScreen)
  }
}

// The webview's half of CallService: starts it when a call begins (the user
// just tapped Join, so the app is in front, which Android requires), updates
// it when the camera goes on or off, and stops it when the call ends.
//
// On a first call the mic (or camera) permission is asked only after the
// join, and Android refuses a microphone service without it. The wanted
// state is kept, and the service starts or widens when the app comes back
// from the permission dialog (onResume), still in front.
//
// It also keeps the screen on while the call shows a camera or a stream.
@TauriPlugin
class CallServicePlugin(private val activity: Activity) : Plugin(activity) {
  private var askedForCallPermissions = false
  private val wants = CallWants()
  private var started = false
  private var startedWithCamera = false
  private var screenKeptOn = false

  @Command
  fun setCall(invoke: Invoke) {
    val args = invoke.parseArgs(SetCallArgs::class.java)
    val step = wants.take(args.active, args.camera, args.videoOnScreen, started)
    keepScreenOn(step.screenOn)
    try {
      when (step.service) {
        CallWants.Service.START -> startIfAllowed(force = true)
        CallWants.Service.STOP -> {
          started = false
          startedWithCamera = false
          CallService.stop(activity)
        }
        CallWants.Service.KEEP -> {}
      }
      invoke.resolve()
    } catch (e: Exception) {
      // Android 12+ refuses a start from the background (a reconnect while
      // the app is hidden); the call itself carries on.
      invoke.reject("call service: $e", e)
    }
  }

  // On the window, not on the web view: the web view sets its own view's
  // keep-screen-on for a playing video by rules that differ between its
  // versions, and Android adds the two up.
  private fun keepScreenOn(on: Boolean) {
    if (on == screenKeptOn) return
    screenKeptOn = on
    NativeLog.info(ExitInfo.screenKeptOn(on))
    activity.runOnUiThread {
      val flag = WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
      if (on) activity.window.addFlags(flag) else activity.window.clearFlags(flag)
    }
  }

  override fun onResume() {
    super.onResume()
    if (!wants.active) return
    val cameraNowAllowed = wants.camera && granted(Manifest.permission.CAMERA)
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
    val camera = wants.camera && granted(Manifest.permission.CAMERA)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !mic && !camera) {
      // Nothing Android lets the service cover yet: wait for onResume.
      started = false
      return
    }
    if (!force && started && startedWithCamera == camera) return
    CallService.start(activity, wants.camera)
    started = true
    startedWithCamera = camera
    askForCallPermissionsOnce()
  }

  private fun granted(permission: String): Boolean =
    activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  // Asked together, once, only after the mic is granted, so they never cut
  // across the webview's own mic prompt (Android drops one of two
  // overlapping asks). Without notifications the service still runs, but
  // its notification is hidden; without Bluetooth (Android 12+) the
  // webview leaves a Bluetooth headset's mic out of the call.
  private fun askForCallPermissionsOnce() {
    if (askedForCallPermissions) return
    askedForCallPermissions = true
    val wanted = mutableListOf<String>()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      wanted += Manifest.permission.POST_NOTIFICATIONS
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      wanted += Manifest.permission.BLUETOOTH_CONNECT
    }
    val missing = wanted.filter { !granted(it) }
    if (missing.isNotEmpty()) {
      activity.requestPermissions(missing.toTypedArray(), 41)
    }
  }
}
