/**
 * The OS-level half of an incoming DM call — the notification, the
 * urgent taskbar flash and the missed-call notice. The banner, the ring state
 * and the ringtone stay on the main page, which loads this in DmCallPanel's
 * lazy chunk at mount so none of it lands in the page's chunk.
 *
 * Clicking either notification opens the DM through the same target path a
 * message notification uses, so a call from another server is dropped there.
 *
 * The Android app's notification of a ringing call rings by itself, with the
 * phone's ringtone, and has Accept and Decline (`Notifier.ringsCalls`). There
 * this module says for every ring who sounds it: the host, when it was asked
 * to show the ring, or the app's own chime, when it was not or would not.
 * A ring the host shows follows the app's settings for as long as it rings.
 */
import { Disposable } from "../../lib/disposable";
import { loadPref, onPrefChange } from "../../lib/prefs/preferences";
import { loadUserStatus } from "../../lib/presence/userStatus";
import { getChannelMutesHost } from "../../lib/prefs/channelMutes";
import { ringSoundOn, setHostRinging } from "../../lib/media/notificationSound";
import { showToast } from "../../lib/ui/toast";
import { createLogger } from "../../lib/logger";
import type { RingState } from "../../lib/voice/callRing";
import { desktop } from "../../platform/desktop";
import type { NotificationTarget } from "../../platform/contracts/notifications";
import { dmCallText } from "../../i18n/dmCall";
import { dmStore, dmDisplayName } from "../../stores/dm.store";

const log = createLogger("call-alerts");

/** A ring the host was asked to show, and the watch this attempt keeps on the
 *  app's settings. */
interface HostRing {
  readonly channelId: number;
  readonly settings: Disposable;
}

/** The ring the host was asked to show and ring for. Its identity is the
 *  attempt: an answer that comes back for an earlier one changes nothing. */
let hostRing: HostRing | null = null;

/** The host has `next` from here on, or no ring: the attempt before it is
 *  over, and its watch on the settings with it. */
function hold(next: HostRing | null): void {
  hostRing?.settings.destroy();
  hostRing = next;
}

/** What the host was last asked to ring for. It stays after that ring ended,
 *  because a press on its notification can still be on its way, and it names
 *  the server that rang, so the press counts on no other. */
let lastHostRing: NotificationTarget | null = null;

/** DND and the notification toggle each promise no OS popup. */
function popupsOn(): boolean {
  return loadUserStatus() !== "dnd" && loadPref<boolean>("desktopNotifications", true);
}

/** The app is on screen and has the user's eye, so its own ring is in view.
 *  A phone that sleeps or shows another app reports at least one of the two. */
function inFront(): boolean {
  return document.hasFocus() && document.visibilityState === "visible";
}

/** The server the client is signed into now, as a notification target names it. */
const signedInHost = (): string => getChannelMutesHost() ?? "";

function showCall(
  title: string,
  ring: RingState,
  ringing: boolean,
  quiet?: boolean,
): Promise<void> {
  const target = { host: signedInHost(), channelId: ring.channelId };
  const body = dmCallText("voiceCall");
  return quiet === undefined
    ? desktop.notifier.showCall(title, body, target, ringing)
    : desktop.notifier.showCall(title, body, target, ringing, quiet);
}

/**
 * The OS popup for `ring`. DND promises no desktop notifications,
 * and while the window is focused the banner is already on screen, so neither
 * case gets one; the banner or the in-app notice still does.
 */
function popup(title: string, ring: RingState, ringing: boolean): void {
  if (!popupsOn() || document.hasFocus()) return;
  showCall(title, ring, ringing).catch((err: unknown) =>
    log.debug("Call notification not available", err),
  );
}

/** Take the host's notification of the ring in `channelId` down. */
function withdraw(channelId: number): void {
  desktop.notifier
    .clearCall(channelId)
    .catch((err: unknown) => log.debug("Call notification not withdrawn", err));
}

/**
 * The host shows `ring` no longer and the app's own chime has it from here,
 * as it has a ring that comes in while OS notifications are not allowed.
 */
function handBack(ring: RingState): void {
  hold(null);
  setHostRinging(false);
  withdraw(ring.channelId);
}

/**
 * Ask a host that rings by itself to show `ring`, or to show it again so its
 * time starts over. Until it refuses, the host sounds this ring and the app's
 * chime stays quiet; with the ring sound off in the app the host shows it
 * without a sound.
 */
function ringOnHost(title: string, ring: RingState): void {
  const loud = ringSoundOn();
  const mine = { channelId: ring.channelId, settings: new Disposable() };
  hold(mine);
  lastHostRing = { host: signedInHost(), channelId: ring.channelId };
  setHostRinging(true);
  // What is switched off while the host rings holds for this ring at once:
  // without OS notifications the ring is the app's own, and without the ring
  // sound the host shows it again, which stops its ringtone. A ring that went
  // up without a sound stays so until it is rung again.
  onPrefChange(
    "any",
    () => {
      if (!popupsOn()) handBack(ring);
      else if (loud && !ringSoundOn()) ringOnHost(title, ring);
    },
    mine.settings.signal,
  );
  showCall(title, ring, true, !loud).catch((err: unknown) => {
    log.debug("Call notification not available", err);
    // A refusal that comes back after this ring ended, or after it was shown
    // again, is not this ring's any more.
    if (hostRing !== mine) return;
    hold(null);
    setHostRinging(false);
  });
}

const ringTitle = (ring: RingState): string =>
  dmCallText("notifyIncoming", { name: ring.fromUsername });

/**
 * A new ring: one OS notification and one attention request. The acceptance
 * "exactly one OS notification and one attention request per ring" applies
 * when the window is not focused; a focused window gets only the banner and
 * the ringtone.
 */
export function alertIncomingCall(ring: RingState): void {
  if (desktop.notifier.ringsCalls !== true) popup(ringTitle(ring), ring, true);
  else if (popupsOn() && !inFront()) ringOnHost(ringTitle(ring), ring);
  else setHostRinging(false);
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

/**
 * The ring on screen was rung again, so its 30s started over. A notification
 * the host takes down by itself after a set time is shown again, or it would
 * go while the call still rings. Whether it may be shown at all is asked
 * again, as it is for every ring.
 */
export function alertRedial(ring: RingState): void {
  if (hostRing?.channelId !== ring.channelId) return;
  if (popupsOn()) ringOnHost(ringTitle(ring), ring);
  else handBack(ring);
}

/**
 * Whether the host's ring notification for `channelId` is this page's: the
 * ring it last asked the host to show, for the server now signed in. True
 * after that ring ended too. A press on any other one (a ring an earlier
 * session left on screen) is not this page's to act on.
 */
export function isHostRing(channelId: number): boolean {
  return lastHostRing?.channelId === channelId && lastHostRing.host === signedInHost();
}

/** The ring ended, however it ended: withdraw its notification, which would
 *  otherwise sit in the notification centre offering a call that is over. */
export function clearIncomingCall(ring: RingState): void {
  if (hostRing?.channelId === ring.channelId) hold(null);
  if (desktop.notifier.ringsCalls === true) setHostRinging(null);
  withdraw(ring.channelId);
}
