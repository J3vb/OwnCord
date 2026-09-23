import { serverTime } from "../features/safety/store";
import { defineCatalog, formatDate } from "./format";

/** Moderation notices and restrictions (B9-15, owner decision Q4). */
export const safetyText = defineCatalog("safety", {
  "banner.label": "Moderation notices",
  "notice.title": "Warning from the moderators",
  "notice.date": "Issued {date}",
  "notice.reason": "Reason: {reason}",
  "notice.noReason": "No reason was given.",
  "notice.acknowledge": "Acknowledge",
  "notice.acknowledging": "Acknowledging…",
  "notice.ackFailed": "Your acknowledgement wasn't recorded. Try again.",
  "notice.viewSafety": "View in Safety settings",
  "toast.warning": "You received a warning from the moderators: {reason}",
  "toast.timeout": "You're timed out until {time}.",
  "toast.lifted": "Your timeout has ended.",
  "toast.acknowledged": "Warning acknowledged.",
  "timeout.composer": "You can't send messages until {time}",
  "timeout.react": "You can't add reactions until {time}",
  "timeout.voice": "You can't join voice until {time}",
  "tab.restrictions": "Current restrictions",
  "tab.none": "You have no active restrictions.",
  "tab.timedOut":
    "You're timed out until {time}. You can't send messages, react or join voice until then.",
  "tab.history": "Moderation history",
  "tab.historyHint":
    "Warnings, timeouts, removed messages and lifted bans on your account. Moderators, reporters and internal notes are never shown.",
  "tab.loading": "Loading your moderation history…",
  "tab.loadFailed": "Your moderation history couldn't be loaded.",
  "tab.retry": "Try again",
  "tab.empty": "Nothing to show.",
  "kind.warning": "Warning",
  "kind.timeout": "Timeout",
  "kind.removal": "Message removed",
  "kind.ban": "Ban",
  "status.acknowledged": "Acknowledged",
  "status.unacknowledged": "Not yet acknowledged",
  "status.activeUntil": "Active until {time}",
  "status.lifted": "Lifted {date}",
  "status.ended": "Ended {date}",
  "status.appeal": "Appeal: {state}",
  "appeal.open": "open",
  "appeal.assigned": "under review",
  "appeal.upheld": "upheld",
  "appeal.overturned": "overturned",
  "appeal.withdrawn": "withdrawn",
});

/** A server timestamp as a date and time, e.g. "Sep 23, 2026, 2:05 PM". */
export function formatWhen(raw: string): string {
  return formatDate(serverTime(raw), { dateStyle: "medium", timeStyle: "short" });
}

/** An expiry: only the time when it is today, else the date and time. */
export function formatUntil(raw: string, now: number = Date.now()): string {
  const at = serverTime(raw);
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? formatDate(at, { timeStyle: "short" }) : formatWhen(raw);
}
