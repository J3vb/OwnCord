/**
 * Voice UI sounds: a short chime on join/leave — yours and another
 * member's in your channel — and on mute/unmute and deafen/undeafen.
 *
 * The sounds themselves and their shared output device live in
 * `lib/notificationSound.ts`; this module only decides *when* they play. It
 * subscribes to voiceStore directly (a page-local UI reader, like the ringing
 * handler in MainPage), which is allowed as long as it never writes a store.
 *
 * Two edges are deliberately excluded:
 *  - push-to-talk: `pttGated` is never read, so a PTT press/release makes no
 *    sound;
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
 * deafen gate, so it does not route through here.
 */

import {
  voiceStore,
  getVoiceRosterRevision,
  isWatchingResync,
  streamViewers,
  type VoiceStatus,
} from "@stores/voice.store";
import { authStore } from "@stores/auth.store";
import { loadPref } from "@lib/prefs/preferences";
import { loadUserStatus } from "@lib/userStatus";
import { playVoiceSound, type VoiceSound } from "@lib/notificationSound";
import { soundSwitchOn, type SoundSwitch } from "@lib/prefs/soundPrefs";
import { takeVoiceMoved, isVoiceMovePending } from "./moveHint";

/** Snapshot of the fields an edge is measured on. */
interface SoundState {
  readonly channelId: number | null;
  readonly voiceStatus: VoiceStatus;
  readonly rosterRevision: number;
  /** Other members (not self) in `channelId`, so a join/leave of the room can
   *  be told from a mute toggle. */
  readonly peers: ReadonlySet<number>;
  /** Who in `channelId` is sharing their screen, by the server's roster:
   *  your own share counts once the server has it, not on the click. */
  readonly sharing: ReadonlySet<number>;
  /** Who watches your own screen share (empty unless you are sharing). */
  readonly viewers: ReadonlySet<number>;
  readonly localMuted: boolean;
  readonly localDeafened: boolean;
}

function snapshot(channelId: number | null): SoundState {
  const s = voiceStore.getState();
  const self = authStore.getState().user?.id ?? 0;
  const peers = new Set<number>();
  const sharing = new Set<number>();
  if (channelId !== null) {
    for (const [id, user] of s.voiceUsers.get(channelId) ?? []) {
      if (user.screenshare) sharing.add(id);
      if (id !== self) peers.add(id);
    }
  }
  return {
    channelId,
    voiceStatus: s.voiceStatus,
    rosterRevision: getVoiceRosterRevision(),
    peers,
    sharing,
    viewers: new Set(channelId === null || self === 0 ? [] : streamViewers(self, false, s)),
    localMuted: s.localMuted,
    localDeafened: s.localDeafened,
  };
}

/** How long your own leave waits before it sounds. The server sends a
 *  moderator move as voice_leave and then voice_moved, two frames apart; the
 *  leave must not chime when the move is right behind it. */
const LEAVE_GRACE_MS = 250;

/** How long after your own join the viewer sets settle. */
const VIEWER_SYNC_QUIET_MS = 2000;

function selfId(): number {
  return authStore.getState().user?.id ?? 0;
}

function canPlay(): boolean {
  if (loadUserStatus() === "dnd") return false;
  return loadPref<boolean>("voiceSounds", true);
}

/** The per-sound switch each voice sound answers to. */
const SOUND_SWITCH: Readonly<Record<VoiceSound, SoundSwitch>> = {
  join: "joinLeave",
  leave: "joinLeave",
  moved: "joinLeave",
  mute: "muteDeafen",
  unmute: "muteDeafen",
  deafen: "muteDeafen",
  undeafen: "muteDeafen",
  streamStart: "stream",
  streamEnd: "stream",
  viewerJoin: "stream",
  viewerLeave: "stream",
};

/** Play `kind` unless its own switch is off. Callers have already passed the
 *  `voiceSounds` group switch and Do Not Disturb (`canPlay`). */
function play(kind: VoiceSound): void {
  if (soundSwitchOn(SOUND_SWITCH[kind])) playVoiceSound(kind);
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

  /** Until when viewer changes are a join's re-sync, not people coming and going. */
  let quietUntil = 0;
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
      if (!isVoiceMovePending()) play("leave");
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
    // The server re-sends the room's watch sets on a join: not viewer edges.
    if (self === "join" || self === "moved") quietUntil = Date.now() + VIEWER_SYNC_QUIET_MS;

    // A deafen edge is its own sound and owns the notification: the mute that
    // a deafen implies (the keybind mutes too) must not also blip.
    const deafenChanged = next.localDeafened !== prev.localDeafened;
    if (deafenChanged) {
      if (canPlay()) play(next.localDeafened ? "deafen" : "undeafen");
      finish();
      return;
    }
    // While deafened, nothing else plays (only the ringtone is exempt).
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
      else if (self !== null) play(self);
      finish();
      return;
    }

    // Someone starts or stops watching your own screen share. Only a change
    // while you share before and after counts: a share starting (viewers
    // already on the roster) or the re-sync after a join or a resume is not
    // an edge. A viewer who left voice is a leave, not a viewer leaving.
    if (
      prev.sharing.has(selfId()) &&
      next.sharing.has(selfId()) &&
      !isWatchingResync() &&
      quietUntil <= Date.now()
    ) {
      const gained = [...next.viewers].some((id) => !prev.viewers.has(id));
      const lost = [...prev.viewers].some((id) => !next.viewers.has(id) && next.peers.has(id));
      if (gained || lost) {
        play(gained ? "viewerJoin" : "viewerLeave");
        finish();
        return;
      }
    }

    // Another member joining or leaving the channel we are in. Only the
    // incremental roster revision reaches here — a setVoiceStates replacement
    // leaves it unchanged, so a reconnect replay is silent. The revision is
    // global, so diff the peer sets: a voice_state for a user in another
    // channel (or a mute toggle) must not read as a join. Someone who stays
    // (you included) and starts or stops sharing is a stream edge; one who
    // joins or leaves while sharing plays only the join or leave.
    if (next.rosterRevision !== prev.rosterRevision && next.channelId !== null) {
      const joined = [...next.peers].some((id) => !prev.peers.has(id));
      const left = [...prev.peers].some((id) => !next.peers.has(id));
      if (joined) play("join");
      else if (left) play("leave");
      else if ([...next.sharing].some((id) => !prev.sharing.has(id))) {
        play("streamStart");
      } else if ([...prev.sharing].some((id) => !next.sharing.has(id))) {
        play("streamEnd");
      }
      finish();
      return;
    }

    if (next.localMuted !== prev.localMuted) {
      play(next.localMuted ? "mute" : "unmute");
    }

    finish();
  });
  return () => {
    unsubscribe();
    cancelLeave();
    takeVoiceMoved(null);
  };
}
