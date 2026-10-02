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
 * DM calls are `call-ring.ts`'s; the incoming ringtone is exempt from the
 * deafen gate per D2, so it does not route through here.
 */

import { voiceStore, getVoiceRosterRevision } from "@stores/voice.store";
import { authStore } from "@stores/auth.store";
import { loadPref } from "@lib/preferences";
import { loadUserStatus } from "@lib/userStatus";
import { playVoiceSound } from "@lib/notificationSound";

/** Snapshot of the fields an edge is measured on. */
interface SoundState {
  readonly channelId: number | null;
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
    rosterRevision: getVoiceRosterRevision(),
    peers: remotePeers(channelId),
    localMuted: s.localMuted,
    localDeafened: s.localDeafened,
  };
}

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

  return voiceStore.subscribe((state) => {
    const next = snapshot(state.currentChannelId);
    const finish = (): void => {
      prev = next;
    };

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

    // Self join/leave/move is the channel edge. A move plays the join sound;
    // the leave half is skipped so a move is not two blips back to back.
    if (next.channelId !== prev.channelId) {
      playVoiceSound(next.channelId !== null ? "join" : "leave");
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
}
