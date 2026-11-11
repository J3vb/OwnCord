// Speaking-ring state of a voice room: the speakers LiveKit reports, a short
// hold so a ring does not blink off between words, and the publish to the
// voice store. Split from roomEventHandlers.ts.

import { Track, type Participant, type Room } from "livekit-client";

/** A speaker LiveKit drops stays lit this long, so a ring does not blink off between words. */
const SPEAKER_HOLD_MS = 200;

/** livekit-client keeps listing a participant who left (it skips the SFU's
 *  "stopped" update for a sid it no longer knows), and the SFU's own update
 *  trails a mute by a detection window. So a remote speaker counts only as
 *  the room's current session for its identity, with the microphone on.
 *  Native participants carry no sid, so both sides compare undefined. */
function canBeSpeaking(room: Room, speaker: Participant): boolean {
  if (speaker.identity === room.localParticipant.identity) return true;
  const current = room.remoteParticipants.get(speaker.identity);
  if (current === undefined || current.sid !== speaker.sid) return false;
  const mic = current.getTrackPublication(Track.Source.Microphone);
  return mic !== undefined && !mic.isMuted;
}

export interface SpeakerTrackerDeps {
  /** Publish the speaking set to the voice store (setSpeakers). */
  setSpeakers: (update: { channel_id: number; speakers: number[] }) => void;
  /** The user id behind a participant identity (parseUserId). */
  parseUserId: (identity: string) => number;
  getRoom: () => Room | null;
  getCurrentChannelId: () => number | null;
}

export interface SpeakerTracker {
  readonly handleActiveSpeakersChanged: (speakers: Participant[]) => void;
  readonly clearSpeakerHold: () => void;
  readonly resetSpeakers: () => void;
  readonly dropSpeaker: (participant: Participant) => void;
}

export function createSpeakerTracker(deps: SpeakerTrackerDeps): SpeakerTracker {
  const { setSpeakers, parseUserId } = deps;
  let liveSpeakers = new Set<number>();
  const speakerHoldUntil = new Map<number, number>();
  let speakerHoldTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSpeakerHold(): void {
    if (speakerHoldTimer !== null) {
      clearTimeout(speakerHoldTimer);
      speakerHoldTimer = null;
    }
    speakerHoldUntil.clear();
    liveSpeakers = new Set();
  }

  function publishSpeakers(channelId: number): void {
    const now = Date.now();
    for (const [userId, until] of speakerHoldUntil) {
      if (until <= now || liveSpeakers.has(userId)) speakerHoldUntil.delete(userId);
    }
    const published = [...new Set([...liveSpeakers, ...speakerHoldUntil.keys()])];
    published.sort((x, y) => x - y);
    setSpeakers({ channel_id: channelId, speakers: published });
    if (speakerHoldTimer !== null) clearTimeout(speakerHoldTimer);
    speakerHoldTimer = null;
    if (speakerHoldUntil.size === 0) return;
    speakerHoldTimer = setTimeout(
      () => {
        speakerHoldTimer = null;
        publishSpeakers(channelId);
      },
      Math.min(...speakerHoldUntil.values()) - now,
    );
  }

  /** A room that reconnected missed the "stopped" updates the SFU sent while
   *  it was cut off, and the SFU repeats none of them: start the list over. */
  function resetSpeakers(): void {
    clearSpeakerHold();
    const channelId = deps.getCurrentChannelId();
    if (channelId !== null) setSpeakers({ channel_id: channelId, speakers: [] });
  }

  /** Muted or gone, a participant cannot be speaking: clear the ring now, with no hold. */
  function dropSpeaker(participant: Participant): void {
    const channelId = deps.getCurrentChannelId();
    const userId = parseUserId(participant.identity);
    if (channelId === null || (!liveSpeakers.has(userId) && !speakerHoldUntil.has(userId))) return;
    liveSpeakers.delete(userId);
    speakerHoldUntil.delete(userId);
    publishSpeakers(channelId);
  }

  const handleActiveSpeakersChanged = (speakers: Participant[]): void => {
    const channelId = deps.getCurrentChannelId();
    const room = deps.getRoom();
    if (channelId === null || room === null) return;
    const live = new Set<number>();
    for (const speaker of speakers) {
      const userId = parseUserId(speaker.identity);
      if (userId > 0 && canBeSpeaking(room, speaker)) live.add(userId);
    }
    const now = Date.now();
    for (const userId of liveSpeakers) {
      if (!live.has(userId) && !speakerHoldUntil.has(userId)) {
        speakerHoldUntil.set(userId, now + SPEAKER_HOLD_MS);
      }
    }
    liveSpeakers = live;
    publishSpeakers(channelId);
  };

  return { handleActiveSpeakersChanged, clearSpeakerHold, resetSpeakers, dropSpeaker };
}
