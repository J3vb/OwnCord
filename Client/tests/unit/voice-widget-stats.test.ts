// The transport-stats pane's redisign pass (captain 2026-09-30): values never
// wrap, a tidy two-column Outgoing/Incoming grid, empty values softened rather
// than shown as noise, and the screen-share active state carried by the
// button's own state instead of a squeezed text label.
//
// jsdom never applies app.css, so the visual rules are pinned separately in
// b9-voice-polish-css.test.ts; here we pin the DOM the redesign produces.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connectionStatsMock = vi.hoisted(() => ({ listeners: [] as unknown[] }));

vi.mock("@lib/livekitSession", () => ({
  getRoomForStats: vi.fn().mockReturnValue(null),
  retryMicPermission: vi.fn().mockResolvedValue(undefined),
  joinVoice: vi.fn(),
  leaveVoice: vi.fn(),
  toggleMute: vi.fn(),
  toggleDeafen: vi.fn(),
}));

vi.mock("@lib/connectionStats", () => ({
  createConnectionStatsPoller: vi.fn().mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
    getStats: vi.fn(),
    onUpdate: vi.fn().mockImplementation((cb: (stats: unknown) => void) => {
      (connectionStatsMock.listeners as Array<(stats: unknown) => void>).push(cb);
      return () => {};
    }),
    onQualityChanged: vi.fn().mockReturnValue(() => {}),
  }),
  formatBytes: (v: number) => `${v} B`,
  formatRate: (v: number) => `${v} B/s`,
  formatRateCompact: (v: number) => `${v} B/s`,
  formatBitrate: (v: number) => `${v} bps`,
}));

import { createVoiceWidget } from "../../src/components/VoiceWidget";
import { voiceStore } from "../../src/stores/voice.store";
import { channelsStore } from "../../src/stores/channels.store";
import { membersStore } from "../../src/stores/members.store";
import { setConnectionStatus } from "../../src/stores/ui.store";
import type { ConnectionStats } from "../../src/lib/connectionStats";

function resetStores(): void {
  voiceStore.setState(() => ({
    currentChannelId: 1,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    listenOnly: false,
    voiceStatus: "connected",
  }));
  channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
  membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
  setConnectionStatus("connected");
}

function mount(): { widget: ReturnType<typeof createVoiceWidget>; container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const widget = createVoiceWidget({
    onDisconnect: vi.fn(),
    onMuteToggle: vi.fn(),
    onDeafenToggle: vi.fn(),
    onCameraToggle: vi.fn(),
    onScreenshareToggle: vi.fn(),
  });
  widget.mount(container);
  return { widget, container };
}

function pushStats(partial: Partial<ConnectionStats>): void {
  const stats: ConnectionStats = {
    rtt: 0,
    quality: "excellent",
    outRate: 0,
    inRate: 0,
    outPackets: 0,
    inPackets: 0,
    totalUp: 0,
    totalDown: 0,
    ...partial,
  };
  for (const cb of connectionStatsMock.listeners as Array<(s: ConnectionStats) => void>) cb(stats);
}

beforeEach(() => {
  connectionStatsMock.listeners.length = 0;
  resetStores();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("VoiceWidget transport stats redesign", () => {
  it("lays the transport stats out as label/value rows in a two-column grid", () => {
    const { widget, container } = mount();
    const grid = container.querySelector(".vw-stats-grid")!;
    const cols = grid.querySelectorAll(".vw-stats-col");
    expect(cols).toHaveLength(2);

    const outRows = cols[0]!.querySelectorAll(".vw-stats-row");
    // Outgoing: Rate, Packets, RTT — one label/value pair each.
    expect(outRows).toHaveLength(3);
    expect(outRows[0]!.querySelector(".vw-stat-label")!.textContent).toBe("Rate");
    expect(outRows[1]!.querySelector(".vw-stat-label")!.textContent).toBe("Packets");
    expect(outRows[2]!.querySelector(".vw-stat-label")!.textContent).toBe("RTT");
    for (const row of outRows) {
      expect(row.querySelector(".vw-stat-value")).not.toBeNull();
      // No <br> separators: the redesign uses rows, not line breaks.
      expect(row.querySelector("br")).toBeNull();
    }

    const inRows = cols[1]!.querySelectorAll(".vw-stats-row");
    expect(inRows).toHaveLength(2);
    expect(inRows[0]!.querySelector(".vw-stat-label")!.textContent).toBe("Rate");
    expect(inRows[1]!.querySelector(".vw-stat-label")!.textContent).toBe("Packets");

    widget.destroy?.();
  });

  it("shows a single-unit compact rate (no separate Mbps figure)", () => {
    const { widget, container } = mount();
    pushStats({ outRate: 331_250, outPackets: 2305, rtt: 18 });

    const outValues = container.querySelectorAll(".vw-stats-col")[0]!.querySelectorAll(".vw-stat-value");
    expect(outValues[0]!.textContent).toBe("331250 B/s");
    expect(outValues[0]!.textContent).not.toContain("bps");

    widget.destroy?.();
  });

  it("softens empty values (zero rate, zero packets, missing RTT) instead of shouting them", () => {
    const { widget, container } = mount();
    pushStats({ outRate: 0, inRate: 0, rtt: 0 });

    const outRows = container.querySelectorAll(".vw-stats-col")[0]!.querySelectorAll(".vw-stats-row");
    const rttValue = outRows[2]!.querySelector(".vw-stat-value")!;
    expect(rttValue.textContent).toBe("—");
    expect(rttValue.classList.contains("vw-stat-value--empty")).toBe(true);

    const inRows = container.querySelectorAll(".vw-stats-col")[1]!.querySelectorAll(".vw-stats-row");
    expect(inRows[0]!.querySelector(".vw-stat-value")!.classList.contains("vw-stat-value--empty")).toBe(
      true,
    );

    widget.destroy?.();
  });

  it("does not mark a live value as empty", () => {
    const { widget, container } = mount();
    pushStats({ outRate: 331_250, outPackets: 2305, rtt: 42 });

    const outRows = container.querySelectorAll(".vw-stats-col")[0]!.querySelectorAll(".vw-stats-row");
    const rttValue = outRows[2]!.querySelector(".vw-stat-value")!;
    expect(rttValue.textContent).toBe("42.0 ms");
    expect(rttValue.classList.contains("vw-stat-value--empty")).toBe(false);

    widget.destroy?.();
  });

  it("carries the screen-share active state on the button itself, with no text label", () => {
    voiceStore.setState((prev) => ({ ...prev, localScreenshare: true }));
    const { widget, container } = mount();

    const shareBtn = container.querySelector('[aria-label="Screenshare"]')!;
    expect(shareBtn.getAttribute("aria-pressed")).toBe("true");
    expect(shareBtn.classList.contains("active-ctrl")).toBe(true);
    // The redesign removes the squeezed "Sharing" text label.
    expect(container.querySelector(".vw-share-label")).toBeNull();

    widget.destroy?.();
  });
});
