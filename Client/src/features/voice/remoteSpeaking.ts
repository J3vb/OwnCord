// Remote speaking rings from the audio this client receives.
//
// LiveKit's ActiveSpeakersChanged comes from the SFU, which judges each
// sender's level over a 200 ms window and reports on its own 200 ms tick, so a
// remote ring lit a median 140 ms after its audio played, even on loopback.
// The received track's decoded energy (inbound-rtp totalAudioEnergy, the same
// counter guided diagnostics reads) shows speech within one poll. voice.store
// ORs this list with LiveKit's, which still covers a deafened client (no
// subscribed audio) and the Linux native room (no browser peer connection).

import { Track, type Room } from "livekit-client";
import { isLinuxDesktop } from "./native/platform";
import { parseUserId } from "./sessionState";

/** How often the received levels are read. */
const LEVEL_POLL_MS = 50;
/** Received level that counts as speech: -45 dBov, the SFU's own active_level. */
const SPEECH_RMS = 10 ** (-45 / 20);
/** How long a ring stays lit after the last loud poll, so it does not flicker
 *  between words. Short, because WebRTC's level already decays over ~300 ms. */
export const SPEAKING_HOLD_MS = 100;

interface Counters {
  readonly energy: number;
  readonly duration: number;
}

export class RemoteSpeaking {
  private room: Room | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  /** Last counters per received track id, to difference against. */
  private counters = new Map<string, Counters>();
  /** Date.now() of each user's last poll above speech level. */
  private loudAt = new Map<number, number>();
  private speakers: ReadonlySet<number> = new Set();

  constructor(private readonly onChange: (userIds: ReadonlySet<number>) => void) {}

  setRoom(room: Room | null): void {
    if (room === this.room) return;
    this.room = room;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.counters.clear();
    this.loudAt.clear();
    this.report(new Set());
    // The native room has no browser peer connection to read.
    if (room === null || isLinuxDesktop()) return;
    this.timer = setInterval(() => void this.poll(), LEVEL_POLL_MS);
  }

  /** Read every received microphone's level once (the timer's tick). */
  async poll(): Promise<void> {
    const room = this.room;
    const manager = room?.engine?.pcManager;
    if (room === null || manager === undefined || this.polling) return;
    this.polling = true;
    try {
      // LiveKit receives media on the publisher in single-peer-connection
      // mode; dual-connection sessions keep incoming tracks on the subscriber.
      const report = await (manager.subscriber ?? manager.publisher)?.getStats();
      if (this.room !== room || report === undefined) return;
      const users = new Map<string, number>();
      for (const p of room.remoteParticipants.values()) {
        const id = p.getTrackPublication(Track.Source.Microphone)?.track?.mediaStreamTrack.id;
        if (id !== undefined) users.set(id, parseUserId(p.identity));
      }
      const now = Date.now();
      const counters = new Map<string, Counters>();
      report.forEach((entry: Record<string, unknown>) => {
        const { type, trackIdentifier: track, totalAudioEnergy: energy } = entry;
        const duration = entry.totalSamplesDuration;
        if (type !== "inbound-rtp" || typeof track !== "string") return;
        if (typeof energy !== "number" || typeof duration !== "number") return;
        const userId = users.get(track);
        const last = this.counters.get(track);
        counters.set(track, { energy, duration });
        if (userId === undefined || userId <= 0 || last === undefined) return;
        const elapsed = duration - last.duration;
        if (elapsed > 0 && Math.sqrt((energy - last.energy) / elapsed) >= SPEECH_RMS) {
          this.loudAt.set(userId, now);
        }
      });
      this.counters = counters;
      const speaking = new Set<number>();
      for (const [userId, at] of this.loudAt) {
        if (now - at < SPEAKING_HOLD_MS) speaking.add(userId);
        else this.loudAt.delete(userId);
      }
      this.report(speaking);
    } catch {
      // A closed peer connection mid-teardown; LiveKit's list still applies.
    } finally {
      this.polling = false;
    }
  }

  private report(speaking: ReadonlySet<number>): void {
    const same =
      speaking.size === this.speakers.size && [...speaking].every((id) => this.speakers.has(id));
    if (same) return;
    this.speakers = speaking;
    this.onChange(speaking);
  }
}
