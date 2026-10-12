/**
 * Voice UI sounds (DP-40): a short chime on join/leave — yours and another
 * member's in your channel — and on mute/unmute and deafen/undeafen.
 *
 * The sounds themselves and their shared output device live in
 * `lib/notificationSound.ts`; this module only decides *when* they play. It
 * subscribes to voiceStore directly (a page-local UI reader, like the ringing
 * handler in MainPage), which is allowed as long as it never writes a store.
 *
 * Two edges are deliberately excluded:
 *  - push-to-talk: `pttGated` is never read, so a PTT press/release makes no
 *    sound (D5);
 *  - the wholesale roster replacement (`setVoiceStates`) that the initial
 *    `ready` and a full reconnect resync use: instead of watching the roster
 *    maps, this reads `getVoiceRosterRevision`, which only the incremental
 *    `voice_state`/`voice_leave` handlers bump. A reconnect therefore replays
 *    the roster with no sound storm.
 *
 * Your own join sounds when the session reaches `connected`, not on the
 * click, so a join that fails or is abandoned plays nothing; leave sounds only
 * after a join did. A moderator move plays its own tone in place of the join.
 *
 * DM calls are `call-ring.ts`'s; the incoming ringtone is exempt from the
 * deafen gate per D2, so it does not route through here.
 */

import { voiceStore, getVoiceRosterRevision, type VoiceStatus } from "@stores/voice.store";
import { authStore } from "@stores/auth.store";
import { loadPref } from "@lib/preferences";
import { loadUserStatus } from "@lib/userStatus";
import { playVoiceSound, type VoiceSound } from "@lib/notificationSound";
import { takeVoiceMoved, isVoiceMovePending } from "./moveHint";

/** Snapshot of the fields an edge is measured on. */
interface SoundState {
  readonly channelId: number | null;
  readonly voiceStatus: VoiceStatus;
  readonly rosterRevision: number;
  /** Other members (not self) in `channelId`, so a join/leave of the room can
   *  be told from a mute toggle. */
  readonly peers: ReadonlySet<number>;
  readonly localMuted: boolean;
  readonly localDeafened: boolean;
}

function remotePeers(channelId: number | null): ReadonlySet<number> {
  if (channelId === null) return new Set();
  const self = authStore.getState().user?.id ?? 0;
  const users = voiceStore.getState().voiceUsers.get(channelId);
  if (users === undefined) return new Set();
  return new Set([...users.keys()].filter((id) => id !== self));
}

function snapshot(channelId: number | null): SoundState {
  const s = voiceStore.getState();
  return {
    channelId,
    voiceStatus: s.voiceStatus,
    rosterRevision: getVoiceRosterRevision(),
    peers: remotePeers(channelId),
    localMuted: s.localMuted,
    localDeafened: s.localDeafened,
  };
}

/** How long your own leave waits before it sounds. The server sends a
 *  moderator move as voice_leave and then voice_moved, two frames apart; the
 *  leave must not chime when the move is right behind it. */
const LEAVE_GRACE_MS = 250;

function canPlay(): boolean {
  if (loadUserStatus() === "dnd") return false;
  return loadPref<boolean>("voiceSounds", true);
}

/**
 * Subscribe to voiceStore and play the voice UI sounds. Returns an
 * unsubscribe that also stops any pending sound decision.
 */
export function startVoiceUiSounds(): () => void {
  let prev = snapshot(voiceStore.getState().currentChannelId);
  /** The channel whose join was last announced: the one we are in for real.
   *  A reconnect inside it is not a new join, and a failed join never set it,
   *  so its teardown is not a leave. */
  let announced: number | null =
    prev.channelId !== null &&
    (prev.voiceStatus === "connected" || prev.voiceStatus === "reconnecting")
      ? prev.channelId
      : null;

  let leaveTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelLeave = (): void => {
    if (leaveTimer !== null) clearTimeout(leaveTimer);
    leaveTimer = null;
  };
  /** Your own leave, unless a moderator move turns out to be behind it. */
  const scheduleLeave = (): void => {
    cancelLeave();
    leaveTimer = setTimeout(() => {
      leaveTimer = null;
      if (!isVoiceMovePending()) playVoiceSound("leave");
    }, LEAVE_GRACE_MS);
  };

  /** Your own join/move/leave edge, if this state has one. Runs on every
   *  update (deafened or not), so `announced` always tracks the session. */
  const selfEdge = (next: SoundState): VoiceSound | null => {
    if (next.channelId === null) {
      const wasIn = announced !== null;
      announced = null;
      // A join that ended before it connected (a move's included) spends the
      // move note; a leave from a live call keeps it for the voice_moved
      // that may follow.
      if (!wasIn && prev.channelId !== null) takeVoiceMoved(null);
      return wasIn ? "leave" : null;
    }
    if (next.voiceStatus !== "connected" || next.channelId === announced) return null;
    announced = next.channelId;
    return takeVoiceMoved(next.channelId) ? "moved" : "join";
  };

  const unsubscribe = voiceStore.subscribe((state) => {
    const next = snapshot(state.currentChannelId);
    const finish = (): void => {
      prev = next;
    };

    // Sign-out clears auth synchronously but only resets voiceStore (and
    // notifies this subscriber) on the next microtask. A reset is a teardown,
    // not a user edge: without this guard the cleared channel/deafen/mute
    // flags read as leave/undeafen/mute over the logout screen.
    if (!authStore.getState().isAuthenticated) {
      announced = null;
      cancelLeave();
      takeVoiceMoved(null);
      finish();
      return;
    }

    const self = selfEdge(next);

    // A deafen edge is its own sound and owns the notification: the mute that
    // a deafen implies (the keybind mutes too) must not also blip.
    const deafenChanged = next.localDeafened !== prev.localDeafened;
    if (deafenChanged) {
      if (canPlay()) playVoiceSound(next.localDeafened ? "deafen" : "undeafen");
      finish();
      return;
    }
    // While deafened, nothing else plays (D2 exempts only the ringtone).
    if (next.localDeafened) {
      finish();
      return;
    }
    if (!canPlay()) {
      finish();
      return;
    }

    // Self join/leave/move. A switch plays nothing until the new channel
    // connects, and then only the join: never a leave and a join back to back.
    if (self !== null || next.channelId !== prev.channelId) {
      if (self === "leave") scheduleLeave();
      else if (self !== null) playVoiceSound(self);
      finish();
      return;
    }

    // Another member joining or leaving the channel we are in. Only the
    // incremental roster revision reaches here — a setVoiceStates replacement
    // leaves it unchanged, so a reconnect replay is silent. The revision is
    // global, so diff the peer sets: a voice_state for a user in another
    // channel (or a mute toggle) must not read as a join.
    if (next.rosterRevision !== prev.rosterRevision && next.channelId !== null) {
      const joined = [...next.peers].some((id) => !prev.peers.has(id));
      const left = [...prev.peers].some((id) => !next.peers.has(id));
      if (joined) playVoiceSound("join");
      else if (left) playVoiceSound("leave");
      finish();
      return;
    }

    if (next.localMuted !== prev.localMuted) {
      playVoiceSound(next.localMuted ? "mute" : "unmute");
    }

    finish();
  });
  return () => {
    unsubscribe();
    cancelLeave();
    takeVoiceMoved(null);
  };
}
