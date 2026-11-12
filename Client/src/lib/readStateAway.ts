// Whether the reader is watching a channel: the window's focus, its loaded
// window and the list's scroll position, and whether something covers the chat.
// Owns the scroll flags and reads two stores; readState.ts holds the rest.
import { isWindowDetached } from "@stores/messages.store";
import { uiStore } from "@stores/ui.store";
import { dialogOpen } from "./ui/dialogOpen";

/** Channels whose mounted list is scrolled away from the live tail. */
const liveTailOutOfView = new Set<number>();

/** Record whether the mounted list for a channel shows its live tail. */
export function setTailInView(channelId: number, inView: boolean): void {
  if (inView) liveTailOutOfView.delete(channelId);
  else liveTailOutOfView.add(channelId);
}

/** The app window is not focused, or the channel's loaded window is detached from the live tail. */
export function isWindowAway(channelId: number): boolean {
  return !document.hasFocus() || isWindowDetached(channelId);
}

/**
 * Whether the reader is away from a channel: its loaded window is detached from
 * the live tail, the list is scrolled away from the tail, or the app window is
 * not focused. "Active" only means "the reader is watching" when this
 * is false, so a message landing while away counts as unread and a `ready`
 * resync must not mark the channel read. The focus source is
 * `document.hasFocus()`, as in `lib/notifications.ts`.
 */
export function isChannelAway(channelId: number): boolean {
  return isWindowAway(channelId) || liveTailOutOfView.has(channelId);
}

/**
 * Whether something full-screen sits over the chat although the channel is
 * still active: the Settings overlay (the list stays mounted and the window
 * stays focused behind it), a content view, or an open modal dialog such as the
 * Quick Switcher. `isChannelAway` cannot see
 * either, and must not change (it decides unread counting), so the paths that
 * mark a channel read for messages "seen live" ask this as well.
 */
export function isChannelCovered(): boolean {
  const { settingsOpen, activeView } = uiStore.getState();
  return settingsOpen || activeView !== null || dialogOpen();
}
