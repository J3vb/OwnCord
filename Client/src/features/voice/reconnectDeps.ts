// What the auto-reconnect loop (lib/voice/livekitReconnect.ts) needs from the
// voice session. Types only.
import type { Room } from "livekit-client";
import type { SessionState } from "./sessionState";

/** What the voice roster says about the membership the old token belongs to. */
export type ServerMembership = "held" | "released" | "unknown";

export interface ReconnectDeps {
  sweepPublications(room: Room): void;
  /** Current session state accessor. */
  getState: () => SessionState;
  /** Transition to a new state. */
  setState: (state: SessionState) => void;
  /** Sync extracted modules (AudioPipeline, AudioElements, DeviceManager) to the room
   *  in the CURRENT shared state. Only correct where that state is the one to follow —
   *  the abort/failure paths. Mid-attempt, use setModuleRooms instead. */
  syncModuleRooms: () => void;
  /** Point the extracted modules at THIS attempt's room.
   *
   *  Not syncModuleRooms(): that reads the room out of the shared state, and at
   *  the point this is called the state is still "reconnecting", which is
   *  room-less. Syncing there wires every module to null, so the reconnect
   *  finishes with no audio pipeline and no remote-subscription handling —
   *  deafen silently stops being re-applied. */
  setModuleRooms: (room: Room) => void;
  /** Create a new Room with E2EE wired up. */
  createRoom: () => Promise<Room>;
  /** Resolve a LiveKit URL. */
  resolveUrl: (proxyPath: string, directUrl?: string) => Promise<string>;
  /** Re-announce E2EE for the new session (forward secrecy). */
  reannounceE2EE: () => Promise<void>;
  /** Restore local voice state (mic, deafen, PTT). */
  restoreLocalVoiceState: (mode: "join" | "reconnect") => Promise<void>;
  /** Start the token refresh timer. */
  startTokenRefreshTimer: () => void;
  /** Request a token refresh. */
  requestTokenRefresh: () => void;
  /** Request a token refresh and wait for the reply (bounded), so the next
   *  attempt reads the fresh token from the state. */
  refreshTokenAndWait: () => Promise<void>;
  /** Milliseconds since the current token arrived. */
  tokenAgeMs: () => number;
  /** True while the chat socket is connected or reconnecting (not closed for
   *  good: sign-out, session replaced, auth failure) and the channel still
   *  exists — every attempt's precondition (P2-T5). */
  canKeepRetrying: () => boolean;
  /** Whether the server still holds the membership the old token belongs to,
   *  read from the voice roster — "unknown" while the chat socket is not
   *  connected, since the roster cannot update then. Resolves only once the
   *  socket's own ready or resume replay is applied: a socket reads
   *  "connected" from its auth_ok, while the roster still shows the drop. */
  serverMembership: () => Promise<ServerMembership>;
  /** Tear the session down and send voice_join for the same channel, so the
   *  ordinary join path (E2EE, device prefs) resumes the call. Only called
   *  once serverMembership() reads "released". */
  rejoinVoice: () => void;
  /** Full session teardown, sending voice_leave to the server when the chat
   *  socket is connected (a socket still reconnecting cannot carry it; the
   *  server's grace window and reaper retire the membership instead).
   *
   *  Not a bare voice_leave frame: the give-up path is a real leave, so it owes
   *  the session everything leaveVoice(true) does — state back to "idle", the
   *  E2EE worker terminated so the last room key does not stay resident, timers
   *  cleared, and the FULL audio-element cleanup that also clears per-call
   *  screenshare mute/volume state (the reconnect-flavoured cleanup
   *  deliberately preserves it). Only ever called once the caller has
   *  confirmed it still owns the session (the give-up path is not superseded;
   *  a late failure's room is still the connected one) — this teardown is
   *  global, so a superseded loop calling it would kill the live session that
   *  replaced it (Client/CLAUDE.md: voice sessions are superseded, not
   *  cancelled). */
  leaveVoice: () => void;
  /** Error callback. */
  onError: (message: string) => void;
  /** True when the shared state is still THIS attempt's connected room. */
  isStateConnected: (channelId: number, room: Room) => boolean;
  /** Tear down a room this attempt no longer owns. */
  disconnectSupersededLocalRoom: (room: Room) => void;
  /** Rebuild the audio pipeline against the new room. */
  setupAudioPipeline: () => void;
  /** Re-apply mute gain once the pipeline is rebuilt. */
  reapplyMuteGain: () => void;
  /** Clear the pending-reconnect fields now the tail has completed. */
  clearPendingReconnectFields: () => void;
  /** Tell the user about a camera or screen share the drop stopped. Only a
   *  reconnect that got all the way through calls it. */
  noticeLostMedia: () => void;
}
