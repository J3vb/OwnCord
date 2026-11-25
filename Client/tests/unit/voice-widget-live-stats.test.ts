// The voice widget is the only writer of the live stats store: every sample
// that reaches its signal readout also reaches the store, tagged with whether
// the call was connected. It still creates exactly one poller per call.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

const pollers = vi.hoisted(() => ({
  listeners: [] as Array<(stats: unknown) => void>,
  created: 0,
}));

vi.mock("../../src/features/voice/livekitSession", () => voiceSession.defaults());

vi.mock("@lib/voice/connectionStats", () => ({
  createConnectionStatsPoller: vi.fn().mockImplementation(() => {
    pollers.created++;
    const created = pollers.created;
    return {
      start: vi.fn(),
      stop: vi.fn(),
      // Before any sample the real poller reports empty, unavailable stats.
      getStats: vi.fn().mockReturnValue({
        rtt: 0,
        quality: "excellent",
        outRate: 0,
        inRate: 0,
        outPackets: created,
        inPackets: 0,
        totalUp: 0,
        totalDown: 0,
        loss: 0,
        jitter: 0,
        available: false,
      }),
      onUpdate: vi.fn().mockImplementation((cb: (stats: unknown) => void) => {
        pollers.listeners.push(cb);
        return () => {};
      }),
      onQualityChanged: vi.fn().mockReturnValue(() => {}),
    };
  }),
  formatBytes: (v: number) => `${v} B`,
  formatRateCompact: (v: number) => `${v} B/s`,
}));

import { createVoiceWidget } from "../../src/features/voice/VoiceWidget";
import { createConnectionStatsPoller } from "../../src/lib/voice/connectionStats";
import { voiceStore, type VoiceStatus } from "../../src/stores/voice.store";
import { setConnectionStatus } from "../../src/stores/ui.store";
import type { ConnectionStats } from "../../src/lib/voice/connectionStats";
import { liveStatsStore } from "../../src/lib/voice/liveStats";
import { resetMembersState } from "../helpers/storeResets";
import { resetChannelsState } from "../helpers/storeSeeds";
import { statsSample } from "../helpers/connectionStatsSample";

function inCall(channelId: number | null, voiceStatus: VoiceStatus): void {
  voiceStore.setState(() => ({
    currentChannelId: channelId,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: channelId === null ? null : 1,
    listenOnly: false,
    voiceStatus,
  }));
  voiceStore.flush();
}

/** Mounts the widget; afterEach empties the body. */
function mount(): ReturnType<typeof createVoiceWidget> {
  const host = document.body.appendChild(document.createElement("div"));
  const widget = createVoiceWidget({
    onDisconnect: vi.fn(),
    onCameraToggle: vi.fn(),
    onScreenshareToggle: vi.fn(),
  });
  widget.mount(host);
  return widget;
}

/** Hands one sample to every poller listener, as a poll would. */
function pushStats(over: Partial<ConnectionStats>): ConnectionStats {
  const stats = statsSample({ rtt: 0, ...over });
  pollers.listeners.forEach((cb) => cb(stats));
  return stats;
}

beforeEach(() => {
  pollers.listeners.length = 0;
  pollers.created = 0;
  liveStatsStore.setState(() => ({ stats: null, at: 0, connected: false }));
  liveStatsStore.flush();
  inCall(1, "connected");
  resetChannelsState();
  resetMembersState();
  setConnectionStatus("connected");
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("VoiceWidget writes the live stats store", () => {
  it("mounting in a call writes the poller's first state, not available", () => {
    const widget = mount();
    const live = liveStatsStore.getState();
    expect(live.stats?.available).toBe(false);
    expect(live.connected).toBe(true);
    expect(live.at).toBeGreaterThan(0);
    expect(createConnectionStatsPoller).toHaveBeenCalledTimes(1);
    widget.destroy?.();
  });

  it("a sample reaches both the signal readout and the store, tagged connected", () => {
    const widget = mount();
    const stats = pushStats({ rtt: 42 });
    expect(document.querySelector(".vw-signal .vw-ping")?.textContent).toBe("42ms");
    expect(liveStatsStore.getState().stats).toBe(stats);
    expect(liveStatsStore.getState().connected).toBe(true);
    expect(createConnectionStatsPoller).toHaveBeenCalledTimes(1);
    widget.destroy?.();
  });

  it("a sample while joining is tagged not connected", () => {
    const widget = mount();
    inCall(1, "joining");
    const stats = pushStats({ rtt: 30 });
    expect(liveStatsStore.getState().stats).toBe(stats);
    expect(liveStatsStore.getState().connected).toBe(false);
    widget.destroy?.();
  });

  it("leaving and rejoining replaces the store at once with the new poller's first state", () => {
    const widget = mount();
    pushStats({ rtt: 42 });
    expect(liveStatsStore.getState().stats?.available).toBe(true);

    inCall(null, "idle");
    inCall(2, "connected");
    expect(createConnectionStatsPoller).toHaveBeenCalledTimes(2);
    const live = liveStatsStore.getState();
    expect(live.stats?.available).toBe(false);
    // The second poller's own first state, not the first call's sample.
    expect(live.stats?.outPackets).toBe(2);
    widget.destroy?.();
  });
});
