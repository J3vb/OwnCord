package com.owncord.client

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import java.io.FileOutputStream

// Appends lines to the native log (`owncord-client.log`, which the log plugin
// writes and the support bundle reads). The file is opened by path for each
// line, so a rotation by the log plugin is followed. Rust hands over the path
// at every start (ExitInfoPlugin); it is also kept in preferences, so a crash
// before Rust is up still lands in the last known log.
object NativeLog {
  private const val TAG = "OwnCordExit"
  private const val PREFS = "owncord_exit_info"
  private const val KEY_LOG_FILE = "log_file"
  const val KEY_LAST_EXIT_MS = "last_exit_ms"

  @Volatile private var path: String? = null

  fun prefs(context: Context): SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun load(context: Context) {
    if (path == null) path = prefs(context).getString(KEY_LOG_FILE, null)
  }

  fun setPath(context: Context, logFile: String) {
    path = logFile
    prefs(context).edit().putString(KEY_LOG_FILE, logFile).apply()
  }

  fun warn(message: String) = write("WARN", message)

  fun info(message: String) = write("INFO", message)

  @Synchronized
  private fun write(level: String, message: String) {
    val file = path ?: return
    try {
      FileOutputStream(file, true).use {
        it.write(ExitInfo.line(System.currentTimeMillis(), level, message).toByteArray())
      }
    } catch (e: Exception) {
      Log.w(TAG, "native log not written: ${e.javaClass.name}")
    }
  }

  // Writes one line for an exception nothing caught, then hands it to the
  // handler that was there before (Android's, which ends the process).
  fun installCrashHandler(context: Context) {
    load(context)
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    if (previous is CrashHandler) return
    Thread.setDefaultUncaughtExceptionHandler(CrashHandler(previous))
  }

  private class CrashHandler(
    private val previous: Thread.UncaughtExceptionHandler?,
  ) : Thread.UncaughtExceptionHandler {
    override fun uncaughtException(thread: Thread, error: Throwable) {
      try {
        write("ERROR", ExitInfo.uncaughtMessage(error, thread.name))
      } catch (_: Throwable) {
        // The crash goes on to Android whatever happened here.
      }
      previous?.uncaughtException(thread, error)
    }
  }
}
