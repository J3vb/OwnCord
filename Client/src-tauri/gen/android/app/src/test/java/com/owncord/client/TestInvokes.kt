package com.owncord.client

import app.tauri.plugin.Invoke
import com.fasterxml.jackson.databind.ObjectMapper
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

// An invoke whose answers a test can read: each is (resolved?, payload).
class RecordedInvoke(args: String = "{}") {
  private val answered = CountDownLatch(1)
  val answers = CopyOnWriteArrayList<Pair<Boolean, JSONObject>>()

  val invoke = Invoke(1L, "test", RESOLVE, REJECT, { callback, data ->
    answers.add(Pair(callback == RESOLVE, JSONObject(data)))
    answered.countDown()
  }, args, ObjectMapper())

  fun awaitAnswer(): Pair<Boolean, JSONObject> {
    check(answered.await(5, TimeUnit.SECONDS)) { "no answer" }
    return answers.first()
  }

  private companion object {
    const val RESOLVE = 10L
    const val REJECT = 20L
  }
}
