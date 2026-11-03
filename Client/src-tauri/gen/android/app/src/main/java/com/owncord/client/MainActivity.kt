package com.owncord.client

import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // First, so a crash anywhere after it leaves a line in the native log.
    NativeLog.installCrashHandler(this)
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }
}
