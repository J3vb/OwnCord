// Page-lifetime features that only need to start with the page and stop with
// it. A new one adds an entry here, not to MainPage.
import { bracketBareIPv6Host } from "@lib/ws";
import { openSettings } from "@stores/ui.store";
import { createUpdateNotifier } from "../../features/updates/UpdateNotifier";
import { desktop } from "../../platform/desktop";
import { startVoiceUiSounds } from "../../features/voice/uiSounds";
import type { PageState } from "./pageState";

/** Starts a feature on the page in `st`. A feature loaded on demand must check
 *  `st.tornDown` once its chunk arrives: destroy() sets it before it runs the
 *  unsubscribers, so a stopper pushed while it is false always runs. */
export type PageFeature = (st: PageState, root: HTMLDivElement) => void;

/** Background work, started before the page body mounts. */
export const backgroundFeatures: readonly PageFeature[] = [
  // Timed mutes: redraws the sidebars when one ends. Page-owned, so a socket
  // reconnect leaves it alone and a server switch remounts a fresh one.
  (st) => {
    void import("@lib/prefs/channelMuteExpiry").then((expiry) => {
      if (!st.tornDown) st.unsubscribers.push(expiry.startMuteExpiryWatch());
    });
  },
  // The taskbar and tray unread badge, cleared again on teardown so a logout
  // or server switch does not leave this session's count behind. With it, the
  // phone's notifications for a channel go once it is read (its stopper
  // withdraws what is left), and the phone asks once for the permission.
  (st) => {
    void import("../../features/unread-badge/unreadBadge").then((badge) => {
      if (st.tornDown) return;
      st.unsubscribers.push(badge.startUnreadBadge(desktop.notifier));
      st.unsubscribers.push(badge.startNotificationClearing(desktop.notifier));
      void badge.askNotificationPermissionOnce(desktop.notifier);
    });
  },
  // Shares from other apps (Android): the "Send to" sheet, then the picked
  // channel's composer.
  (st) => {
    if (!desktop.shareSheet.available) return;
    void import("../../features/share/shareIn").then((share) => {
      if (!st.tornDown) st.unsubscribers.push(share.startShareIn(desktop.shareSheet));
    });
  },
  // Short voice UI sounds on join/leave and mute/deafen. It statically imports
  // stores the page already pulls in, so it rides the MainPage chunk.
  (st) => {
    if (!st.tornDown) st.unsubscribers.push(startVoiceUiSounds());
  },
];

/** Prompts and notices, mounted on top of the finished page in this order. */
export const overlayFeatures: readonly PageFeature[] = [
  // Auto-update notifier: checks the server for a newer client version. A
  // bare IPv6 literal must be bracketed or the URL is unparseable and the
  // updater silently reports "no update available" forever.
  (st, root) => {
    if (!st.apiConfig.host) return;
    const serverUrl = `https://${bracketBareIPv6Host(st.apiConfig.host)}`;
    const updateNotifier = createUpdateNotifier({ serverUrl, keepChecking: true });
    updateNotifier.mount(root);
    st.children.push(updateNotifier);
  },
  // Release notes, once, on the first start after an update. Loaded on demand
  // so the prompt stays out of the eager MainPage chunk (bundle budget).
  (st, root) => {
    void import("../../features/whats-new/whatsNewPrompt").then(({ createWhatsNewPrompt }) => {
      if (st.tornDown) return;
      // i18n-exempt: settings tab key, not shown text
      const whatsNewPrompt = createWhatsNewPrompt(() => openSettings("About"));
      whatsNewPrompt.mount(root);
      st.unsubscribers.push(() => whatsNewPrompt.destroy?.());
    });
  },
];
