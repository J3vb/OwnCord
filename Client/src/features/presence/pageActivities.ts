/** What the main page runs for presence beyond the status picker: the detected
 *  game and song, and keeping the account active while talking in a call. */

import type { WsClient } from "@lib/ws";
import { createLogger } from "@lib/logger";
import type { AutoIdleController } from "@lib/presence/autoIdle";
import type { GameActivityLoop } from "@lib/presence/gameActivity";
import type { MusicActivityLoop } from "@lib/presence/musicActivity";
import { authStore } from "@stores/auth.store";
import { voiceStore } from "@stores/voice.store";
import { desktop } from "../../platform/desktop";

const log = createLogger("main-page");

/** The slice of the page state these loops read and write. */
export interface ActivityHost {
  readonly ws: WsClient;
  readonly tornDown: boolean;
  gameActivity: GameActivityLoop | null;
  musicActivity: MusicActivityLoop | null;
  autoIdle: AutoIdleController | null;
  speakingActivityTimer: ReturnType<typeof setInterval> | null;
}

/**
 * The game being played, for other members' "Playing <game>" line, and the
 * song being listened to, for the "Listening to <player>" line. The loops send
 * nothing unless the setting is on and the server advertises the capability
 * (game_activity, listening_activity); the web build has no detector and never
 * loads them.
 */
export function startDetectedActivities(host: ActivityHost): void {
  if (desktop.gameDetector.available) {
    void import("@lib/presence/gameActivity").then(
      ({ startGameActivity }) => {
        if (host.tornDown) return;
        host.gameActivity = startGameActivity({
          ws: host.ws,
          detect: (prefs) => desktop.gameDetector.detect(prefs),
        });
      },
      (err: unknown) => log.warn("Game activity failed to load", { error: String(err) }),
    );
  }
  if (desktop.mediaDetector.available) {
    void import("@lib/presence/musicActivity").then(
      ({ startMusicActivity }) => {
        if (host.tornDown) return;
        host.musicActivity = startMusicActivity({
          ws: host.ws,
          detect: (prefs) => desktop.mediaDetector.detect(prefs),
        });
      },
      (err: unknown) => log.warn("Music activity failed to load", { error: String(err) }),
    );
  }
}

function clearSpeakingTimer(host: ActivityHost): void {
  if (host.speakingActivityTimer !== null) clearInterval(host.speakingActivityTimer);
  host.speakingActivityTimer = null;
}

/**
 * Talking in a call is being here even with hands off the keyboard and mouse,
 * which neither the window nor (for another app) the OS poll sees. The local
 * ring is the same on web and native (voice.store withLocalRing). Returns the
 * subscription and the timer cleanup, for the page's unsubscribers.
 */
export function followSpeakingActivity(host: ActivityHost): Array<() => void> {
  return [
    voiceStore.subscribeSelector(
      (v) => {
        const uid = authStore.getState().user?.id ?? 0;
        const ch = v.currentChannelId;
        return ch !== null && v.voiceUsers.get(ch)?.get(uid)?.speaking === true;
      },
      (speaking) => {
        clearSpeakingTimer(host);
        if (!speaking) return;
        host.autoIdle?.notifyActivity();
        // Talking for longer than the idle delay must keep counting.
        host.speakingActivityTimer = setInterval(() => host.autoIdle?.notifyActivity(), 60_000);
      },
    ),
    () => clearSpeakingTimer(host),
  ];
}
