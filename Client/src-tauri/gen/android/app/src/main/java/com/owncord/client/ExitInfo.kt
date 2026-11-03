package com.owncord.client

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

// The text of the crash and exit lines the Android app adds to the native log.
// Pure functions over plain values (no Android types), so they are unit tested
// on the JVM. Every value is a code, a number or a class name: never an
// exception message or the system's free-text description, which can hold a
// URL or message text.
object ExitInfo {
  // How many earlier exits one start reports at most.
  const val MAX_REPORTED = 3

  // The log plugin's target column for these lines.
  private const val TARGET = "owncord_client::android"

  // ApplicationExitInfo.REASON_* values (stable Android API constants).
  private val REASONS = mapOf(
    0 to "unknown",
    1 to "exit_self",
    2 to "signaled",
    3 to "low_memory",
    4 to "crash",
    5 to "crash_native",
    6 to "anr",
    7 to "initialization_failure",
    8 to "permission_change",
    9 to "excessive_resource_usage",
    10 to "user_requested",
    11 to "user_stopped",
    12 to "dependency_died",
    13 to "other",
    14 to "freezer",
    15 to "package_state_change",
    16 to "package_updated",
  )

  private val SIGNALS = mapOf(
    1 to "SIGHUP",
    2 to "SIGINT",
    3 to "SIGQUIT",
    4 to "SIGILL",
    5 to "SIGTRAP",
    6 to "SIGABRT",
    7 to "SIGBUS",
    8 to "SIGFPE",
    9 to "SIGKILL",
    11 to "SIGSEGV",
    13 to "SIGPIPE",
    15 to "SIGTERM",
  )

  // RunningAppProcessInfo.IMPORTANCE_* values, most important first.
  private val IMPORTANCE = listOf(
    100 to "foreground",
    125 to "foreground_service",
    200 to "visible",
    230 to "perceptible",
    300 to "service",
    325 to "cant_save_state",
    400 to "cached",
    1000 to "gone",
  )

  fun reasonName(reason: Int): String = REASONS[reason] ?: "reason_$reason"

  fun signalName(signal: Int): String = SIGNALS[signal] ?: "signal_$signal"

  fun importanceName(importance: Int): String =
    IMPORTANCE.firstOrNull { importance <= it.first }?.second ?: "gone"

  // The `kind` of the diagnostics vocabulary for an exit reason.
  fun exitKind(reason: Int): String = when (reason) {
    1 -> "normal"
    2 -> "signal"
    3 -> "low_memory"
    6 -> "anr"
    7 -> "unclean"
    10, 11 -> "killed_by_user"
    8, 9, 12, 13, 14, 15, 16 -> "killed_by_system"
    else -> "unknown"
  }

  fun isCrash(reason: Int): Boolean = reason == 4 || reason == 5

  // One earlier exit, as reported by ApplicationExitInfo.
  data class Exit(
    val reason: Int,
    val status: Int,
    val importance: Int,
    val timestampMs: Long,
    val rssKb: Long,
  )

  // The exits not reported yet, oldest first, at most MAX_REPORTED of the
  // newest. `exits` comes newest first, as Android returns it.
  fun unreported(exits: List<Exit>, lastReportedMs: Long): List<Exit> =
    exits.filter { it.timestampMs > lastReportedMs }
      .sortedByDescending { it.timestampMs }
      .take(MAX_REPORTED)
      .reversed()

  fun exitMessage(exit: Exit, nowMs: Long): String {
    val common = "importance=${importanceName(exit.importance)} " +
      "age_ms=${(nowMs - exit.timestampMs).coerceAtLeast(0)} " +
      "memory_mb=${exit.rssKb / 1024} at=${isoUtc(exit.timestampMs)}"
    return when (exit.reason) {
      4 -> "[crash] the previous run crashed: kind=jvm code=exception $common"
      5 -> "[crash] the previous run crashed: kind=native code=${signalName(exit.status)} $common"
      2 -> "[exit] the previous run ended: kind=signal code=${signalName(exit.status)} " +
        "reason=${reasonName(exit.reason)} $common"
      else -> "[exit] the previous run ended: kind=${exitKind(exit.reason)} " +
        "reason=${reasonName(exit.reason)} $common"
    }
  }

  fun notAvailableMessage(sdk: Int): String =
    "[exit] exit reasons not available on this Android version (API $sdk)"

  fun nothingNewMessage(): String = "[exit] no earlier exit to report since the last start"

  fun readFailedMessage(error: Throwable): String =
    "[exit] exit reasons could not be read: ${token(error.javaClass.name)}"

  // An exception nothing caught. The class names of the exception, its root
  // cause and the top app frame, never the message.
  fun uncaughtMessage(error: Throwable, thread: String): String {
    var root = error
    var depth = 0
    while (depth < 16) {
      val cause = root.cause ?: break
      if (cause === root) break
      root = cause
      depth++
    }
    val frame = (error.stackTrace.firstOrNull { it.className.startsWith("com.owncord.") }
      ?: error.stackTrace.firstOrNull())
      ?.let { "${it.className}.${it.methodName}:${it.lineNumber}" }
      ?: "unknown"
    val cause = if (root === error) "" else " cause=${token(root.javaClass.name)}"
    return "[crash] uncaught exception: kind=jvm code=${token(error.javaClass.name)}" +
      "$cause thread=${token(thread)} module=${token(frame)}"
  }

  fun renderGoneMessage(didCrash: Boolean, priority: Int): String {
    val reason = if (didCrash) "crashed" else "killed"
    val level = when (priority) {
      0 -> "waived"
      1 -> "bound"
      2 -> "important"
      else -> "unknown"
    }
    return "[webview] render process gone: process=renderer reason=$reason priority=$level"
  }

  fun callServiceStarted(mic: Boolean, camera: Boolean): String =
    "[call] call service in the foreground: mic=$mic camera=$camera"

  fun callServiceRefused(error: Throwable): String =
    "[call] call service start refused: ${token(error.javaClass.name)}"

  fun callServiceStopped(): String = "[call] call service stopped"

  fun appVisibility(visible: Boolean): String =
    if (visible) "[app] back in front" else "[app] moved to the background"

  // A line in the log plugin's format (UTC):
  // `[YYYY-MM-DD][HH:MM:SS][target][LEVEL] message`.
  fun line(nowMs: Long, level: String, message: String): String {
    val stamp = SimpleDateFormat("'['yyyy-MM-dd']['HH:mm:ss']'", Locale.ROOT)
      .apply { timeZone = TimeZone.getTimeZone("UTC") }
      .format(Date(nowMs))
    return "$stamp[$TARGET][$level] $message\n"
  }

  private fun isoUtc(ms: Long): String =
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT)
      .apply { timeZone = TimeZone.getTimeZone("UTC") }
      .format(Date(ms))

  // Keeps a value to one token: letters, digits and `._:$-`, at most 120.
  fun token(value: String): String {
    val kept = value.map { c ->
      if (c.isLetterOrDigit() && c.code < 128 || c in "._:\$-") c else '_'
    }.joinToString("")
    return kept.take(120).ifEmpty { "unknown" }
  }
}
