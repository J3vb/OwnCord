package com.owncord.client

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

// Keeps a call alive while the app is in the background or the screen is off.
// Android silences the mic of a background app and may freeze its process
// unless a foreground service with a visible notification says the app is in
// use. The camera type is added only while the camera is on, and only when
// its permission is granted: Android refuses the whole start otherwise.
class CallService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val camera = intent?.getBooleanExtra(EXTRA_CAMERA, false) ?: false
    try {
      goForeground(camera)
    } catch (e: Exception) {
      // A refused start (no permission, or the app was not in front) must not
      // take the call down: the call goes on, it just may stop in background.
      Log.w(TAG, "foreground start refused: $e")
      stopSelf()
      return START_NOT_STICKY
    }
    holdWakeLock()
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  private fun goForeground(camera: Boolean) {
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification)
      return
    }
    var types = 0
    if (granted(Manifest.permission.RECORD_AUDIO)) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }
    if (camera && granted(Manifest.permission.CAMERA)) {
      types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
    }
    if (types == 0) {
      throw SecurityException("no microphone or camera permission")
    }
    startForeground(NOTIFICATION_ID, notification, types)
  }

  private fun granted(permission: String): Boolean =
    checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  private fun buildNotification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while you are in a call"
        setShowBadge(false)
      }
    )
    val open = Intent(this, MainActivity::class.java).apply {
      flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT
    }
    val tap = PendingIntent.getActivity(
      this, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )
    return Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("OwnCord")
      .setContentText("In a call")
      .setSmallIcon(R.drawable.ic_call_notification)
      .setContentIntent(tap)
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_CALL)
      .build()
  }

  // Screen off: the CPU may sleep between audio buffers on some phones, which
  // drops the connection. Held only while the service runs.
  private fun holdWakeLock() {
    if (wakeLock?.isHeld == true) return
    val power = getSystemService(PowerManager::class.java)
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "OwnCord:call").apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  companion object {
    private const val TAG = "OwnCordCall"
    private const val CHANNEL_ID = "calls"
    private const val NOTIFICATION_ID = 4101
    const val EXTRA_CAMERA = "camera"

    fun start(context: Context, camera: Boolean) {
      val intent = Intent(context, CallService::class.java).putExtra(EXTRA_CAMERA, camera)
      context.startForegroundService(intent)
    }

    fun stop(context: Context) {
      context.stopService(Intent(context, CallService::class.java))
    }
  }
}
