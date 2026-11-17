package com.owncord.client

import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

// What the push app (the UnifiedPush distributor) sends: a server's endpoint,
// a push, a refused registration, or the end of one. Android starts it with
// no page running, so a push is shown from here (PushAlerts).
class OwnCordPushService : PushService() {
  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    PushHub.endpoint(instance, endpoint)
  }

  override fun onMessage(message: PushMessage, instance: String) {
    // Only what the connector could decrypt with this registration's keys.
    if (!message.decrypted) return
    PushAlerts.onMessage(applicationContext, instance, String(message.content, Charsets.UTF_8))
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    PushHub.failed(instance, reason)
  }

  override fun onUnregistered(instance: String) {
    PushAlerts.clear(applicationContext, instance)
    PushStore.forget(applicationContext, instance)
    PushHub.unregistered(instance)
  }
}
