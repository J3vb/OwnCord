// Speaking-ring state of a voice room: the speakers LiveKit reports, a short
// hold so a ring does not blink off between words, what each participant
// reports for itself (ringAnnounce.ts), and the publish to the voice store.
// Split from roomEventHandlers.ts.

import { Track, type Participant } from "livekit-client";
import type { VoiceRoom } from "@lib/voice/voiceRoom";
import { RING_TTL_MS, type RingState } from "./ringAnnounce";

/** A speaker LiveKit drops stays lit this long, so a ring does not blink off between words. */
const SPEAKER_HOLD_MS = 200;

/** A participant as an event names it. Native participants carry no sid. */
interface SpeakerRef {
  readonly identity: string;
  readonly sid?: string;
}

/** A lit report can arrive ahead of the SFU's word that its sender's
 *  microphone is on (they travel apart): look again this often until it is. */
const HIDDEN_RECHECK_MS = 100;

/** What a remote participant reported for itself, until it runs out. */
interface Announcement extends SpeakerRef {
  readonly speaking: boolean;
  readonly until: number;
  /** Whether the last publish showed it lit. */
  lit: boolean;
}

/** The room's current session for an identity, with the microphone on. */
function isLiveRemote(room: VoiceRoom, speaker: SpeakerRef, needsMic: boolean): boolean {
  const current = room.remoteParticipants.get(speaker.identity);
  if (current === undefined || current.sid !== speaker.sid) return false;
  if (!needsMic) return true;
  const mic = current.getTrackPublication(Track.Source.Microphone);
  return mic !== undefined && !mic.isMuted;
}

/** livekit-client keeps listing a participant who left (it skips the SFU's
 *  "stopped" update for a sid it no longer knows), and the SFU's own update
 *  trails a mute by a detection window. So a remote speaker counts only as
 *  the room's current session for its identity, with the microphone on.
 *  Native participants carry no sid, so both sides compare undefined. */
function canBeSpeaking(room: VoiceRoom, speaker: SpeakerRef): boolean {
  if (speaker.identity === room.localParticipant.identity) return true;
  return isLiveRemote(room, speaker, true);
}

export interface SpeakerTrackerDeps {
  /** Publish the speaking set to the voice store (setSpeakers). */
  setSpeakers: (update: { channel_id: number; speakers: number[] }) => void;
  /** The user id behind a participant identity (parseUserId). */
  parseUserId: (identity: string) => number;
  getRoom: () => VoiceRoom | null;
  getCurrentChannelId: () => number | null;
}

export interface SpeakerTracker {
  readonly handleActiveSpeakersChanged: (speakers: Participant[]) => void;
  /** The ring a member of the channel reports for itself (voice_speaking). */
  readonly handleRingAnnounced: (userId: number, state: RingState) => void;
  readonly clearSpeakerHold: () => void;
  readonly resetSpeakers: () => void;
  readonly dropSpeaker: (participant: Participant) => void;
}

export function createSpeakerTracker(deps: SpeakerTrackerDeps): SpeakerTracker {
  const { setSpeakers, parseUserId } = deps;
  let liveSpeakers = new Set<number>();
  const speakerHoldUntil = new Map<number, number>();
  /** Each remote user's own verdict while it counts: it replaces LiveKit's for that user. */
  const announced = new Map<number, Announcement>();
  let speakerHoldTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSpeakerHold(): void {
    if (speakerHoldTimer !== null) {
      clearTimeout(speakerHoldTimer);
      speakerHoldTimer = null;
    }
    speakerHoldUntil.clear();
    announced.clear();
    liveSpeakers = new Set();
  }

  /** Every moment a hold or a report runs out. */
  function deadlines(): number[] {
    return [...speakerHoldUntil.values(), ...[...announced.values()].map((a) => a.until)];
  }

  /** Drop the holds that ran out or relit, and the announcements that ran out
   *  or whose sender is no longer this room's session for its identity. */
  function prune(room: VoiceRoom | null, now: number): void {
    for (const [userId, until] of speakerHoldUntil) {
      if (until <= now || liveSpeakers.has(userId)) speakerHoldUntil.delete(userId);
    }
    for (const [userId, announcement] of announced) {
      if (announcement.until <= now || room === null || !isLiveRemote(room, announcement, false))
        announced.delete(userId);
    }
  }

  /** The lit reports the last publish could not show. */
  function hidden(): Announcement[] {
    return [...announced.values()].filter((a) => a.speaking && !a.lit);
  }

  /** Whether a wake-up has something to publish: a deadline ran out, or a
   *  hidden lit report can be shown now. */
  function isDue(at: number): boolean {
    if (deadlines().some((deadline) => deadline <= at)) return true;
    const room = deps.getRoom();
    return room !== null && hidden().some((a) => canBeSpeaking(room, a));
  }

  /** Wake at the next deadline, or sooner while a lit report is hidden. A
   *  repeated report only moves its own deadline, so the wake-up publishes
   *  only when there is something to publish. */
  function armSpeakerTimer(channelId: number, now: number): void {
    if (speakerHoldTimer !== null) clearTimeout(speakerHoldTimer);
    speakerHoldTimer = null;
    const pending = deadlines();
    if (hidden().length > 0) pending.push(now + HIDDEN_RECHECK_MS);
    if (pending.length === 0) return;
    speakerHoldTimer = setTimeout(
      () => {
        speakerHoldTimer = null;
        const at = Date.now();
        if (isDue(at)) publishSpeakers(channelId);
        else armSpeakerTimer(channelId, at);
      },
      Math.min(...pending) - now,
    );
  }

  function publishSpeakers(channelId: number): void {
    const now = Date.now();
    const room = deps.getRoom();
    prune(room, now);
    const published = new Set<number>();
    for (const userId of [...liveSpeakers, ...speakerHoldUntil.keys()]) {
      if (!announced.has(userId)) published.add(userId);
    }
    for (const [userId, announcement] of announced) {
      announcement.lit =
        announcement.speaking && room !== null && canBeSpeaking(room, announcement);
      if (announcement.lit) published.add(userId);
    }
    setSpeakers({ channel_id: channelId, speakers: [...published].toSorted((x, y) => x - y) });
    armSpeakerTimer(channelId, now);
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
    if (channelId === null) return;
    const known = [
      liveSpeakers.delete(userId),
      speakerHoldUntil.delete(userId),
      announced.delete(userId),
    ];
    if (known.includes(true)) publishSpeakers(channelId);
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

  /** The room's participant for a user id, if it is in the room. */
  function remoteOf(room: VoiceRoom, userId: number): SpeakerRef | undefined {
    for (const participant of room.remoteParticipants.values()) {
      if (parseUserId(participant.identity) === userId) return participant;
    }
    return undefined;
  }

  /** The server names the sender, so no member can light another's ring. A
   *  report counts only for a user who is in this room right now: one that
   *  arrives ahead of the participant is dropped, and the next repeat lands. */
  const handleRingAnnounced = (userId: number, state: RingState): void => {
    const channelId = deps.getCurrentChannelId();
    const room = deps.getRoom();
    if (channelId === null || room === null) return;
    const sender = remoteOf(room, userId);
    if (sender === undefined) return;
    const previous = announced.get(userId);
    if (state === null) {
      if (announced.delete(userId)) publishSpeakers(channelId);
      return;
    }
    announced.set(userId, {
      identity: sender.identity,
      sid: sender.sid,
      speaking: state,
      until: Date.now() + RING_TTL_MS,
      lit: previous?.lit === true,
    });
    if (previous?.speaking !== state) publishSpeakers(channelId);
  };

  return {
    handleActiveSpeakersChanged,
    handleRingAnnounced,
    clearSpeakerHold,
    resetSpeakers,
    dropSpeaker,
  };
}
