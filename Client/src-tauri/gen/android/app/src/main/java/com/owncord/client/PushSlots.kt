package com.owncord.client

// Which notification each server's "new messages" push shows under, and what
// a push asks for. No Android types, so both are unit tested on the JVM.
object PushSlots {
  const val FIRST_ID = 4200
  const val COUNT = 100

  // The id `instance` already has, else the lowest free one; null when every
  // id is taken. A server keeps its id, so its next push replaces its last.
  fun idFor(instance: String, taken: Map<String, Int>): Int? {
    taken[instance]?.let { return it }
    val used = taken.values.toSet()
    return (FIRST_ID until FIRST_ID + COUNT).firstOrNull { it !in used }
  }
}

object PushPayload {
  const val ACTIVITY = "activity"
  const val RING = "ring"
  const val RING_END = "ring_end"

  private val kind = Regex("\"t\"\\s*:\\s*\"([a-z_]{1,32})\"")
  private val channel = Regex("\"c\"\\s*:\\s*([0-9]{1,18})(?![0-9])")

  // The kind of push (`{"t":"activity"}`), or null for anything else. The
  // server sends no message text or sender.
  fun kindOf(content: String): String? = kind.find(content)?.groupValues?.get(1)

  // The DM a ring is for (`{"t":"ring","c":42}`), or null when there is none.
  fun channelOf(content: String): Long? =
    channel.find(content)?.groupValues?.get(1)?.toLongOrNull()?.takeIf { it > 0 }
}

// What a call's push does on the phone. A ring shows the incoming call only
// while the app is out of view and nothing rings for that DM yet: an app on
// screen, or one whose page already rang, has it in hand. The end of a ring
// always takes it down, whoever put it up.
object PushRingRule {
  enum class Step { RING, END, NONE }

  fun step(kind: String?, channelId: Long?, onScreen: Boolean, alreadyUp: Boolean): Step = when {
    channelId == null -> Step.NONE
    kind == PushPayload.RING_END -> Step.END
    kind == PushPayload.RING && !onScreen && !alreadyUp -> Step.RING
    else -> Step.NONE
  }
}
