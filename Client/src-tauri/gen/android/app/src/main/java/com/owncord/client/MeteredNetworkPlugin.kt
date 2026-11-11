package com.owncord.client

import android.app.Activity
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

object MeteredMapping {
  fun metered(notMetered: Boolean): Boolean = !notMetered
}

@TauriPlugin
class MeteredNetworkPlugin(private val activity: Activity) : Plugin(activity) {
  private val connectivity = activity.getSystemService(ConnectivityManager::class.java)
  private val main = Handler(Looper.getMainLooper())
  private var registered = false
  private var destroyed = false
  private var reported: Boolean? = null
  private var registrationError: Exception? = null
  private val publish = Runnable {
    if (!destroyed) {
      val value = currentMetered()
      if (value != reported) {
        reported = value
        trigger("metered-changed", JSObject().apply { put("metered", value) })
      }
    }
  }
  private val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = schedule()
    override fun onLost(network: Network) = schedule()
    override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = schedule()
  }

  override fun load(webView: WebView) {
    try {
      // Main-thread delivery also serializes listener registration and destruction.
      connectivity.registerDefaultNetworkCallback(callback, main)
      registered = true
    } catch (error: Exception) {
      registrationError = error
    }
  }

  private fun currentMetered(): Boolean {
    val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return false
    return MeteredMapping.metered(caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
  }

  private fun schedule() {
    if (destroyed) return
    main.removeCallbacks(publish)
    main.postDelayed(publish, 500)
  }

  @Command
  fun isMetered(invoke: Invoke) {
    val error = registrationError
    if (error != null) {
      invoke.reject("network cost unavailable", error)
      return
    }
    try {
      invoke.resolve(JSObject().apply { put("metered", currentMetered()) })
    } catch (error: Exception) {
      invoke.reject("network cost unavailable", error)
    }
  }

  override fun onDestroy(activity: AppCompatActivity) {
    destroyed = true
    main.removeCallbacks(publish)
    if (registered) {
      connectivity.unregisterNetworkCallback(callback)
      registered = false
    }
  }
}
