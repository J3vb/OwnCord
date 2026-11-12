package com.owncord.client

import android.app.Activity
import android.app.AlarmManager
import android.os.PowerManager
import android.os.SystemClock
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class IdleFollowArgs {
  var thresholdMs: Long = 0
}

// How long the app has been out of view, and when the page should next look at
// that. No Android types: the plugin feeds it the clock, so it is unit tested
// on the JVM.
class AwayClock {
  private var hiddenAt: Long? = null
  private var thresholdMs = 0L

  // Milliseconds out of view, 0 while the app shows.
  fun awayMs(now: Long): Long = hiddenAt?.let { (now - it).coerceAtLeast(0L) } ?: 0L

  // The app left view. Answers when to look, as the next two do.
  fun hide(now: Long): Long? {
    if (hiddenAt == null) hiddenAt = now
    return nextLook(now)
  }

  fun show() {
    hiddenAt = null
  }

  // The page follows a delay; 0 when it stops.
  fun follow(thresholdMs: Long, now: Long): Long? {
    this.thresholdMs = thresholdMs
    return nextLook(now)
  }

  // When the app has been out of view for the delay; once that has passed,
  // one delay from now, since the page may have had a reason to wait (its
  // user spoke in a call). Null while the app shows or nobody follows.
  fun nextLook(now: Long): Long? {
    val since = hiddenAt ?: return null
    if (thresholdMs <= 0L) return null
    val first = since + thresholdMs
    return if (first > now) first else now + thresholdMs
  }
}

// The Android app's idle time for the page's auto-idle: how long the app has
// been out of view (in the background, or the screen off), 0 while it shows.
// The page polls it, but a phone that sleeps runs no timer of the page, so the
// plugin also says when to look (`look`): as the app comes back into view, and
// each time it has been out of view for the delay the page follows, by an
// alarm that wakes the phone. Everything here runs on the main thread.
@TauriPlugin
class IdlePlugin(private val activity: Activity) : Plugin(activity) {
  private val alarms = activity.getSystemService(AlarmManager::class.java)
  private val awake = activity.getSystemService(PowerManager::class.java)
    .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OwnCord:idle")
    .apply { setReferenceCounted(false) }
  private val clock = AwayClock()
  private var armed: AlarmManager.OnAlarmListener? = null

  @Command
  fun awayMs(invoke: Invoke) {
    invoke.resolve(JSObject().apply { put("ms", clock.awayMs(now())) })
  }

  @Command
  fun follow(invoke: Invoke) {
    val args = invoke.parseArgs(IdleFollowArgs::class.java)
    arm(clock.follow(args.thresholdMs, now()))
    invoke.resolve()
  }

  override fun onStop(activity: AppCompatActivity) {
    arm(clock.hide(now()))
  }

  override fun onRestart(activity: AppCompatActivity) {
    clock.show()
    arm(null)
    trigger("look", JSObject())
  }

  override fun onDestroy(activity: AppCompatActivity) {
    arm(null)
  }

  private fun now(): Long = SystemClock.elapsedRealtime()

  // One alarm at most. It is not exact: Android may deliver it late, by up
  // to three quarters of the wait, which costs no permission and little
  // battery. A cancelled alarm can still arrive, and is then not `armed`.
  private fun arm(at: Long?) {
    armed?.let { alarms.cancel(it) }
    armed = null
    if (at == null) return
    val mine = object : AlarmManager.OnAlarmListener {
      override fun onAlarm() {
        if (armed === this) due()
      }
    }
    armed = mine
    alarms.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, at, "OwnCord:idle", mine, null)
  }

  private fun due() {
    armed = null
    val now = now()
    // Android lets the phone sleep again as this returns: hold it awake for
    // the moment the page needs to read the time and send its status.
    awake.acquire(AWAKE_MS)
    NativeLog.info(ExitInfo.awayLook(clock.awayMs(now)))
    arm(clock.nextLook(now))
    trigger("look", JSObject())
  }

  private companion object {
    const val AWAKE_MS = 5_000L
  }
}
