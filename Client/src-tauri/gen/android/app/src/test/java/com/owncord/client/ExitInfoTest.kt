package com.owncord.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ExitInfoTest {
  // 2026-10-02T16:27:19Z
  private val now = 1_790_958_439_000L

  private fun exit(reason: Int, at: Long, status: Int = 0, importance: Int = 100, rssKb: Long = 0) =
    ExitInfo.Exit(reason, status, importance, at, rssKb)

  @Test
  fun linesMatchTheLogPluginsUtcFormat() {
    assertEquals(
      "[2026-10-02][16:27:19][owncord_client::android][WARN] [exit] hello\n",
      ExitInfo.line(now, "WARN", "[exit] hello"),
    )
  }

  @Test
  fun aLowMemoryKillReadsAsLowMemory() {
    val line = ExitInfo.exitMessage(exit(3, now - 5_000, importance = 400, rssKb = 300 * 1024), now)
    assertEquals(
      "[exit] the previous run ended: kind=low_memory reason=low_memory importance=cached " +
        "age_ms=5000 memory_mb=300 at=2026-10-02T16:27:14Z",
      line,
    )
  }

  @Test
  fun aNativeCrashNamesItsSignal() {
    val line = ExitInfo.exitMessage(exit(5, now, status = 11), now)
    assertTrue(line, line.startsWith("[crash] the previous run crashed: kind=native code=SIGSEGV "))
    assertTrue(ExitInfo.isCrash(5))
    assertTrue(ExitInfo.isCrash(4))
    assertFalse(ExitInfo.isCrash(6))
  }

  @Test
  fun aJvmCrashAndASignalAreTold() {
    assertTrue(ExitInfo.exitMessage(exit(4, now), now).contains("kind=jvm code=exception"))
    assertTrue(ExitInfo.exitMessage(exit(2, now, status = 9), now).contains("kind=signal code=SIGKILL"))
  }

  @Test
  fun everyReasonMapsToTheSharedVocabulary() {
    val kinds = setOf(
      "normal", "signal", "unclean", "anr", "low_memory", "killed_by_user", "killed_by_system", "unknown",
    )
    for (reason in -1..20) {
      assertTrue("reason $reason", ExitInfo.exitKind(reason) in kinds)
    }
    assertEquals("killed_by_user", ExitInfo.exitKind(10))
    assertEquals("anr", ExitInfo.exitKind(6))
    assertEquals("reason_99", ExitInfo.reasonName(99))
    assertEquals("signal_31", ExitInfo.signalName(31))
  }

  @Test
  fun importanceRoundsToTheNextNamedLevel() {
    assertEquals("foreground", ExitInfo.importanceName(100))
    assertEquals("foreground_service", ExitInfo.importanceName(125))
    assertEquals("visible", ExitInfo.importanceName(150))
    assertEquals("cached", ExitInfo.importanceName(400))
    assertEquals("gone", ExitInfo.importanceName(5000))
  }

  @Test
  fun anExitAlreadyReportedIsNotReportedAgain() {
    val exits = listOf(exit(3, 300), exit(4, 200), exit(10, 100))
    assertEquals(listOf(300L), ExitInfo.unreported(exits, 200).map { it.timestampMs })
    assertTrue(ExitInfo.unreported(exits, 300).isEmpty())
  }

  @Test
  fun atMostTheNewestThreeAreReportedOldestFirst() {
    val exits = (1..6).map { exit(3, it * 100L) }.reversed()
    assertEquals(listOf(400L, 500L, 600L), ExitInfo.unreported(exits, 0).map { it.timestampMs })
  }

  @Test
  fun anUncaughtExceptionKeepsClassNamesNotTheMessage() {
    val secret = "token=abc123 https://example.com/invite/XYZ"
    val error = IllegalStateException(secret, RuntimeException(secret))
    val line = ExitInfo.uncaughtMessage(error, "main thread")
    assertFalse(line, line.contains("abc123"))
    assertFalse(line, line.contains("example.com"))
    assertTrue(line, line.startsWith("[crash] uncaught exception: kind=jvm code=java.lang.IllegalStateException"))
    assertTrue(line, line.contains(" cause=java.lang.RuntimeException "))
    assertTrue(line, line.contains(" thread=main_thread "))
    assertTrue(line, line.contains(" module=com.owncord.client.ExitInfoTest."))
  }

  @Test
  fun aCauseLoopEnds() {
    val a = RuntimeException("a")
    val b = IllegalArgumentException("b", a)
    a.initCause(b)
    assertTrue(ExitInfo.uncaughtMessage(a, "t").contains("kind=jvm"))
  }

  @Test
  fun tokensKeepOnlySafeCharacters() {
    assertEquals("a_b_c", ExitInfo.token("a b\nc"))
    assertEquals("unknown", ExitInfo.token(""))
    assertEquals(120, ExitInfo.token("x".repeat(500)).length)
    assertEquals("_", ExitInfo.token("é"))
  }

  @Test
  fun renderGoneTellsCrashFromKill() {
    assertEquals(
      "[webview] render process gone: process=renderer reason=crashed priority=important",
      ExitInfo.renderGoneMessage(true, 2),
    )
    assertTrue(ExitInfo.renderGoneMessage(false, 0).contains("reason=killed priority=waived"))
  }
}
