package com.owncord.client

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.webkit.WebView
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.concurrent.Executors

// The rules for a shared file's name, apart from the plugin so a JVM test can
// check them.
object SharedName {
  // File systems stop at 255 bytes; UTF-8 names (CJK, emoji) take up to 4 per character.
  const val MAX_NAME_BYTES = 200
  private const val FALLBACK = "shared"

  // A file name from what the sending app called it: its last path segment,
  // without control or reserved characters or leading dots, with `ext` added
  // when it has none (a gallery often names a photo "1000012345").
  fun of(displayName: String?, ext: String?, index: Int): String {
    val last = (displayName ?: "").substringAfterLast('/').substringAfterLast('\\')
    val cleaned = last.filter { !it.isISOControl() && it !in "<>:\"|?*" }
      .trim().trimStart('.').trimEnd('.', ' ')
    val base = cleaned.ifEmpty { if (index == 0) FALLBACK else "$FALLBACK-${index + 1}" }
    val withExt = if (!ext.isNullOrEmpty() && !base.contains('.')) "$base.$ext" else base
    if (utf8Bytes(withExt) <= MAX_NAME_BYTES) return withExt
    val dot = withExt.lastIndexOf('.')
    val tail = if (dot > 0 && withExt.length - dot <= 16) withExt.substring(dot) else ""
    val stem = withExt.substring(0, withExt.length - tail.length)
    val budget = MAX_NAME_BYTES - utf8Bytes(tail)
    var end = 0
    var used = 0
    while (end < stem.length) {
      val next = stem.offsetByCodePoints(end, 1)
      val bytes = utf8Bytes(stem.substring(end, next))
      if (used + bytes > budget) break
      used += bytes
      end = next
    }
    return stem.substring(0, end) + tail
  }

  fun utf8Bytes(text: String): Int = text.toByteArray(Charsets.UTF_8).size

  // The text of a share: EXTRA_TEXT, or the subject when the app sent only that.
  fun text(text: CharSequence?, subject: String?): String {
    val body = text?.toString()?.trim().orEmpty()
    return body.ifEmpty { subject?.trim().orEmpty() }
  }
}

// Shares from other apps ("Share" > OwnCord). Android lends the shared
// content:// URIs only while this activity lives, so each file is copied into
// the cache `incoming/` folder at once; the webview takes the share
// (take_shared in share_in.rs), shows the "Send to" sheet and reads the files
// through the host's staged-file door. While a copy runs, takeShare says so
// and the webview asks again shortly. One share at a time: a new one
// replaces the last, and a share nobody took within ten minutes is dropped.
@TauriPlugin
class ShareInPlugin(private val activity: Activity) : Plugin(activity) {
  private val io = Executors.newSingleThreadExecutor()
  private val lock = Any()
  private var generation = 0
  private var ready: JSObject? = null
  private var readyAt = 0L
  // A share whose files are still being copied: the webview asks again shortly.
  private var copying = false

  override fun load(webView: WebView) {
    super.load(webView)
    val intent = activity.intent
    // Reopening the app from Recents replays the intent that started it.
    val fresh = intent != null && intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY == 0
    if (fresh && receive(intent!!)) {
      // Taken: a reload of the webview must not offer the same share again.
      activity.intent = Intent(Intent.ACTION_MAIN)
    } else {
      // An earlier run's share nobody sent stays out of the cache.
      io.execute { File(activity.cacheDir, INCOMING_DIR).deleteRecursively() }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    receive(intent)
  }

  // True when `intent` was a share.
  private fun receive(intent: Intent): Boolean {
    val action = intent.action
    if (action != Intent.ACTION_SEND && action != Intent.ACTION_SEND_MULTIPLE) return false
    val uris = sharedUris(intent, action)
    val text = SharedName.text(
      intent.getCharSequenceExtra(Intent.EXTRA_TEXT),
      intent.getStringExtra(Intent.EXTRA_SUBJECT),
    )
    if (uris.isEmpty() && text.isEmpty()) return false
    val gen = synchronized(lock) {
      generation += 1
      ready = null
      copying = true
      generation
    }
    io.execute {
      val share = try {
        copyShare(gen, uris, text)
      } catch (e: Exception) {
        NativeLog.info("share: not copied: $e")
        null
      }
      synchronized(lock) {
        if (gen != generation) return@execute
        copying = false
        if (share == null) return@execute
        ready = share
        readyAt = SystemClock.elapsedRealtime()
      }
      // Only this share's folder and the one before it (whose files a chat
      // may still be reading) stay.
      File(activity.cacheDir, INCOMING_DIR).listFiles()?.forEach { old ->
        val n = old.name.toIntOrNull()
        if (n == null || n < gen - 1) old.deleteRecursively()
      }
    }
    return true
  }

  @Suppress("DEPRECATION")
  private fun sharedUris(intent: Intent, action: String): List<Uri> {
    val found = if (action == Intent.ACTION_SEND_MULTIPLE) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM)
      }?.toList().orEmpty()
    } else {
      val one = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
      } else {
        intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)
      }
      listOfNotNull(one)
    }
    // Only content the sending app lends us; a file:// URI would name our own
    // private files.
    return found.filter { it.scheme == "content" }.take(MAX_FILES)
  }

  private fun copyShare(gen: Int, uris: List<Uri>, text: String): JSObject {
    val dir = File(File(activity.cacheDir, INCOMING_DIR), gen.toString())
    dir.deleteRecursively()
    val files = JSArray()
    val oversized = JSArray()
    val resolver = activity.contentResolver
    uris.forEachIndexed { index, uri ->
      // A newer share replaced this one: stop copying.
      if (synchronized(lock) { gen != generation }) return@forEachIndexed
      var displayName: String? = null
      var size = -1L
      resolver.query(uri, null, null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameCol = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          val sizeCol = cursor.getColumnIndex(OpenableColumns.SIZE)
          if (nameCol >= 0 && !cursor.isNull(nameCol)) displayName = cursor.getString(nameCol)
          if (sizeCol >= 0 && !cursor.isNull(sizeCol)) size = cursor.getLong(sizeCol)
        }
      }
      val ext = resolver.getType(uri)?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
      val name = SharedName.of(displayName ?: uri.lastPathSegment, ext, index)
      if (size > MAX_COPY_BYTES) {
        oversized.put(JSObject().apply {
          put("name", name)
          put("size", size)
        })
        return@forEachIndexed
      }
      // One folder per file, so two files of the same name both arrive.
      val target = File(File(dir, index.toString()), name)
      try {
        target.parentFile?.mkdirs()
        val input = resolver.openInputStream(uri) ?: return@forEachIndexed
        val copied = input.use { source -> target.outputStream().use { copyCapped(source, it) } }
        if (copied < 0) {
          target.delete()
          oversized.put(JSObject().apply {
            put("name", name)
            put("size", MAX_COPY_BYTES + 1)
          })
          return@forEachIndexed
        }
        files.put(target.absolutePath)
      } catch (e: Exception) {
        target.delete()
        NativeLog.info("share: a file was not copied: $e")
      }
    }
    return JSObject().apply {
      put("text", text)
      put("files", files)
      put("oversized", oversized)
    }
  }

  // Bytes copied, or -1 once the source runs past MAX_COPY_BYTES (a provider
  // that reported no size).
  private fun copyCapped(source: java.io.InputStream, sink: java.io.OutputStream): Long {
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
      val read = source.read(buffer)
      if (read < 0) return total
      total += read
      if (total > MAX_COPY_BYTES) return -1
      sink.write(buffer, 0, read)
    }
  }

  @Command
  fun takeShare(invoke: Invoke) {
    val share = synchronized(lock) {
      val taken = ready
      ready = null
      if (taken != null && SystemClock.elapsedRealtime() - readyAt > KEEP_MS) null else taken
    }
    val pending = synchronized(lock) { copying }
    invoke.resolve(
      JSObject().apply {
        if (share != null) put("share", share)
        put("copying", pending)
      },
    )
  }

  companion object {
    // Shared with share_in.rs, which reads only files in this folder.
    const val INCOMING_DIR = "incoming"
    // The composer takes ten attachments.
    private const val MAX_FILES = 10
    // The host reads no larger file (file_transfer.rs).
    private const val MAX_COPY_BYTES = 1024L * 1024L * 1024L
    private const val KEEP_MS = 10L * 60L * 1000L
  }
}
