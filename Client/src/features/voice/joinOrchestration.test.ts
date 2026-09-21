import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Room } from "livekit-client";
import type { SessionState } from "./sessionState";

const store = vi.hoisted(() => ({ currentChannelId: null as number | null }));
vi.mock("../../stores/voice.store", () => ({
  voiceStore: { getState: () => store },
  leaveVoiceChannel: vi.fn(),
  setVoiceStatus: vi.fn(),
}));

vi.mock("../../lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { JoinOrchestration, type JoinHost } from "./joinOrchestration";

function fakeRoom(state = "connected"): Room {
  return {
    state,
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(async () => {}),
  } as unknown as Room;
}

function setup(initial: SessionState = { type: "idle" }) {
  let state = initial;
  let generation = 0;
  const host = {
    getState: () => state,
    setState: vi.fn((next: SessionState) => {
      state = next;
    }),
    nextJoinGeneration: vi.fn(() => ++generation),
    getRoom: () => (state.type === "connected" ? state.room : null),
    getE2EE: () => ({ clearState: vi.fn(), setupKeyExchange: vi.fn(async () => true) }),
    getAudioPipeline: () => ({ setRoom: vi.fn() }),
    getAudioElements: () => ({ setRoom: vi.fn() }),
    getDeviceManager: () => ({
      setRoom: vi.fn(),
      setAudioPipeline: vi.fn(),
      setOnError: vi.fn(),
      setOnToast: vi.fn(),
    }),
    getOnError: () => null,
    createRoom: vi.fn(async () => fakeRoom()),
    resolveLiveKitUrl: vi.fn(async (p: string) => p),
    restoreLocalVoiceState: vi.fn(async () => {}),
    reapplyMuteGain: vi.fn(),
    startTokenRefreshTimer: vi.fn(),
    syncModuleRooms: vi.fn(),
    leaveVoice: vi.fn(),
    handleVoiceTokenRefresh: vi.fn(),
    connectAndSetup: vi.fn(async () => true as const),
  };
  const join = new JoinOrchestration(host as unknown as JoinHost);
  return { host, join, getState: () => state };
}

beforeEach(() => {
  store.currentChannelId = null;
});

describe("isStateConnected", () => {
  it("is true only for the same channel and room", () => {
    const room = fakeRoom();
    const connected: SessionState = {
      type: "connected",
      room,
      channelId: 1,
      latestToken: "t",
      lastUrl: "u",
      lastDirectUrl: undefined,
    };
    const { join } = setup(connected);
    expect(join.isStateConnected(1, room)).toBe(true);
    expect(join.isStateConnected(2, room)).toBe(false);
    expect(join.isStateConnected(1, fakeRoom())).toBe(false);
    expect(setup().join.isStateConnected(1, room)).toBe(false);
  });
});

describe("disconnectSupersededLocalRoom", () => {
  it("disconnects only the passed room and re-syncs modules when idle", () => {
    const { host, join } = setup();
    const room = fakeRoom();
    join.disconnectSupersededLocalRoom(room);
    expect(room.removeAllListeners).toHaveBeenCalled();
    expect(room.disconnect).toHaveBeenCalled();
    expect(host.syncModuleRooms).toHaveBeenCalledOnce();
    expect(host.leaveVoice).not.toHaveBeenCalled();
  });

  it("leaves the modules alone while a newer attempt owns the state", () => {
    const { host, join } = setup({ type: "connecting", pendingJoin: null, joinGeneration: 9 });
    join.disconnectSupersededLocalRoom(fakeRoom());
    expect(host.syncModuleRooms).not.toHaveBeenCalled();
  });
});

describe("connectAndSetup", () => {
  it("returns superseded and drops its room when a newer attempt claims the state", async () => {
    const { host, join, getState } = setup();
    const room = fakeRoom();
    host.createRoom.mockImplementationOnce(async () => {
      host.setState({ type: "connecting", pendingJoin: null, joinGeneration: 99 });
      return room;
    });
    await expect(join.connectAndSetup("t", "u", 1)).resolves.toBe("superseded");
    expect(host.nextJoinGeneration).toHaveBeenCalledOnce();
    expect(room.disconnect).toHaveBeenCalled();
    expect(host.leaveVoice).not.toHaveBeenCalled();
    expect(getState()).toEqual({ type: "connecting", pendingJoin: null, joinGeneration: 99 });
  });
});

describe("handleVoiceToken", () => {
  it("takes the refresh path for the channel already connected", async () => {
    const room = fakeRoom();
    const { host, join } = setup({
      type: "connected",
      room,
      channelId: 1,
      latestToken: "old",
      lastUrl: "u",
      lastDirectUrl: undefined,
    });
    await join.handleVoiceToken("new", "u", 1);
    expect(host.handleVoiceTokenRefresh).toHaveBeenCalledWith("new");
    expect(host.connectAndSetup).not.toHaveBeenCalled();
  });

  it("queues the latest join while another attempt is connecting", async () => {
    const { host, join, getState } = setup({
      type: "connecting",
      pendingJoin: null,
      joinGeneration: 1,
    });
    await join.handleVoiceToken("t", "u", 2, "d", true);
    expect(getState()).toEqual({
      type: "connecting",
      joinGeneration: 1,
      pendingJoin: { token: "t", url: "u", channelId: 2, directUrl: "d", isKeyHolder: true },
    });
    expect(host.connectAndSetup).not.toHaveBeenCalled();
  });

  it("ignores a token for a channel the user already left", async () => {
    store.currentChannelId = 3;
    const { host, join } = setup();
    await join.handleVoiceToken("t", "u", 2);
    expect(host.connectAndSetup).not.toHaveBeenCalled();
  });

  it("connects through the host and drains a join queued meanwhile", async () => {
    store.currentChannelId = 2;
    const { host, join } = setup();
    host.connectAndSetup.mockImplementationOnce(async () => {
      host.setState({
        type: "connecting",
        joinGeneration: 1,
        pendingJoin: { token: "t2", url: "u2", channelId: 4 },
      });
      return true;
    });
    await join.handleVoiceToken("t", "u", 2);
    expect(host.connectAndSetup).toHaveBeenNthCalledWith(1, "t", "u", 2, undefined, undefined);
    expect(host.connectAndSetup).toHaveBeenNthCalledWith(2, "t2", "u2", 4, undefined, undefined);
  });
});
