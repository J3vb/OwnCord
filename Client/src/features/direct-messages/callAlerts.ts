/**
 * DP-24: the OS-level half of an incoming DM call — the notification, the
 * urgent taskbar flash and the missed-call notice. The banner, the ring state
 * and the ringtone stay on the main page, which loads this in DmCallPanel's
 * lazy chunk at mount so none of it lands in the page's chunk.
 *
 * Clicking either notification opens the DM through the same target path a
 * message notification uses, so a call from another server is dropped there.
 */
import { loadPref } from "../../lib/preferences";
import { loadUserStatus } from "../../lib/userStatus";
import { getChannelMutesHost } from "../../lib/channel-mutes";
import { showToast } from "../../lib/toast";
import { createLogger } from "../../lib/logger";
import type { RingState } from "../../lib/call-ring";
import { desktop } from "../../platform/desktop";
import { dmCallText } from "../../i18n/dmCall";

const log = createLogger("call-alerts");

/**
 * The OS popup for `ring`. DND promises no desktop notifications (OC-0037),
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
 * the ringtone (D3(b)).
 */
export function alertIncomingCall(ring: RingState): void {
  popup(dmCallText("notifyIncoming", { name: ring.fromUsername }), ring, true);
  // Flashes until the window is focused. A passive hint, so it stays under
  // DND like a message's flash: in the tray it is the only signal left
  // (OC-0204).
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

/** The ring ended, however it ended: withdraw its notification, which would
 *  otherwise sit in the notification centre offering a call that is over (D-13). */
export function clearIncomingCall(ring: RingState): void {
  desktop.notifier
    .clearCall(ring.channelId)
    .catch((err: unknown) => log.debug("Call notification not withdrawn", err));
}
