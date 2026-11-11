package com.owncord.client

import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

// A one-at-a-time background worker that a plugin retires when Android
// destroys its activity. After retire() it takes no more work, work still
// queued is cancelled through its own callback so the invoke behind it gets an
// answer, and a task already running can ask isRetired before it reports back.
class RetirableWorker(private val executor: ExecutorService = Executors.newSingleThreadExecutor()) {
  private class Job(val run: () -> Unit, val cancelled: () -> Unit)

  private val lock = Any()
  private val queued = LinkedHashSet<Job>()
  @Volatile private var retired = false

  val isRetired: Boolean get() = retired

  // False when the worker is retired and the task was not accepted.
  fun execute(onCancelled: () -> Unit = {}, task: () -> Unit): Boolean {
    val job = Job(task, onCancelled)
    synchronized(lock) {
      if (retired) return false
      queued.add(job)
      try {
        executor.execute {
          val start = synchronized(lock) { queued.remove(job) }
          if (start) job.run()
        }
      } catch (e: RejectedExecutionException) {
        queued.remove(job)
        return false
      }
    }
    return true
  }

  fun retire() {
    val dropped = synchronized(lock) {
      retired = true
      val pending = queued.toList()
      queued.clear()
      pending
    }
    executor.shutdownNow()
    dropped.forEach { it.cancelled() }
  }
}
