/**
 * The voice sounds that follow your own session's link rather than a click:
 * the connection dropping and coming back, and the push-to-talk gate opening
 * and closing. `uiSounds.ts` feeds every voice store update through these
 * trackers, whatever the gates say, so each one always knows where the session
 * is; it plays what they return only when its own gates pass.
 */

import { voiceStore, isPttPollingLive, type VoiceStatus } from "@stores/voice.store";
import { inputMode } from "@lib/ui/inputMode";
import { micIsUsersToOpen } from "./voiceStatusText";

/** The fields of one voice store update these trackers read. */
export interface LinkState {
  readonly channelId: number | null;
  readonly voiceStatus: VoiceStatus;
  readonly pttGated: boolean;
  /** A switch out of this call waits for the server: the user is leaving it. */
  readonly switching: boolean;
}

/**
 * How long a dropped session must still be away before the lost sound plays.
 * The SDK resumes a cut connection at once and retries 300 ms later; a resume
 * that lands on either try is a hiccup nobody needs to hear about. The next
 * try waits 1.2 s, and the reconnect loop's first attempt 3 s, so a drop still
 * unresolved here is one the user will notice.
 */
export const LOST_GRACE_MS = 800;

export interface ConnectionSounds {
  /** Track one update. Returns "join" when the session is back after a drop
   *  whose lost sound played. */
  update(prev: LinkState, next: LinkState): "join" | null;
  /** Forget the session and drop a pending lost sound. */
  cancel(): void;
}

/**
 * The connection lost and back sounds. `playLost` runs when the grace time
 * ends with the session still away, and says whether the sound played (its
 * gates are read then, not at the drop).
 */
export function createConnectionSounds(playLost: () => boolean): ConnectionSounds {
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The channel whose drop was announced, until the session is back or gone. */
  let lostIn: number | null = null;

  const cancelTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = (channelId: number): void => {
    cancelTimer();
    timer = setTimeout(() => {
      timer = null;
      const s = voiceStore.getState();
      if (s.currentChannelId !== channelId || s.voiceStatus === "connected") return;
      if ((s.switchingTo ?? null) !== null) return;
      if (playLost()) lostIn = channelId;
    }, LOST_GRACE_MS);
  };

  return {
    update(prev, next) {
      if (next.channelId === null || next.channelId !== prev.channelId || next.switching) {
        cancelTimer();
        lostIn = null;
        return null;
      }
      if (prev.voiceStatus === "connected" && next.voiceStatus === "reconnecting") {
        schedule(next.channelId);
        return null;
      }
      if (next.voiceStatus !== "connected") return null;
      cancelTimer();
      const back = lostIn === next.channelId;
      lostIn = null;
      return back ? "join" : null;
    },
    cancel() {
      cancelTimer();
      lostIn = null;
    },
  };
}

/**
 * The push-to-talk ticks: the gate opening (`pttOn`) and closing (`pttOff`)
 * in a connected session, in push-to-talk mode, with a live press source,
 * while the mic is the user's to open (a press while muted, server-muted,
 * listen-only, in the AFK channel or on a phone call's hold opens nothing).
 * A close only ticks after an open did, so the gate closing as a call starts
 * or as push-to-talk is switched on stays silent; the gate opening as
 * push-to-talk is switched off, or as its key is lost, finds no live press
 * source and stays silent too. A mic that stops being the user's while the
 * key is held forgets the open, and one that becomes theirs while it is held
 * ticks only from the next press.
 */
export function createPttTicks(): (prev: LinkState, next: LinkState) => "pttOn" | "pttOff" | null {
  let opened = false;
  return (prev, next) => {
    const live =
      next.channelId !== null &&
      next.channelId === prev.channelId &&
      prev.voiceStatus === "connected" &&
      next.voiceStatus === "connected" &&
      inputMode() === "ptt" &&
      isPttPollingLive();
    if (!live || (opened && !micIsUsersToOpen(voiceStore.getState()))) {
      opened = false;
      return null;
    }
    if (prev.pttGated && !next.pttGated) {
      if (!micIsUsersToOpen(voiceStore.getState())) return null;
      opened = true;
      return "pttOn";
    }
    if (!prev.pttGated && next.pttGated && opened) {
      opened = false;
      return "pttOff";
    }
    return null;
  };
}
