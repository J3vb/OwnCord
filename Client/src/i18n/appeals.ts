import { defineCatalog } from "./format";

/**
 * Filing, withdrawing and tracking an own appeal (B9-16). Its own catalog so
 * it loads with the Safety tab, not at startup; kinds, appeal states and the
 * ban guidance the BANNED refusal also shows stay in safety.ts.
 */
export const appealsText = defineCatalog("appeals", {
  "appeals.heading": "Appeals",
  "appeals.hint":
    "Your appeal goes only to this server's moderators. You can appeal each action once, and file up to 3 appeals in 24 hours.",
  "appeals.loading": "Loading your appeals…",
  "appeals.loadFailed": "Your appeals couldn't be loaded.",
  "appeals.empty": "You haven't filed any appeals.",
  "appeals.list": "Your appeals",
  "appeals.appeal": "Appeal",
  "appeals.appealLabel": "Appeal {kind}, {date}",
  "appeals.filed": "Filed {date}",
  "appeals.state": "Status: {state}",
  "appeals.decided": "Decided {date}",
  "appeals.note": "Moderator's note: {note}",
  "appeals.overturnedRemoval": "Overturning a removal doesn't restore the removed message.",
  "appeals.erased": "The action this appeal was about no longer exists.",
  "appeals.withdraw": "Withdraw appeal",
  "appeals.withdrawLabel": "Withdraw appeal ({kind}, {date})",
  "appeals.erasedKind": "Deleted action",
  "form.title": "Appeal: {kind}, {date}",
  "form.body": "Why should the moderators reconsider this? (optional)",
  "form.bodyHint":
    "Up to 4,000 characters, or fewer in some scripts and with many symbols. Line breaks are sent as spaces.",
  "form.send": "Send appeal",
  "form.sending": "Sending…",
  "form.cancel": "Cancel",
  "form.sent": "Appeal sent. Its status appears under Appeals.",
  "form.failed": "Your appeal wasn't sent. Try again.",
  "form.alreadyAppealed": "An appeal against this action already exists.",
  "form.rateLimited": "You've filed 3 appeals in the last 24 hours. Try again later.",
  "form.gone": "This action can't be appealed any more.",
  "form.invalid": "Your appeal wasn't accepted: {message}",
  "form.tooLong": "Your appeal is too long to send. Shorten it and try again.",
  "withdraw.title": "Withdraw your appeal ({kind}, {date})?",
  "withdraw.warning": "You can't appeal this action again after withdrawing.",
  "withdraw.confirm": "Withdraw appeal",
  "withdraw.pending": "Withdrawing…",
  "withdraw.keep": "Keep appeal",
  "withdraw.done": "Appeal withdrawn.",
  "withdraw.failed": "Your appeal wasn't withdrawn. Try again.",
  "withdraw.closed": "This appeal can no longer be withdrawn.",
  "withdraw.gone": "This appeal no longer exists.",
});
