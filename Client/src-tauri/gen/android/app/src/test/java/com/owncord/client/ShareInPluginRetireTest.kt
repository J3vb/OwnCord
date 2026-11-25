package com.owncord.client

import android.content.Intent
import android.net.Uri
import androidx.appcompat.app.AppCompatActivity
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf

// A share from another app is still copying when Android destroys the
// activity: the copy's late result must not reach the old plugin, and the next
// activity's plugin must take a new share.
@RunWith(RobolectricTestRunner::class)
class ShareInPluginRetireTest {
  private val activity = Robolectric.buildActivity(AppCompatActivity::class.java).get()

  // Blocks on the first read until released, like a slow cloud provider.
  private class SlowStream(val reading: CountDownLatch, val release: CountDownLatch) : InputStream() {
    private var sent = false

    override fun read(): Int {
      reading.countDown()
      release.await(5, TimeUnit.SECONDS)
      if (sent) return -1
      sent = true
      return 'x'.code
    }
  }

  private fun shareOf(uri: Uri): Intent =
    Intent(Intent.ACTION_SEND).setType("image/jpeg").putExtra(Intent.EXTRA_STREAM, uri)

  private fun take(plugin: ShareInPlugin) = RecordedInvoke().also { plugin.takeShare(it.invoke) }.awaitAnswer().second

  @Test
  fun destroyDropsTheResultOfACopyStillRunning() {
    val uri = Uri.parse("content://com.example.slow/photo.jpg")
    val reading = CountDownLatch(1)
    val release = CountDownLatch(1)
    shadowOf(activity.applicationContext.contentResolver).registerInputStream(uri, SlowStream(reading, release))

    val executor = Executors.newSingleThreadExecutor()
    val worker = RetirableWorker(executor)
    val plugin = ShareInPlugin(activity, worker)
    plugin.onNewIntent(shareOf(uri))
    assertTrue(reading.await(5, TimeUnit.SECONDS))
    assertTrue(take(plugin).getBoolean("copying"))

    plugin.onDestroy(activity)

    assertTrue(worker.isRetired)
    release.countDown()
    assertTrue(executor.awaitTermination(5, TimeUnit.SECONDS))
    val after = take(plugin)
    assertFalse(after.has("share"))
    assertFalse(after.getBoolean("copying"))

    plugin.onNewIntent(shareOf(uri))
    assertFalse(take(plugin).getBoolean("copying"))
  }

  @Test
  fun theNextActivitysPluginTakesANewShare() {
    val uri = Uri.parse("content://com.example.fast/note.txt")
    shadowOf(activity.applicationContext.contentResolver)
      .registerInputStream(uri, ByteArrayInputStream("hello".toByteArray()))
    ShareInPlugin(activity, RetirableWorker()).onDestroy(activity)

    val worker = RetirableWorker()
    val fresh = ShareInPlugin(activity, worker)
    fresh.onNewIntent(shareOf(uri))
    val copied = CountDownLatch(1)
    worker.execute { copied.countDown() }
    assertTrue(copied.await(5, TimeUnit.SECONDS))

    val share = take(fresh).getJSONObject("share")
    assertEquals(1, share.getJSONArray("files").length())
    fresh.onDestroy(activity)
  }
}
