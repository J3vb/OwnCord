package com.owncord.client

import androidx.appcompat.app.AppCompatActivity
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

// Android destroys the activity (rotation, dark mode) while a save waits behind
// a slow copy: the waiting save must get an answer, never run, and the next
// activity's plugin must take work again.
@RunWith(RobolectricTestRunner::class)
class FilesPluginRetireTest {
  private val activity = Robolectric.buildActivity(AppCompatActivity::class.java).get()

  private fun saveArgs(): String {
    val outgoing = File(activity.cacheDir, "outgoing").apply { mkdirs() }
    val file = File(outgoing, "clip.bin").apply { writeBytes(ByteArray(16)) }
    return JSONObject()
      .put("path", file.absolutePath)
      .put("name", "clip.bin")
      .put("mime", "application/octet-stream")
      .put("folder", "downloads")
      .toString()
  }

  private fun closedAnswer(answer: Pair<Boolean, JSONObject>): Boolean =
    !answer.first && answer.second.optString("message").contains("screen was closed")

  @Test
  fun destroyCancelsASaveWaitingBehindASlowCopy() {
    val executor = Executors.newSingleThreadExecutor()
    val worker = RetirableWorker(executor)
    val plugin = FilesPlugin(activity, worker)

    val copying = CountDownLatch(1)
    val release = CountDownLatch(1)
    worker.execute {
      copying.countDown()
      try {
        release.await(5, TimeUnit.SECONDS)
      } catch (e: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    assertTrue(copying.await(5, TimeUnit.SECONDS))

    val waiting = RecordedInvoke(saveArgs())
    plugin.saveFile(waiting.invoke)
    assertTrue(waiting.answers.isEmpty())

    plugin.onDestroy(activity)

    assertTrue(worker.isRetired)
    assertTrue(closedAnswer(waiting.awaitAnswer()))
    release.countDown()
    assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
    assertEquals(1, waiting.answers.size)

    val late = RecordedInvoke(saveArgs())
    plugin.saveFile(late.invoke)
    assertTrue(closedAnswer(late.awaitAnswer()))
  }

  @Test
  fun theNextActivitysPluginTakesWorkAgain() {
    val old = FilesPlugin(activity, RetirableWorker())
    old.onDestroy(activity)

    val fresh = FilesPlugin(activity)
    val save = RecordedInvoke(saveArgs())
    fresh.saveFile(save.invoke)
    assertFalse(closedAnswer(save.awaitAnswer()))
    fresh.onDestroy(activity)
  }
}
