/**
 * The OS-level half of an incoming DM call — the notification, the
 * urgent taskbar flash and the missed-call notice. The banner, the ring state
 * and the ringtone stay on the main page, which loads this in DmCallPanel's
 * lazy chunk at mount so none of it lands in the page's chunk.
 *
 * Clicking either notification opens the DM through the same target path a
 * message notification uses, so a call from another server is dropped there.
 */
import { loadPref } from "../../lib/prefs/preferences";
import { loadUserStatus } from "../../lib/presence/userStatus";
import { getChannelMutesHost } from "../../lib/prefs/channelMutes";
import { showToast } from "../../lib/ui/toast";
import { createLogger } from "../../lib/logger";
import type { RingState } from "../../lib/voice/callRing";
import { desktop } from "../../platform/desktop";
import { dmCallText } from "../../i18n/dmCall";
import { dmStore, dmDisplayName } from "../../stores/dm.store";

const log = createLogger("call-alerts");

/**
 * The OS popup for `ring`. DND promises no desktop notifications,
 * and while the window is focused the banner is already on screen, so neither
 * case gets one; the banner or the in-app notice still does.
 */
function popup(title: string, ring: RingState, ringing: boolean): void {
  if (loadUserStatus() === "dnd" || !loadPref<boolean>("desktopNotifications", true)) return;
  if (document.hasFocus()) return;
  desktop.notifier
    .showCall(
      title,
      dmCallText("voiceCall"),
      { host: getChannelMutesHost() ?? "", channelId: ring.channelId },
      ringing,
    )
    .catch((err: unknown) => log.debug("Call notification not available", err));
}

/**
 * A new ring: one OS notification and one attention request. The acceptance
 * "exactly one OS notification and one attention request per ring" applies
 * when the window is not focused; a focused window gets only the banner and
 * the ringtone.
 */
export function alertIncomingCall(ring: RingState): void {
  popup(dmCallText("notifyIncoming", { name: ring.fromUsername }), ring, true);
  // Flashes until the window is focused. A ringing call is urgent, so unlike a
  // message's flash it stays under DND: in the tray it is the only signal left.
  if (document.hasFocus() || !loadPref<boolean>("flashTaskbar", true)) return;
  desktop.notifier
    .requestAttention()
    .catch((err: unknown) => log.debug("Attention request not available", err));
}

/** The ring ran out: an in-app notice, and an OS one for an away user. */
export function alertMissedCall(ring: RingState): void {
  const text = dmCallText("missed", { name: ring.fromUsername });
  showToast(text, "info");
  popup(text, ring, false);
}

/**
 * A ring replaced by a ring from another channel (3B-4): the first call is no
 * longer answerable, so say so in app. Toast only, no OS notification: the
 * newer call's own notification is the one the user can still act on.
 */
export function alertSupersededCall(ring: RingState): void {
  const dm = dmStore.getState().channels.find((c) => c.channelId === ring.channelId);
  showToast(
    dm?.isGroup === true
      ? dmCallText("missedGroup", { name: dmDisplayName(dm) })
      : dmCallText("missed", { name: ring.fromUsername }),
    "info",
  );
}

/** The ring ended, however it ended: withdraw its notification, which would
 *  otherwise sit in the notification centre offering a call that is over. */
export function clearIncomingCall(ring: RingState): void {
  desktop.notifier
    .clearCall(ring.channelId)
    .catch((err: unknown) => log.debug("Call notification not withdrawn", err));
}
