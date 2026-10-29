package com.owncord.client

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= 33 &&
        checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 7)
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    webView.addJavascriptInterface(SpikeBridge(this), "OwnCordSpike")
    val script = assets.open("spike-panel.js").bufferedReader().use { it.readText() }
    val inject = object : Runnable {
      override fun run() {
        webView.evaluateJavascript(script, null)
        webView.postDelayed(this, 3000)
      }
    }
    webView.postDelayed(inject, 3000)
  }
}
