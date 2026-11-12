package com.owncord.client

import android.app.Activity
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.WebView
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject

/** One place a call's sound can go, as the route sheet lists it. `name` is the
 *  device's own name for a Bluetooth route and empty for the others. */
data class AudioRoute(val kind: String, val name: String)

// MobileAudioPlugin's rules, apart from Android so a JVM test runs them. Device
// types and audio modes are the platform's own numbers.
object MobileAudioPolicy {
  const val SPEAKER = "speaker"
  const val EARPIECE = "earpiece"
  const val WIRED = "wired"
  const val BLUETOOTH = "bluetooth"

  private val ORDER = listOf(SPEAKER, EARPIECE, WIRED, BLUETOOTH)

  /** The route a device type belongs to; null for a device a call does not use. */
  fun kindOf(deviceType: Int): String? =
    when (deviceType) {
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> SPEAKER
      AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> EARPIECE
      AudioDeviceInfo.TYPE_WIRED_HEADSET,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      AudioDeviceInfo.TYPE_USB_DEVICE -> WIRED
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_HEARING_AID -> BLUETOOTH
      else -> null
    }

  /** One route per kind, in the sheet's order, from (device type, product
   *  name) pairs. The first device of a kind stands for it. */
  fun routes(devices: List<Pair<Int, String>>): List<AudioRoute> {
    val names = LinkedHashMap<String, String>()
    for ((type, name) in devices) {
      val kind = kindOf(type) ?: continue
      if (kind !in names) names[kind] = if (kind == BLUETOOTH) name.trim() else ""
    }
    return ORDER.mapNotNull { kind -> names[kind]?.let { AudioRoute(kind, it) } }
  }

  /** The route the WebView picks by itself: a headset when one is connected,
   *  else the speaker. Never the earpiece. */
  fun autoKind(kinds: Set<String>): String =
    when {
      WIRED in kinds -> WIRED
      BLUETOOTH in kinds -> BLUETOOTH
      else -> SPEAKER
    }

  /** What a tap on `kind` leaves as the user's pick: nothing for a route that
   *  is not there, or for the one the WebView picks anyway. */
  fun pick(kind: String, kinds: Set<String>): String? =
    if (kind !in kinds || kind == autoKind(kinds)) null else kind

  /** The user's pick after the connected devices changed. It goes when its
   *  device left, when a headset was just connected (a new headset wins, as in
   *  a phone call), and when it is what the WebView would pick now anyway. */
  fun manualAfterChange(manual: String?, before: Set<String>, after: Set<String>): String? {
    if (manual == null || manual !in after) return null
    val headsetArrived =
      (WIRED in after && WIRED !in before) || (BLUETOOTH in after && BLUETOOTH !in before)
    return if (headsetArrived || manual == autoKind(after)) null else manual
  }

  /** A phone call that was answered or dialled holds the audio. A ringing
   *  phone does not: the call carries on until the user picks up. */
  fun interrupts(mode: Int): Boolean = mode == AudioManager.MODE_IN_CALL

  /** Android honours a device request only while an app's own call holds the
   *  audio mode. */
  fun mayRequest(mode: Int): Boolean = mode == AudioManager.MODE_IN_COMMUNICATION

  /** The route to show. `currentType` is the device Android reports for calls,
   *  passed only while the call mode is on; outside it the sound follows the
   *  user's pick once the mode starts, else the automatic route. */
  fun active(manual: String?, currentType: Int?, kinds: Set<String>): String =
    currentType?.let(::kindOf) ?: manual ?: autoKind(kinds)

  /** How often a picked route may be asked for within a window: enough for an
   *  unmute or a device change to settle, too few for a tug-of-war with another
   *  owner of the audio route to go on. */
  class Budget(private val max: Int = 8, private val windowMs: Long = 10_000) {
    private val taken = ArrayDeque<Long>()

    fun take(nowMs: Long): Boolean {
      while (taken.isNotEmpty() && nowMs - taken.first() >= windowMs) taken.removeFirst()
      if (taken.size >= max) return false
      taken.addLast(nowMs)
      return true
    }

    fun reset() = taken.clear()
  }
}

@InvokeArg
class AudioSessionArgs {
  var active: Boolean = false
}

@InvokeArg
class AudioRouteArgs {
  var kind: String = ""
}

// The Android 12+ half: the routes Android offers for calls, the user's pick,
// and whether a phone call holds the audio. Main thread only.
@RequiresApi(Build.VERSION_CODES.S)
private class CallAudio(
  activity: Activity,
  /** Whether this WebView can be muted; without it a phone call pauses nothing. */
  private val canMute: Boolean,
  private val muteWebView: (Boolean) -> Unit,
  private val onChange: () -> Unit,
) {
  // The activity's own AudioManager: Android keeps device requests per
  // instance, so this one never replaces or clears the WebView's.
  private val audio: AudioManager = activity.getSystemService(AudioManager::class.java)
  private val executor = activity.mainExecutor
  private val main = Handler(Looper.getMainLooper())
  private var active = false
  private var manual: String? = null
  private var requested = false
  private var interrupted = false
  /** Picks given up because Android would not keep them. It only grows, so the
   *  webview sees a loss in any state that reaches it after one. */
  private var lost = 0
  private var kinds: Set<String> = emptySet()
  private val asks = MobileAudioPolicy.Budget()
  private val onDevice = AudioManager.OnCommunicationDeviceChangedListener { onChange() }
  private val onMode = AudioManager.OnModeChangedListener { onChange() }
  private val onDevices =
    object : AudioDeviceCallback() {
      override fun onAudioDevicesAdded(added: Array<AudioDeviceInfo>) = onChange()

      override fun onAudioDevicesRemoved(removed: Array<AudioDeviceInfo>) = onChange()
    }

  /** A call began or ended. Either way it starts from no pick: a route belongs
   *  to one call, and the webview that began the last one may have been
   *  reloaded before it could end it. Ending a call also drops the device
   *  request and lifts a pause. */
  fun setActive(next: Boolean) {
    manual = null
    asks.reset()
    if (active == next) return
    active = next
    if (next) {
      audio.addOnCommunicationDeviceChangedListener(executor, onDevice)
      audio.addOnModeChangedListener(executor, onMode)
      audio.registerAudioDeviceCallback(onDevices, main)
    } else {
      audio.removeOnCommunicationDeviceChangedListener(onDevice)
      audio.removeOnModeChangedListener(onMode)
      audio.unregisterAudioDeviceCallback(onDevices)
      release()
      setInterrupted(false)
    }
  }

  /** The user tapped a route. Outside a call there is nothing to route. */
  fun pick(kind: String) {
    if (!active) return
    manual = MobileAudioPolicy.pick(kind, kinds)
    asks.reset()
    NativeLog.info("[audio] route picked: ${manual ?: "automatic"}")
  }

  /** Bring the device request and the pause in line with Android's state now,
   *  and report the result. */
  fun sync(): JSObject {
    val mode = audio.mode
    val devices = audio.availableCommunicationDevices
    val routes = MobileAudioPolicy.routes(devices.map { it.type to it.productName.toString() })
    val now = routes.mapTo(LinkedHashSet()) { it.kind }
    manual = MobileAudioPolicy.manualAfterChange(manual, kinds, now)
    kinds = now
    setInterrupted(active && canMute && MobileAudioPolicy.interrupts(mode))
    request(mode, devices)
    val current = if (MobileAudioPolicy.mayRequest(mode)) audio.communicationDevice?.type else null
    return JSObject().apply {
      put("supported", true)
      put("routes", JSArray().apply { for (route in routes) put(routeJson(route)) })
      put("active", MobileAudioPolicy.active(manual, current, now))
      put("manual", manual ?: JSONObject.NULL)
      put("interrupted", interrupted)
      put("lost", lost)
    }
  }

  private fun routeJson(route: AudioRoute): JSObject =
    JSObject().apply {
      put("kind", route.kind)
      put("name", route.name)
    }

  /** Ask Android for the picked device while the call mode is on, and take the
   *  request back at any other time. A pick that cannot hold is dropped. */
  private fun request(mode: Int, devices: List<AudioDeviceInfo>) {
    val kind = manual
    val wanted =
      if (kind == null || interrupted || !MobileAudioPolicy.mayRequest(mode)) null
      else devices.firstOrNull { MobileAudioPolicy.kindOf(it.type) == kind }
    if (wanted == null) {
      release()
      return
    }
    if (audio.communicationDevice?.id == wanted.id) return
    if (asks.take(SystemClock.elapsedRealtime()) && ask(wanted)) return
    NativeLog.warn("[audio] the $kind route did not hold; back to automatic")
    manual = null
    lost++
    release()
  }

  private fun ask(device: AudioDeviceInfo): Boolean {
    val accepted =
      try {
        audio.setCommunicationDevice(device)
      } catch (e: IllegalArgumentException) {
        false
      }
    if (accepted) requested = true
    return accepted
  }

  private fun release() {
    if (!requested) return
    requested = false
    audio.clearCommunicationDevice()
  }

  private fun setInterrupted(next: Boolean) {
    if (interrupted == next) return
    interrupted = next
    muteWebView(next)
    NativeLog.info(if (next) "[audio] phone call began: call paused" else "[audio] call resumed")
  }
}

// Where a call's sound goes on the phone, and the pause for a phone call.
//
// The WebView runs the call's audio by itself: it enters Android's call mode
// while a microphone capture with voice processing is open, and picks the
// route (a connected headset, else the speaker). This plugin never sets the
// audio mode and never takes audio focus, so music and games keep playing
// beside a call. While the webview says a call runs, it adds two things:
//
// - The route the user picked. Android is asked for that device only while the
//   call mode is on, and asked again when something else moves the route. With
//   no pick nothing is asked for and the WebView's own choice stands.
// - A phone call. While Android reports one, the WebView's sound is muted and
//   the webview hears `interrupted`, so it closes the microphone; both come
//   back when the phone call ends.
//
// The communication device API is Android 12's: an older phone reports
// `supported: false` and behaves as it did before.
@TauriPlugin
class MobileAudioPlugin(private val activity: Activity) : Plugin(activity) {
  private val main = Handler(Looper.getMainLooper())
  private var webView: WebView? = null
  private var callAudio: CallAudio? = null
  private var destroyed = false
  private var published: String? = null
  private var seq = 0L

  override fun load(webView: WebView) {
    this.webView = webView
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    try {
      callAudio = CallAudio(activity, canMuteWebView(), ::muteWebView, ::onAudioChange)
    } catch (e: Exception) {
      NativeLog.warn("[audio] call audio unavailable: ${e.javaClass.name}")
    }
  }

  private fun canMuteWebView(): Boolean =
    try {
      WebViewFeature.isFeatureSupported(WebViewFeature.MUTE_AUDIO)
    } catch (e: Exception) {
      false
    }

  private fun muteWebView(muted: Boolean) {
    val view = webView ?: return
    try {
      WebViewCompat.setAudioMuted(view, muted)
    } catch (e: Exception) {
      NativeLog.warn("[audio] webview mute failed: ${e.javaClass.name}")
    }
  }

  private fun onAudioChange() {
    if (destroyed) return
    try {
      publish()
    } catch (e: Exception) {
      NativeLog.warn("[audio] route update failed: ${e.javaClass.name}")
    }
  }

  /** The state now, numbered so the webview can drop one that arrives late.
   *  A changed state also goes out as an event. */
  private fun publish(): JSObject {
    val state = callAudio?.sync() ?: unsupported()
    val text = state.toString()
    val changed = text != published
    if (changed) {
      published = text
      seq++
    }
    state.put("seq", seq)
    if (changed) trigger("state", state)
    return state
  }

  private fun unsupported(): JSObject =
    JSObject().apply {
      put("supported", false)
      put("routes", JSArray())
      put("active", MobileAudioPolicy.SPEAKER)
      put("manual", JSONObject.NULL)
      put("interrupted", false)
      put("lost", 0)
    }

  @Command
  fun setSession(invoke: Invoke) {
    val args = invoke.parseArgs(AudioSessionArgs::class.java)
    onMain(invoke) { callAudio?.setActive(args.active) }
  }

  @Command
  fun setRoute(invoke: Invoke) {
    val args = invoke.parseArgs(AudioRouteArgs::class.java)
    onMain(invoke) { callAudio?.pick(args.kind) }
  }

  @Command
  fun getState(invoke: Invoke) {
    onMain(invoke) {}
  }

  /** Run a change on the main thread, then answer with the state it left. */
  private fun onMain(invoke: Invoke, change: () -> Unit) {
    val run = Runnable {
      if (destroyed) {
        invoke.reject("call audio unavailable")
        return@Runnable
      }
      try {
        change()
        invoke.resolve(publish())
      } catch (e: Exception) {
        invoke.reject("call audio unavailable", e)
      }
    }
    if (Looper.myLooper() == Looper.getMainLooper()) run.run() else main.post(run)
  }

  override fun onDestroy(activity: AppCompatActivity) {
    destroyed = true
    try {
      callAudio?.setActive(false)
    } catch (e: Exception) {
      NativeLog.warn("[audio] call audio cleanup failed: ${e.javaClass.name}")
    }
    callAudio = null
  }
}
