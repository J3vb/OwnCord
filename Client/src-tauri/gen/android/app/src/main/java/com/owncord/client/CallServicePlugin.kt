package com.owncord.client

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import android.view.WindowManager
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class SetCallArgs {
  var active: Boolean = false
  var camera: Boolean = false
  var videoOnScreen: Boolean = false
  var mic: String = CallFace.LIVE
  var text: String = ""
  var micLabel: String? = null
  var leaveLabel: String = ""
}

// What the webview last asked for, and what a new ask changes. Apart from the
// plugin so the rules run in a JVM test.
class CallWants {
  enum class Service { KEEP, START, STOP }

  class Step(val service: Service, val screenOn: Boolean, val renotify: Boolean)

  var active = false
    private set
  var camera = false
    private set
  var face = CallFace.PLAIN
    private set

  // The service is started (again) for what it has to know: a call, its
  // camera, or a start that did not take. A picture coming on screen or
  // leaving it changes the screen only, and a running service is left alone:
  // a restart goes through Android's foreground-service rules once more.
  //
  // New words or buttons for the notification (the microphone was muted) are
  // not a reason to start it again either: a service left running writes its
  // notification again, and one that starts reads them as it starts.
  fun take(
    active: Boolean,
    camera: Boolean,
    videoOnScreen: Boolean,
    running: Boolean,
    face: CallFace = this.face,
  ): Step {
    val changed = active != this.active || camera != this.camera
    val newFace = face != this.face
    this.active = active
    this.camera = camera
    this.face = face
    val service = when {
      active && (changed || !running) -> Service.START
      !active && changed -> Service.STOP
      else -> Service.KEEP
    }
    return Step(service, active && videoOnScreen, active && newFace && service == Service.KEEP)
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
//
// And it is where the call notifications' buttons come in: the service's own
// (Mute, Unmute, Leave) and the incoming call's (CallRing: Accept, Decline, a
// tap on it). Each reaches the webview as an `action` event, and the webview
// acts on it: this side only shows and takes down, and holds no call.
@TauriPlugin
class CallServicePlugin(private val activity: Activity) : Plugin(activity) {
  private var askedForCallPermissions = false
  private val wants = CallWants()
  private val buttons = CallRingState.buttons
  // Accept or a tap on a ring that started the app: held until the webview
  // listens for actions, which it does only after this plugin loaded.
  private var launchAction: JSObject? = null
  private var started = false
  private var startedWithCamera = false
  private var screenKeptOn = false

  // The activity on screen, whose window holds the screen flag. Android
  // builds a new one when a system setting changes that the app does not
  // take in place, and this plugin stays.
  private var shownIn: Activity = activity

  override fun load(webView: WebView) {
    super.load(webView)
    CallActionReceiver.sink = { intent -> pressed(intent, throughActivity = false) }
    launchAction = actionOf(activity.intent, throughActivity = true)
  }

  // The webview starts listening: an action that started the app goes now.
  @Command
  override fun registerListener(invoke: Invoke) {
    super.registerListener(invoke)
    val held = launchAction ?: return
    if (!hasListener(ACTION_EVENT)) return
    launchAction = null
    trigger(ACTION_EVENT, held)
  }

  // Accept, and a tap on the ring, open the app and arrive here.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    pressed(intent, throughActivity = true)
  }

  private fun pressed(intent: Intent, throughActivity: Boolean) {
    val payload = actionOf(intent, throughActivity) ?: return
    trigger(ACTION_EVENT, payload)
  }

  // What the webview hears of a press, or null for an intent that is no call
  // button of ours. A decline takes the ring down here.
  private fun actionOf(intent: Intent?, throughActivity: Boolean): JSObject? {
    // Every intent that reaches the activity comes by here: one that is not a
    // call button is not this plugin's to read.
    if (intent == null || !CallActions.names(intent.action)) return null
    val channelId =
      if (intent.hasExtra(CallActions.EXTRA_CHANNEL)) intent.getLongExtra(CallActions.EXTRA_CHANNEL, 0)
      else null
    val token = intent.getStringExtra(CallActions.EXTRA_TOKEN)
    val event = buttons.read(intent.action, channelId, token, throughActivity) ?: return null
    // Declined: it stops ringing at once, whatever the webview is doing. An
    // accepted ring stays up until the webview has joined or said why not.
    if (event.kind == CallEvent.DECLINE && event.channelId != null && buttons.ringDown(event.channelId)) {
      CallRing.cancel(activity.applicationContext)
    }
    NativeLog.info(ExitInfo.callButton(event.kind))
    val payload = JSObject()
    payload.put("kind", event.kind)
    if (event.channelId != null) payload.put("channelId", event.channelId)
    intent.getStringExtra(CallActions.EXTRA_INSTANCE)?.let { payload.put("instance", it) }
    return payload
  }

  @Command
  fun showRing(invoke: Invoke) {
    val args = invoke.parseArgs(ShowRingArgs::class.java)
    val context = activity.applicationContext
    val refusal = try {
      val channel = CallRing.channel(context, args)
      if (CallRing.shows(context, channel)) {
        CallRing.post(context, args, channel, buttons.ringUp(args.channelId))
        null
      } else {
        "notifications are off"
      }
    } catch (e: Exception) {
      e.toString()
    }
    if (refusal == null) {
      NativeLog.info(ExitInfo.callRingShown(args.quiet))
      invoke.resolve()
      return
    }
    // Refused: the webview rings by itself then, as it does with the app in
    // front, so nothing of this ring may stay up here (it was shown before
    // and could not be shown again).
    if (buttons.ringDown(args.channelId)) CallRing.cancel(context)
    invoke.reject("call ring: $refusal")
  }

  @Command
  fun clearRing(invoke: Invoke) {
    val args = invoke.parseArgs(ClearRingArgs::class.java)
    if (buttons.ringDown(args.channelId)) CallRing.cancel(activity.applicationContext)
    invoke.resolve()
  }

  @Command
  fun setCall(invoke: Invoke) {
    val args = invoke.parseArgs(SetCallArgs::class.java)
    val face = CallFace(args.mic, args.text, args.micLabel, args.leaveLabel)
    val step = wants.take(args.active, args.camera, args.videoOnScreen, started, face)
    keepScreenOn(step.screenOn)
    CallService.face = face
    if (step.renotify) CallService.refresh()
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
    applyScreenFlag()
  }

  private fun applyScreenFlag() {
    val on = screenKeptOn
    val window = shownIn.window
    shownIn.runOnUiThread {
      val flag = WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
      if (on) window.addFlags(flag) else window.clearFlags(flag)
    }
  }

  // A new activity starts with a window that holds no flag.
  override fun onResume(activity: AppCompatActivity) {
    if (activity === shownIn) return
    shownIn = activity
    if (screenKeptOn) applyScreenFlag()
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

  companion object {
    private const val ACTION_EVENT = "action"
  }
}
