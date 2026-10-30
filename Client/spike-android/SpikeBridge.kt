package com.owncord.client

import android.app.Activity
import android.content.Intent
import android.os.BatteryManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject
import java.io.File

object SpikeState {
    @Volatile var running = false
    @Volatile var startedAt = 0L
    @Volatile var batteryAtStart = -1
    @Volatile var lastError = ""
}

class SpikeBridge(private val activity: Activity) {
    private fun battery(): Int =
        activity.getSystemService(BatteryManager::class.java)
            .getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)

    @JavascriptInterface
    fun startCallService(): String {
        SpikeState.lastError = ""
        SpikeState.startedAt = SystemClock.elapsedRealtime()
        SpikeState.batteryAtStart = battery()
        SpikeState.running = true
        val intent = Intent(activity, SpikeCallService::class.java)
        return try {
            if (Build.VERSION.SDK_INT >= 26) activity.startForegroundService(intent) else activity.startService(intent)
            Log.i("OwnCordSpike", "start requested, battery ${SpikeState.batteryAtStart}%")
            "ok"
        } catch (e: Exception) {
            SpikeState.running = false
            SpikeState.lastError = e.toString()
            e.toString()
        }
    }

    @JavascriptInterface
    fun stopCallService(): String {
        activity.stopService(Intent(activity, SpikeCallService::class.java))
        SpikeState.running = false
        return "ok"
    }

    @JavascriptInterface
    fun status(): String {
        val o = JSONObject()
        o.put("running", SpikeState.running)
        o.put("minutes", if (SpikeState.startedAt > 0) (SystemClock.elapsedRealtime() - SpikeState.startedAt) / 60000.0 else 0.0)
        o.put("batteryStart", SpikeState.batteryAtStart)
        o.put("batteryNow", battery())
        o.put("error", SpikeState.lastError)
        o.put("device", "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        o.put("webview", WebView.getCurrentWebViewPackage()?.versionName ?: "?")
        return o.toString()
    }

    @JavascriptInterface
    fun diag(): String {
        val root = activity.filesDir.parentFile ?: activity.filesDir
        val out = StringBuilder("data dir: ${root.path}\n")
        val logs = mutableListOf<File>()
        root.walkTopDown().maxDepth(5).forEach { f ->
            if (f.isFile && !f.path.contains("/cache/") && !f.path.contains("/code_cache/") && !f.path.contains("/app_webview/")) {
                out.append("file ${f.path.removePrefix(root.path)} (${f.length()} B)\n")
                if (f.name.endsWith(".log")) logs.add(f)
            }
        }
        val pattern = Regex("(?i)secret|credential|keyring|fallback|json_store|remember|auto.?login|error")
        for (f in logs) {
            val lines = f.readLines().filter { pattern.containsMatchIn(it) }.takeLast(60)
            out.append("--- ${f.name}: ${lines.size} matching lines\n")
            lines.forEach { out.append(it.take(400)).append("\n") }
        }
        return out.toString()
    }
}
