package com.owncord.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

class SpikeCallService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel("spike_call", "Spike call", NotificationManager.IMPORTANCE_LOW)
        )
        val notification = Notification.Builder(this, "spike_call")
            .setContentTitle("OwnCord spike")
            .setContentText("Call service running (spike S-3)")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(1, notification)
            }
            Log.i("OwnCordSpike", "foreground service started")
        } catch (e: Exception) {
            Log.e("OwnCordSpike", "foreground service failed: $e")
            SpikeState.lastError = e.toString()
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        Log.i("OwnCordSpike", "foreground service destroyed")
        SpikeState.running = false
        super.onDestroy()
    }
}
