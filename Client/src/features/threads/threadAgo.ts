/**
 * How long ago a thread or forum post last had a message. Lives in the features
 * layer so the forum view (a lower layer) and the thread chip and popover (UI)
 * can share it without a lower layer importing a component.
 */

import { parseTimestamp } from "@lib/text/formatting";
import { messagingText } from "../../i18n/messaging";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now", "3 min ago", "5 h ago", "2 d ago". */
export function threadAgoLabel(iso: string, now: number = Date.now()): string {
  const elapsed = Math.max(0, now - parseTimestamp(iso).getTime());
  if (elapsed < MINUTE_MS) return messagingText("thread.ago.now");
  if (elapsed < HOUR_MS) {
    return messagingText("thread.ago.minutes", { count: Math.floor(elapsed / MINUTE_MS) });
  }
  if (elapsed < DAY_MS) {
    return messagingText("thread.ago.hours", { count: Math.floor(elapsed / HOUR_MS) });
  }
  return messagingText("thread.ago.days", { count: Math.floor(elapsed / DAY_MS) });
}
