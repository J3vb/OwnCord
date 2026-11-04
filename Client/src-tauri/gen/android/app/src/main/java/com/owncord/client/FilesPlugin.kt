package com.owncord.client

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.annotation.RequiresApi
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.util.concurrent.Executors

@InvokeArg
class FileArgs {
  lateinit var path: String
  lateinit var name: String
  lateinit var mime: String
  lateinit var folder: String
}

@InvokeArg
class ShareTextArgs {
  lateinit var text: String
}

// Where a saved file goes in shared storage, by the folder the Rust side
// picked (files.rs). Kept apart from the plugin so a JVM test can check it.
object SaveTarget {
  const val PICTURES = "Pictures/OwnCord"
  const val DOWNLOADS = "Download"

  fun relativePath(folder: String): String = if (folder == "pictures") PICTURES else DOWNLOADS

  fun isPictures(folder: String): Boolean = folder == "pictures"
}

// Saves and shares the files the Rust side staged in the cache `outgoing/`
// folder (files.rs). A save copies the file into shared storage through
// MediaStore, which needs no storage permission from Android 10 on; Android 9
// has no such door, so there the file goes to the share sheet instead, where
// the user can pick Files or Drive.
@TauriPlugin
class FilesPlugin(private val activity: Activity) : Plugin(activity) {
  // MediaStore copies can be large: off the main thread, one at a time.
  private val io = Executors.newSingleThreadExecutor()

  private fun staged(path: String): File? {
    val file = File(path)
    val outgoing = File(activity.cacheDir, "outgoing").canonicalPath + File.separator
    return if (file.isFile && file.canonicalPath.startsWith(outgoing)) file else null
  }

  @Command
  fun saveFile(invoke: Invoke) {
    val args = invoke.parseArgs(FileArgs::class.java)
    val file = staged(args.path)
    if (file == null) {
      invoke.reject("file to save is missing")
      return
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      try {
        openShareSheet(file, args.name, args.mime)
        invoke.resolve(JSObject().apply { put("status", "shared") })
      } catch (e: Exception) {
        invoke.reject("no app can take the file", e)
      }
      return
    }
    io.execute {
      try {
        writeToMediaStore(file, args)
        invoke.resolve(JSObject().apply { put("status", "saved") })
      } catch (e: Exception) {
        invoke.reject("could not save the file: $e", e)
      }
    }
  }

  @RequiresApi(Build.VERSION_CODES.Q)
  private fun writeToMediaStore(file: File, args: FileArgs) {
    val resolver = activity.contentResolver
    val collection: Uri = if (SaveTarget.isPictures(args.folder)) {
      MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    } else {
      MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    }
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, args.name)
      put(MediaStore.MediaColumns.MIME_TYPE, args.mime)
      put(MediaStore.MediaColumns.RELATIVE_PATH, SaveTarget.relativePath(args.folder))
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(collection, values) ?: throw IOException("storage refused the file")
    try {
      val out = resolver.openOutputStream(uri) ?: throw IOException("storage gave no stream")
      out.use { sink -> FileInputStream(file).use { it.copyTo(sink) } }
      val done = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
      resolver.update(uri, done, null, null)
    } catch (e: Exception) {
      // A half-written entry would show as a broken file in the gallery.
      resolver.delete(uri, null, null)
      throw e
    }
  }

  @Command
  fun shareFile(invoke: Invoke) {
    val args = invoke.parseArgs(FileArgs::class.java)
    val file = staged(args.path)
    if (file == null) {
      invoke.reject("file to share is missing")
      return
    }
    try {
      openShareSheet(file, args.name, args.mime)
      invoke.resolve()
    } catch (e: ActivityNotFoundException) {
      invoke.reject("no app can take the file", e)
    } catch (e: IllegalArgumentException) {
      invoke.reject("file is not shareable", e)
    }
  }

  @Command
  fun shareText(invoke: Invoke) {
    val args = invoke.parseArgs(ShareTextArgs::class.java)
    try {
      val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, args.text)
      }
      activity.startActivity(Intent.createChooser(send, null))
      invoke.resolve()
    } catch (e: ActivityNotFoundException) {
      invoke.reject("no app can take the text", e)
    }
  }

  private fun openShareSheet(file: File, name: String, mime: String) {
    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    val send = Intent(Intent.ACTION_SEND).apply {
      type = mime
      putExtra(Intent.EXTRA_STREAM, uri)
      // The sheet's preview reads the file through this clip.
      clipData = ClipData.newUri(activity.contentResolver, name, uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val chooser = Intent.createChooser(send, null).apply {
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    activity.startActivity(chooser)
  }
}
