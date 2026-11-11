package com.owncord.client

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RetirableWorkerTest {
  @Test
  fun runsWorkUntilRetired() {
    val worker = RetirableWorker()
    val done = CountDownLatch(1)
    assertTrue(worker.execute { done.countDown() })
    assertTrue(done.await(2, TimeUnit.SECONDS))
    worker.retire()
  }

  @Test
  fun rejectsWorkAfterRetire() {
    val worker = RetirableWorker()
    worker.retire()
    var ran = false
    assertFalse(worker.execute { ran = true })
    assertTrue(worker.isRetired)
    assertFalse(ran)
  }

  @Test
  fun cancelsQueuedWorkOnRetire() {
    val worker = RetirableWorker()
    val started = CountDownLatch(1)
    val release = CountDownLatch(1)
    worker.execute {
      started.countDown()
      try {
        release.await(2, TimeUnit.SECONDS)
      } catch (e: InterruptedException) {
        Thread.currentThread().interrupt()
      }
    }
    assertTrue(started.await(2, TimeUnit.SECONDS))
    var queuedRan = false
    var queuedCancelled = false
    assertTrue(worker.execute(onCancelled = { queuedCancelled = true }) { queuedRan = true })
    worker.retire()
    assertTrue(queuedCancelled)
    assertFalse(queuedRan)
  }
}
