package com.owncord.client

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class InstallApkArgs {
  lateinit var path: String
}

// Opens Android's package installer on an update APK the Rust side has already
// downloaded and signature-checked (update_commands/android.rs). Android shows
// its own Install prompt; an app installed outside a store cannot skip it.
@TauriPlugin
class ApkInstallerPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun installApk(invoke: Invoke) {
    val args = invoke.parseArgs(InstallApkArgs::class.java)
    val apk = File(args.path)
    val updates = File(activity.cacheDir, "updates")
    if (!apk.isFile || apk.parentFile?.canonicalPath != updates.canonicalPath) {
      invoke.reject("update file is missing")
      return
    }

    val result = JSObject()
    try {
      if (!activity.packageManager.canRequestPackageInstalls()) {
        val settings = Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${activity.packageName}")
        )
        activity.startActivity(settings)
        result.put("status", "permission_needed")
        invoke.resolve(result)
        return
      }

      val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", apk)
      val install = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(install)
      result.put("status", "installer_opened")
      invoke.resolve(result)
    } catch (e: ActivityNotFoundException) {
      invoke.reject("no app can install the update", e)
    } catch (e: IllegalArgumentException) {
      invoke.reject("update file is not shareable", e)
    }
  }
}
