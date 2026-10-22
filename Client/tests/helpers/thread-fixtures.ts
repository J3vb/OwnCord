// A ThreadInfo with sensible defaults, for the thread tests.
import type { ThreadInfo } from "../../src/lib/types";

export function makeThread(over: Partial<ThreadInfo> = {}): ThreadInfo {
  return {
    id: 91,
    parent_id: 1,
    name: "Release plan",
    owner_id: 10,
    starter_message_id: 1,
    archived: false,
    locked: false,
    auto_archive_minutes: 1440,
    message_count: 7,
    last_message_at: "2026-10-21T09:30:00Z",
    created_at: "2026-10-20T08:00:00Z",
    ...over,
  };
}
