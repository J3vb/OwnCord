import { beforeEach, describe, expect, it, vi } from "vitest";
import { SCREENSHARE_TILE_ID_OFFSET } from "@lib/constants";
import { voiceStore, type VoiceState, type VoiceUser } from "@stores/voice.store";
import {
  syncGridCallState,
  syncVideoGrid,
  type GridSyncDeps,
  type GridSyncMemo,
} from "./videoGridSync";

const user = (userId: number, over: Partial<VoiceUser> = {}): VoiceUser => ({
  userId,
  username: `u${String(userId)}`,
  muted: false,
  deafened: false,
  speaking: false,
  camera: false,
  screenshare: false,
  ...over,
});

function voiceState(channelId: number | null, users: VoiceUser[], over: Partial<VoiceState> = {}) {
  const roster = new Map(users.map((u) => [u.userId, u]));
  return {
    ...voiceStore.getState(),
    currentChannelId: channelId,
    voiceUsers: channelId === null ? new Map() : new Map([[channelId, roster]]),
    ...over,
  } satisfies VoiceState;
}

function memo(): GridSyncMemo {
  return {
    prevVideoSignature: "",
    prevSpeaking: "",
    prevAudioState: "",
    prevViewers: "",
    prevCallState: "",
    prevTileLabels: new Map(),
    gridLoadChannel: null,
  };
}

function setup() {
  const grid = {
    setSpeaking: vi.fn(),
    setUserAudioState: vi.fn(),
    setStreamViewers: vi.fn(),
    setLabel: vi.fn(),
    setCallState: vi.fn(),
  };
  const deps: GridSyncDeps = {
    grid: () => grid as unknown as ReturnType<GridSyncDeps["grid"]>,
    ensureLoaded: vi.fn(),
    checkVideoMode: vi.fn(),
    tileLabel: (id, screen) => `${screen ? "screen" : "cam"}${String(id)}`,
    personName: (id) => `p${String(id)}`,
    syncCallState: vi.fn(),
  };
  return { grid, deps, memo: memo() };
}

describe("syncVideoGrid", () => {
  beforeEach(() => voiceStore.flush());

  it("loads the grid once per joined channel", () => {
    const { deps, memo: m } = setup();
    syncVideoGrid(voiceState(5, []), m, deps);
    syncVideoGrid(voiceState(5, []), m, deps);
    syncVideoGrid(voiceState(null, []), m, deps);
    expect(deps.ensureLoaded).toHaveBeenCalledTimes(1);
  });

  it("pushes mute and deafen badges only when they change", () => {
    const { grid, deps, memo: m } = setup();
    const state = voiceState(5, [user(1, { muted: true }), user(2), user(3, { deafened: true })]);
    syncVideoGrid(state, m, deps);
    syncVideoGrid(state, m, deps);
    expect(grid.setUserAudioState).toHaveBeenCalledTimes(1);
    expect([...grid.setUserAudioState.mock.calls[0]![0]]).toEqual([
      [1, { muted: true, deafened: false }],
      [3, { muted: false, deafened: true }],
    ]);
  });

  it("lists the other members watching each screen share", () => {
    const { grid, deps, memo: m } = setup();
    const state = voiceState(5, [user(1, { screenshare: true }), user(2), user(3)], {
      peerWatching: new Map([
        [2, [1]],
        [3, [1]],
      ]),
    });
    syncVideoGrid(state, m, deps);
    expect(grid.setStreamViewers).toHaveBeenCalledTimes(1);
    expect([...grid.setStreamViewers.mock.calls[0]![0]]).toEqual([[1, ["u2", "u3"]]]);
  });

  it("relabels camera and share tiles once and re-checks the video mode on a new signature", () => {
    const { grid, deps, memo: m } = setup();
    const state = voiceState(5, [user(1, { camera: true, screenshare: true })]);
    syncVideoGrid(state, m, deps);
    syncVideoGrid(state, m, deps);
    expect(grid.setLabel.mock.calls).toEqual([
      [1, "cam1", "p1"],
      [1 + SCREENSHARE_TILE_ID_OFFSET, "screen1", "p1"],
    ]);
    expect(deps.checkVideoMode).toHaveBeenCalledTimes(1);
    syncVideoGrid(voiceState(6, []), m, deps);
    expect(deps.checkVideoMode).toHaveBeenCalledTimes(2);
  });
});

/** A grid that records the call state it is given, and that sync's memo. */
function callStateSetup() {
  const setCallState = vi.fn();
  const grid = () => ({ setCallState }) as unknown as ReturnType<GridSyncDeps["grid"]>;
  return { setCallState, grid, seen: { prevCallState: "" } };
}

describe("syncGridCallState", () => {
  it("tells the grid when a phone call holds the call, once, and when it ends", () => {
    const { setCallState, grid, seen } = callStateSetup();
    syncGridCallState(voiceState(1, [], { phoneCallHold: true }), seen, grid);
    expect(setCallState).toHaveBeenLastCalledWith(expect.objectContaining({ phoneHold: true }));
    syncGridCallState(voiceState(1, [], { phoneCallHold: true }), seen, grid);
    expect(setCallState).toHaveBeenCalledTimes(1);

    syncGridCallState(voiceState(1, [], { phoneCallHold: false }), seen, grid);
    expect(setCallState).toHaveBeenCalledTimes(2);
    expect(setCallState.mock.calls[1]![0]).not.toHaveProperty("phoneHold");
  });

  it("holds nothing where there is no call", () => {
    const { setCallState, grid, seen } = callStateSetup();
    syncGridCallState(voiceState(null, [], { phoneCallHold: true }), seen, grid);
    expect(setCallState.mock.calls[0]![0]).not.toHaveProperty("phoneHold");
  });
});
