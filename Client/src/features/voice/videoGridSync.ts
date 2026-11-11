/** Keeping the video grid in step with the voice store: speaking rings, audio
 *  badges, stream viewers, tile labels, your call controls, and the grid's
 *  load on a join. */

import type { CallState } from "./videoGrid/VideoGrid";
import { SCREENSHARE_TILE_ID_OFFSET } from "@lib/constants";
import { uiStore } from "@stores/ui.store";
import { isSelfMuted, streamViewers, type VoiceState, type VoiceUser } from "@stores/voice.store";
import { isConnecting } from "./voiceStatusText";
import { shareBlockReason } from "./shareGate";
import type { PageState, MountScope } from "../../pages/main-page/pageState";

type Grid = NonNullable<PageState["videoGrid"]>;

/** What was last pushed to the grid, so only a change is pushed again. */
export type GridSyncMemo = Pick<
  MountScope,
  | "prevVideoSignature"
  | "prevSpeaking"
  | "prevAudioState"
  | "prevViewers"
  | "prevCallState"
  | "prevTileLabels"
  | "gridLoadChannel"
>;

export interface GridSyncDeps {
  readonly grid: () => Grid | null;
  /** The grid's code loads on a join, so the import overlaps the connect. */
  readonly ensureLoaded: () => void;
  readonly checkVideoMode: () => void;
  /** The label shown on a tile (the same identity a rename shows everywhere). */
  readonly tileLabel: (userId: number, isScreenshare: boolean) => string;
  readonly personName: (userId: number) => string | undefined;
  readonly syncCallState: (state: VoiceState) => void;
}

function rosterOf(state: VoiceState, channelId: number | null): Iterable<VoiceUser> {
  return channelId === null ? [] : (state.voiceUsers.get(channelId)?.values() ?? []);
}

/** Your call state for the grid's call controls, from the voice store and the
 *  chat socket (camera and share freeze while it is down). */
export function syncGridCallState(
  state: VoiceState,
  memo: Pick<GridSyncMemo, "prevCallState">,
  grid: () => Grid | null,
): void {
  const socket = uiStore.getState().connectionStatus;
  const shareBlock = shareBlockReason(state);
  const callState: CallState = {
    muted: isSelfMuted(state),
    deafened: state.localDeafened,
    listenOnly: state.listenOnly,
    camera: state.localCamera,
    screenshare: state.localScreenshare,
    connecting: isConnecting(state.voiceStatus),
    serverMuted: state.localServerMuted === true,
    serverDeafened: state.localServerDeafened === true,
    ...(socket === "connected" ? {} : { offline: socket }),
    ...(shareBlock === null ? {} : { shareBlock }),
  };
  const callKey = JSON.stringify(callState);
  if (callKey === memo.prevCallState) return;
  memo.prevCallState = callKey;
  grid()?.setCallState(callState);
}

/** Once per channel: a failed import retries on the next join, not on every
 *  voice update (speaking changes fire often). */
function loadGridOnChannelChange(
  channelId: number | null,
  memo: GridSyncMemo,
  deps: GridSyncDeps,
): void {
  if (channelId === memo.gridLoadChannel) return;
  memo.gridLoadChannel = channelId;
  if (channelId !== null) deps.ensureLoaded();
}

/** Speaking rings on the video tiles: only when who is speaking changes. */
function syncSpeaking(
  state: VoiceState,
  channelId: number | null,
  memo: GridSyncMemo,
  deps: GridSyncDeps,
): void {
  const talking = new Set<number>();
  for (const u of rosterOf(state, channelId)) {
    if (u.speaking && !u.muted) talking.add(u.userId);
  }
  const speakingKey = [...talking].join(",");
  if (speakingKey === memo.prevSpeaking) return;
  memo.prevSpeaking = speakingKey;
  deps.grid()?.setSpeaking(talking);
}

/** Mute/deafen badges on the camera tiles, from the same roster state. */
function syncAudioBadges(
  state: VoiceState,
  channelId: number | null,
  memo: GridSyncMemo,
  deps: GridSyncDeps,
): void {
  let audioKey = "";
  const audioState = new Map<number, { muted: boolean; deafened: boolean }>();
  for (const u of rosterOf(state, channelId)) {
    if (u.muted || u.deafened) {
      audioState.set(u.userId, { muted: u.muted, deafened: u.deafened });
      audioKey += `${String(u.userId)}:${String(u.muted)}${String(u.deafened)};`;
    }
  }
  if (audioKey === memo.prevAudioState) return;
  memo.prevAudioState = audioKey;
  deps.grid()?.setUserAudioState(audioState);
}

/** Eye + count on each screen-share tile: the other members watching it. */
function syncViewers(
  state: VoiceState,
  channelId: number | null,
  memo: GridSyncMemo,
  deps: GridSyncDeps,
): void {
  let viewersKey = "";
  const viewerNames = new Map<number, readonly string[]>();
  const roster = channelId !== null ? state.voiceUsers.get(channelId) : undefined;
  for (const u of roster?.values() ?? []) {
    if (!u.screenshare) continue;
    const names = streamViewers(u.userId, false, state).flatMap((id) => {
      const name = roster?.get(id)?.username;
      return name === undefined ? [] : [name];
    });
    if (names.length === 0) continue;
    viewerNames.set(u.userId, names);
    viewersKey += `${String(u.userId)}:${names.join("\u0000")};`;
  }
  if (viewersKey === memo.prevViewers) return;
  memo.prevViewers = viewersKey;
  deps.grid()?.setStreamViewers(viewerNames);
}

/**
 * Relabel an already-open remote tile whose display name changed (mid-call
 * rename) — addStream only runs once per tile, so nothing else keeps its
 * label in sync. setLabel() no-ops for a tile that isn't open yet.
 */
function relabelTile(
  tileId: number,
  label: string,
  name: string | undefined,
  memo: GridSyncMemo,
  deps: GridSyncDeps,
): void {
  if (memo.prevTileLabels.get(tileId) === label) return;
  memo.prevTileLabels.set(tileId, label);
  deps.grid()?.setLabel(tileId, label, name);
}

function relabelUserTiles(u: VoiceUser, uid: number, memo: GridSyncMemo, deps: GridSyncDeps): void {
  const name = deps.personName(uid) || undefined;
  if (u.camera) relabelTile(uid, deps.tileLabel(uid, false), name, memo, deps);
  if (u.screenshare) {
    relabelTile(uid + SCREENSHARE_TILE_ID_OFFSET, deps.tileLabel(uid, true), name, memo, deps);
  }
}

/**
 * The signature seeds with the channel id so ANY voice-channel switch changes
 * it, even one where the camera/screenshare flags happen to be identical on
 * both sides (e.g. both channels empty). Without this,
 * VideoModeController.checkVideoMode() — the only writer of its own
 * lastChannelId — never runs for that switch, so lastChannelId is still the
 * old channel the next time it runs (e.g. right after setOnRemoteVideo adds a
 * fresh remote tile), and it clears the grid it was just given.
 */
function voiceSignature(
  state: VoiceState,
  channelId: number | null,
  memo: GridSyncMemo,
  deps: GridSyncDeps,
): string {
  let sig =
    `${String(channelId)}|` +
    (state.localCamera ? `c${String(state.localCameraRev ?? 0)}` : "") +
    (state.localScreenshare ? `s${String(state.localShareRev ?? 0)}` : "");
  const users = channelId === null ? undefined : state.voiceUsers.get(channelId);
  for (const [uid, u] of users ?? []) {
    // Everyone in the call: the call view draws an avatar tile each.
    sig += `:u${uid}`;
    if (u.camera) sig += `:c${uid}`;
    if (u.screenshare) sig += `:s${uid}`;
    relabelUserTiles(u, uid, memo, deps);
  }
  return sig;
}

/** One voice store update, pushed to the grid. */
export function syncVideoGrid(state: VoiceState, memo: GridSyncMemo, deps: GridSyncDeps): void {
  const channelId = state.currentChannelId;
  loadGridOnChannelChange(channelId, memo, deps);
  syncSpeaking(state, channelId, memo, deps);
  syncAudioBadges(state, channelId, memo, deps);
  syncViewers(state, channelId, memo, deps);
  deps.syncCallState(state);
  const sig = voiceSignature(state, channelId, memo, deps);
  if (sig !== memo.prevVideoSignature) {
    memo.prevVideoSignature = sig;
    deps.checkVideoMode();
  }
}
