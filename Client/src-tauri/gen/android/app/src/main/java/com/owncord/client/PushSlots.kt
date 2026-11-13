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

  private val kind = Regex("\"t\"\\s*:\\s*\"([a-z_]{1,32})\"")

  // The kind of push (`{"t":"activity"}`), or null for anything else. The
  // server sends no message text, sender or channel.
  fun kindOf(content: String): String? = kind.find(content)?.groupValues?.get(1)
}
