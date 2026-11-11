// The `ready` voice slice and the moderator mute/deafen enforcement, split from
// wsHandlers.ts. Plain functions only: dispatcher.ts owns every subscription.
import { authStore } from "../../stores/auth.store";
import {
  voiceStore,
  setVoiceStates,
  setModeratorDeafened,
  restateSelfVoiceState,
  setPeerVideoDecode,
  setPeerKeySlots,
  setPeerBoundOffers,
  noteWatchingResync,
  clearPeerWatching,
} from "../../stores/voice.store";
import { ensureIdentityKeyPublished } from "../../lib/net/identity";
import { moderatorAudioPlan } from "./moderatorAudioPlan";
import { clearAfkMove } from "./moveHint";
import { livekitSession } from "../connection/dispatchContext";
import type { DispatchApi, DispatchWs, Payload } from "../connection/dispatchContext";
/**
 * Honor a moderator's mute/deafen locally. Mute is also enforced at the SFU,
 * but deafen governs what WE play back, so the client is the only place it
 * can take effect (Server/ws/voice_moderation.go: "enforced by the target's
 * client honoring server_deafened"). Both apply through one lazy import so
 * the two effects cannot land in different ticks.
 *
 * Called from both the incremental VOICE_STATE path and the full-resync
 * READY path (a WS drop that outlives the LiveKit session can mean a
 * moderator mute/deafen issued while disconnected is only ever delivered via
 * `ready`'s voice_states, never a voice_state the client could have missed).
 * The `!voice.localMuted`/`!voice.localDeafened` guards make it safe to call
 * from either path — or both, on the same session — without redundantly
 * re-invoking the livekit calls once already applied.
 *
 * A moderator restriction must also be released once it is lifted.
 * `setMuted`/`setDeafened` deliberately send no voice_mute/voice_deafen frame
 * (unlike the user's own toggle), so nothing else ever un-applies a
 * moderator-imposed local mute/deafen — without this, the falling edge
 * (server_muted/server_deafened going back to false) left the client
 * permanently silent/deaf while every peer's roster, and the server's own
 * voice_states row, said otherwise. `prevServerMuted`/`prevServerDeafened`
 * scope the release to the exact frame the restriction was lifted on (a
 * falling edge), rather than to every voice_state that happens to show the
 * flag already false — the latter would risk undoing an in-flight optimistic
 * self-mute from an unrelated restated voice_state (e.g. a camera toggle).
 * `selfMuted`/`selfDeafened` are the row's own muted/deafened fields (never
 * touched by moderation, always kept in sync with the user's own toggle via
 * voice_mute/voice_deafen) — requiring them to also be false before
 * releasing means a genuine self-mute that happens to coincide with the
 * moderator's release is never clobbered.
 *
 * Lifting a moderator deafen also clears the row's own deafen (the server
 * cannot tell whose it was), so a member who had deafened themselves before
 * the moderator did would hear the room again unasked. The client knows:
 * `moderatorDeafened` marks a deafen it applied for the moderator, so any
 * other deafen in effect at the lift is the member's own, kept and restated
 * to the server. It follows the local deafen, not the moderator flags, so a
 * moderator move (a leave that clears those flags, then a re-join that
 * restates them) cannot mistake the moderator's deafen for the member's.
 */
export function enforceModeratorAudioState(
  ws: DispatchWs,
  serverMuted: boolean,
  serverDeafened: boolean,
  prevServerMuted: boolean,
  prevServerDeafened: boolean,
  selfMuted: boolean,
  selfDeafened: boolean,
): void {
  const voice = voiceStore.getState();
  const plan = moderatorAudioPlan(
    voice,
    serverMuted,
    serverDeafened,
    prevServerMuted,
    prevServerDeafened,
    selfMuted,
    selfDeafened,
  );
  if (plan.applyDeafen) setModeratorDeafened(true);
  if (plan.deafenLifted) setModeratorDeafened(false);
  if (plan.keepOwnDeafen) ws.send({ type: "voice_deafen", payload: { deafened: true } });
  const { applyDeafen, applyMute, releaseMute, releaseDeafen } = plan;
  if (applyDeafen || applyMute || releaseMute || releaseDeafen) {
    void livekitSession().then(({ setDeafened, setMuted }) => {
      if (applyDeafen) setDeafened(true);
      if (applyMute) setMuted(true);
      if (releaseMute) setMuted(false);
      if (releaseDeafen) setDeafened(false);
    });
  }
}

/**
 * The voice slice of `ready`, in two steps. Call this first: it snapshots the
 * voice state `ready` is about to replace, and returns the function that
 * restates the voice states and reconciles a surviving session against that
 * snapshot.
 */
export function snapshotReadyVoice(): (ws: DispatchWs, payload: Payload<"ready">) => void {
  // Snapshot the current voice channel's peer roster BEFORE the
  // wholesale replace below, so the reconciliation branch further down
  // can tell who left while the socket was down. Must run before
  // setVoiceStates() overwrites voiceUsers with the fresh payload.
  const prevVoiceChannelId = voiceStore.getState().currentChannelId;
  const prevVoicePeerIds =
    prevVoiceChannelId !== null
      ? new Set(voiceStore.getState().voiceUsers.get(prevVoiceChannelId)?.keys() ?? [])
      : new Set<number>();
  // Same reasoning as the VOICE_STATE handler — snapshot the
  // pre-resync moderator flags before setVoiceStates() overwrites them,
  // so a moderator restriction lifted while we were disconnected (and
  // still applied locally from before the drop) is released here too.
  const prevSelfServerMuted = voiceStore.getState().localServerMuted ?? false;
  const prevSelfServerDeafened = voiceStore.getState().localServerDeafened ?? false;
  return (ws, payload) => {
    setVoiceStates(payload.voice_states);
    // A reconnect supersedes any AFK move still awaiting its join
    // acknowledgement: that move was abandoned, so it earns no toast.
    clearAfkMove();

    // A self row in `ready` while this device holds no call (voiceStatus
    // "idle") is another device's call: one account keeps a connection per
    // device and the server broadcasts the user's voice rows to all of them.
    // Do not send voice_leave and do not leaveVoiceChannel() — that would end
    // the other device's call. The server already retires this device's own
    // stale call when it connects afresh (e.g. after an F5 reload), so no
    // defensive leave is needed here; the row stays in the roster only.
    //
    // The store's lifecycle status stands in for livekitSession (lazily
    // imported): any status but "idle" means this device is driving a
    // session right now.
    const currentUserId = authStore.getState().user?.id ?? 0;
    const selfVoiceState =
      currentUserId !== 0
        ? payload.voice_states.find((vs) => vs.user_id === currentUserId)
        : undefined;
    const voiceSessionActive = voiceStore.getState().voiceStatus !== "idle";
    if (selfVoiceState !== undefined && voiceSessionActive) {
      // A LiveKit session survived a WS drop that outlived it (nothing
      // tears voice down on a socket drop alone): this full
      // resync is the only place a moderator mute/deafen issued while we
      // were disconnected ever reaches us, since the mustFullResync tier
      // that produced this `ready` never replays the voice_state that
      // would otherwise have carried it.
      enforceModeratorAudioState(
        ws,
        selfVoiceState.server_muted === true,
        selfVoiceState.server_deafened === true,
        prevSelfServerMuted,
        prevSelfServerDeafened,
        selfVoiceState.muted,
        selfVoiceState.deafened,
      );
      // The socket was down: tell the server any mute/deafen toggled meanwhile.
      // enforceModeratorAudioState applies its releases later, so a moderator
      // restriction in play on either side of the outage is left to it.
      const modMuted = prevSelfServerMuted || selfVoiceState.server_muted === true;
      const modDeafened = prevSelfServerDeafened || selfVoiceState.server_deafened === true;
      restateSelfVoiceState(ws, modMuted || modDeafened, modDeafened);
      // The server does not re-relay a resumed member's own watch set to
      // peers: send ours again, and keep the viewer sounds out of the re-sync.
      noteWatchingResync();
      clearPeerWatching();

      // Same gap, for E2EE. A full resync never replays the
      // voice_leave for anyone who departed our voice channel during the
      // outage — handleParticipantLeft (the only path that prunes a
      // departed peer's key, rotates for membership forward secrecy, and
      // re-runs the lowest-uid key-holder election) is otherwise only ever
      // driven by a live voice_leave frame. Without this, a departed peer
      // keeps a working room key indefinitely, and a client the server
      // just elected key holder on reconnect (Server/ws hub.go
      // registerNow -> updateKeyHolder) never self-elects. Only reconcile
      // when the resync's self voice state is for the SAME channel the
      // snapshot above was taken from — a channel change is out of scope
      // here and comparing rosters across two different channels would
      // misfire.
      const left: number[] = [];
      if (prevVoiceChannelId === selfVoiceState.channel_id) {
        const currentVoicePeerIds = new Set(
          payload.voice_states
            .filter((vs) => vs.channel_id === selfVoiceState.channel_id)
            .map((vs) => vs.user_id),
        );
        for (const uid of prevVoicePeerIds) {
          if (uid !== currentUserId && !currentVoicePeerIds.has(uid)) left.push(uid);
        }
      }
      // The same gap for the camera and share flags: an announce sent while
      // the socket was down never reached the server.
      for (const uid of left) {
        setPeerVideoDecode(uid, undefined);
        setPeerKeySlots(uid, false);
        setPeerBoundOffers(uid, false);
      }
      void livekitSession().then(
        ({ handleParticipantLeft, reconcileVideoFlags, resendWatching }) => {
          for (const uid of left) void handleParticipantLeft(uid);
          resendWatching();
          if (prevVoiceChannelId === selfVoiceState.channel_id)
            reconcileVideoFlags(
              selfVoiceState.camera === true,
              selfVoiceState.screenshare === true,
            );
        },
      );
    }
  };
}

/** The identity slice of `ready`: publish our identity public key. */
export function publishReadyIdentity(
  api: DispatchApi | undefined,
  payload: Payload<"ready">,
): void {
  const currentUserId = authStore.getState().user?.id ?? 0;
  // Publish our long-term identity public key so peers can pin+verify
  // us in voice. Idempotent (no PATCH when the server copy already matches)
  // and fire-and-forget — never block the ready flow. Username is required
  // by the server's profile update, so it rides along with the key.
  const self = payload.members.find((m) => m.id === currentUserId);
  const host = api?.getConfig?.().host;
  if (self !== undefined && currentUserId !== 0 && host && api?.updateProfile) {
    const updateProfile = api.updateProfile;
    void ensureIdentityKeyPublished(host, self.username, self.identity_public_key ?? null, (data) =>
      updateProfile(data),
    );
  }
}
