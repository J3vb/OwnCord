package com.owncord.client

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.UnifiedPush
import org.unifiedpush.android.connector.data.PushEndpoint

@InvokeArg
class PushRegisterArgs {
  var instance: String = ""
  var vapid: String = ""
  var serverName: String = ""
  var title: String = ""
  var body: String = ""
}

@InvokeArg
class PushInstanceArgs {
  var instance: String = ""
}

@InvokeArg
class PushChooseArgs {
  var distributor: String = ""
}

// Between the push app (the distributor, e.g. ntfy) and the page. A
// registration's answer comes back through OwnCordPushService, possibly after
// the page asked, so the page's call waits here for it. One registration per
// server (the instance is the server's host). Everything runs on the main
// thread.
object PushHub {
  private const val REGISTER_TIMEOUT_MS = 20_000L
  private val main = Handler(Looper.getMainLooper())
  private val pending = HashMap<String, Pair<Invoke, Runnable>>()

  // The plugin of the running page, if there is one, for events.
  var plugin: PushPlugin? = null

  fun await(instance: String, invoke: Invoke) {
    take(instance)?.reject(PushErrors.SUPERSEDED)
    val timeout = Runnable { take(instance)?.reject(PushErrors.TIMEOUT) }
    pending[instance] = invoke to timeout
    main.postDelayed(timeout, REGISTER_TIMEOUT_MS)
  }

  fun endpoint(instance: String, endpoint: PushEndpoint) = main.post {
    val keys = endpoint.pubKeySet
    val invoke = take(instance)
    if (invoke == null) {
      // The push app moved this server's registration by itself: the page
      // sends the new one to the server at its next sign-in, or now.
      plugin?.trigger("endpoint", JSObject().put("instance", instance))
      return@post
    }
    if (keys == null) {
      invoke.reject(PushErrors.NO_KEYS)
      return@post
    }
    invoke.resolve(
      JSObject()
        .put("endpoint", endpoint.url)
        .put("p256dh", keys.pubKey)
        .put("auth", keys.auth),
    )
  }

  fun failed(instance: String, reason: FailedReason) = main.post {
    take(instance)?.reject(PushErrors.FAILED_PREFIX + reason.name)
  }

  fun unregistered(instance: String) = main.post {
    take(instance)?.reject(PushErrors.UNREGISTERED)
    plugin?.trigger("unregistered", JSObject().put("instance", instance))
  }

  private fun take(instance: String): Invoke? {
    val entry = pending.remove(instance) ?: return null
    main.removeCallbacks(entry.second)
    return entry.first
  }
}

object PushErrors {
  const val NO_DISTRIBUTOR = "NO_DISTRIBUTOR"
  const val CHOOSE_DISTRIBUTOR = "CHOOSE_DISTRIBUTOR"
  const val SUPERSEDED = "SUPERSEDED"
  const val TIMEOUT = "TIMEOUT"
  const val NO_KEYS = "NO_KEYS"
  const val UNREGISTERED = "UNREGISTERED"
  const val BAD_KEY = "BAD_KEY"
  const val FAILED_PREFIX = "FAILED_"
}

// Push for a closed app through UnifiedPush: the user's push app (ntfy, or any
// other distributor) holds the connection, and OwnCordPushService shows what
// arrives. No Google service is involved. The page registers each server it
// signs in to, sends the endpoint and keys to that server, and unregisters on
// sign-out.
@TauriPlugin
class PushPlugin(private val activity: Activity) : Plugin(activity) {
  private val context: Context = activity.applicationContext

  override fun load(webView: WebView) {
    PushHub.plugin = this
  }

  // Back from the push app's install page, or from choosing one: the page
  // looks again and registers by itself. The app is on screen now, so the
  // push notifications go: the page shows what is new.
  override fun onResume() {
    PushAlerts.clearAll(context)
    trigger("resume", JSObject())
  }

  override fun onDestroy(activity: AppCompatActivity) {
    if (PushHub.plugin === this) PushHub.plugin = null
  }

  @Command
  fun status(invoke: Invoke) {
    val list = JSArray()
    UnifiedPush.getDistributors(context).forEach { pkg ->
      list.put(JSObject().put("id", pkg).put("name", label(pkg)))
    }
    invoke.resolve(
      JSObject()
        .put("distributors", list)
        .put("current", UnifiedPush.getSavedDistributor(context)),
    )
  }

  @Command
  fun choose(invoke: Invoke) {
    val args = invoke.parseArgs(PushChooseArgs::class.java)
    if (args.distributor !in UnifiedPush.getDistributors(context)) {
      invoke.reject(PushErrors.NO_DISTRIBUTOR)
      return
    }
    UnifiedPush.saveDistributor(context, args.distributor)
    invoke.resolve()
  }

  @Command
  fun register(invoke: Invoke) {
    val args = invoke.parseArgs(PushRegisterArgs::class.java)
    val problem = ensureDistributor()
    if (problem != null) {
      invoke.reject(problem)
      return
    }
    PushStore.save(context, args.instance, args.title, args.body)
    PushHub.await(args.instance, invoke)
    try {
      UnifiedPush.register(context, args.instance, args.serverName, args.vapid)
    } catch (error: Exception) {
      // A key the connector refuses: the server's, not the user's, to fix.
      PushHub.failed(args.instance, FailedReason.VAPID_REQUIRED)
      NativeLog.warn("push register refused: ${error.javaClass.simpleName}")
    }
  }

  @Command
  fun unregister(invoke: Invoke) {
    val args = invoke.parseArgs(PushInstanceArgs::class.java)
    PushAlerts.clear(context, args.instance)
    PushStore.forget(context, args.instance)
    try {
      UnifiedPush.unregister(context, args.instance)
    } catch (error: Exception) {
      NativeLog.warn("push unregister failed: ${error.javaClass.simpleName}")
    }
    invoke.resolve()
  }

  // The saved push app, else the only one installed; null when it is set.
  private fun ensureDistributor(): String? {
    if (UnifiedPush.getSavedDistributor(context) != null) return null
    val all = UnifiedPush.getDistributors(context)
    return when (all.size) {
      0 -> PushErrors.NO_DISTRIBUTOR
      1 -> {
        UnifiedPush.saveDistributor(context, all.first())
        null
      }
      else -> PushErrors.CHOOSE_DISTRIBUTOR
    }
  }

  private fun label(pkg: String): String =
    try {
      val pm = context.packageManager
      pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: PackageManager.NameNotFoundException) {
      pkg
    }
}
