/**
 * The voice widget's connection stats poller and the ping graph's call.
 *
 * The poller lives as long as one call: its channel and join time. A new
 * call replaces it, so a sample still in flight from the old room cannot
 * land. A link that drops and resumes inside the same call keeps the poller:
 * restarting it would zero its byte counters, and the first sample after the
 * blip would then read the whole session's bytes as one interval's rate (and
 * lose the loss and jitter history). The drop only starts the ping graph over,
 * once as the link goes down and once as it comes back.
 */
import {
  createConnectionStatsPoller,
  type ConnectionStats,
  type ConnectionStatsPoller,
} from "@lib/voice/connectionStats";
import type { VoiceState } from "@stores/voice.store";
import { getRoomForStats } from "../livekitSession";

/** The call a poller belongs to: its channel and join time, null out of a
 *  call. */
export function statsCallKeyOf(voice: VoiceState): string | null {
  if (voice.currentChannelId === null) return null;
  return `${voice.currentChannelId}:${voice.joinedAt ?? ""}`;
}

export interface StatsHost {
  /** Follow the call: start, replace or stop the poller, and start the ping
   *  graph over when the call changes or its link drops or resumes. */
  sync(voice: VoiceState): void;
  stop(): void;
}

export function createStatsHost(
  draw: (stats: ConnectionStats) => void,
  resetHistory: () => void,
): StatsHost {
  let poller: ConnectionStatsPoller | null = null;
  let unlisten: (() => void) | null = null;
  let callKey: string | null = null;
  let linkDown = false;

  function start(): void {
    poller = createConnectionStatsPoller(() => getRoomForStats());
    unlisten = poller.onUpdate(draw);
    // The stats pane opens only on demand. A quality change updates the signal
    // bars via onUpdate, but never expands the pane on its own.
    poller.start();
    // Paint the initial state now. draw only runs on a sample; where none
    // arrives (the first poll is 2 s out, or the native host has no sample)
    // the widget would otherwise keep its constructed 4-green-bars default.
    draw(poller.getStats());
  }

  function stop(): void {
    unlisten?.();
    unlisten = null;
    poller?.stop();
    poller = null;
    callKey = null;
    linkDown = false;
  }

  function sync(voice: VoiceState): void {
    const key = statsCallKeyOf(voice);
    if (key !== callKey) {
      stop();
      resetHistory();
      callKey = key;
      if (key !== null) start();
    }
    const down = key !== null && voice.voiceStatus === "reconnecting";
    if (down === linkDown) return;
    linkDown = down;
    resetHistory();
  }

  return { sync, stop };
}
