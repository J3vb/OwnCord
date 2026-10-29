import { serverNow, serverTime } from "../features/safety/store";
import { defineCatalog, formatDate } from "./format";

/** Moderation notices and restrictions. */
export const safetyText = defineCatalog("safety", {
  "banner.label": "Moderation notices",
  "notice.title": "Warning from the moderators",
  "notice.date": "Issued {date}",
  "notice.reason": "Reason: {reason}",
  "notice.noReason": "No reason was given.",
  "notice.acknowledge": "Acknowledge",
  "notice.acknowledging": "Acknowledging…",
  "notice.ackFailed": "Your acknowledgement wasn't recorded. Try again.",
  "notice.viewSafety": "View in Privacy & Safety settings",
  "toast.warning": "You received a warning from the moderators: {reason}",
  "toast.timeout": "You're timed out until {time}.",
  "toast.acknowledged": "Warning acknowledged.",
  "timeout.composer": "You can't send messages until {time}",
  "timeout.react": "You can't add reactions until {time}",
  "timeout.voice": "You can't join voice until {time}",
  "tab.standingOk": "Your account is in good standing.",
  "tab.activeRestrictions": {
    one: "{count} active restriction",
    other: "{count} active restrictions",
  },
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
  "dmPrivacy.title": "Direct messages",
  "dmPrivacy.desc":
    "Choose who can start a direct message with you. People you've already accepted or messaged first can still reach you.",
  "dmPrivacy.loading": "Loading your direct message settings…",
  "dmPrivacy.loadFailed": "Couldn't load your direct message settings.",
  "dmPrivacy.retry": "Retry",
  "dmPrivacy.saveFailed": "Couldn't save that change. Your settings are unchanged.",
  "dmPrivacy.allow.label": "Allow direct messages from server members",
  "dmPrivacy.allow.desc":
    "When this is off, members you haven't accepted or messaged first can't start a direct message with you.",
  "dmPrivacy.requests.label": "Message requests",
  "dmPrivacy.requests.desc":
    "When this is off, a first message from someone you haven't accepted goes straight to your direct messages instead of Requests. A request you already ignored stays ignored.",
  "dmPrivacy.requests.disabledHint": "Turn on direct messages from server members to change this.",
  "appeals.unavailable":
    "Kicks can't be appealed. While a ban is in effect you can't sign in to appeal here: contact the server's operator directly. Once a ban ends, it appears in your history and can be appealed.",
});

/** A server timestamp as a date and time, e.g. "Sep 23, 2026, 2:05 PM". */
export function formatWhen(raw: string): string {
  return formatDate(serverTime(raw), { dateStyle: "medium", timeStyle: "short" });
}

/** An expiry: only the time when it is today, else the date and time. */
export function formatUntil(raw: string, now: number = serverNow()): string {
  const at = serverTime(raw);
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  return sameDay ? formatDate(at, { timeStyle: "short" }) : formatWhen(raw);
}
