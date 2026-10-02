// The voice connection panel redesign (captain 2026-09-30, Option C "detailed
// but tidy"): a two-line header (status + timer, then channel + a small
// Secured chip + ping), Upload and Download tiles each with a big rate and a
// packet count, one quiet footer with the RTT (hidden while unknown) and the
// session totals, and the screen-share state carried by the button itself.
//
// jsdom never applies app.css, so the visual rules are pinned separately in
// b9-voice-polish-css.test.ts; here we pin the DOM the redesign produces.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const connectionStatsMock = vi.hoisted(() => ({
  listeners: [] as unknown[],
  qualityListeners: [] as unknown[],
}));

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
    // Before any sample the real poller reports empty, unavailable stats.
    getStats: vi.fn().mockReturnValue({
      rtt: 0,
      quality: "excellent",
      outRate: 0,
      inRate: 0,
      outPackets: 0,
      inPackets: 0,
      totalUp: 0,
      totalDown: 0,
      available: false,
    }),
    onUpdate: vi.fn().mockImplementation((cb: (stats: unknown) => void) => {
      (connectionStatsMock.listeners as Array<(stats: unknown) => void>).push(cb);
      return () => {};
    }),
    onQualityChanged: vi.fn().mockImplementation((cb: unknown) => {
      connectionStatsMock.qualityListeners.push(cb);
      return () => {};
    }),
  }),
  formatBytes: (v: number) => `${v} B`,
  formatRateCompact: (v: number) => `${v} B/s`,
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
    loss: 0,
    jitter: 0,
    available: true,
    ...partial,
  };
  for (const cb of connectionStatsMock.listeners as Array<(s: ConnectionStats) => void>) cb(stats);
}

function fireQualityChange(quality: string, prevQuality: string): void {
  for (const cb of connectionStatsMock.qualityListeners as Array<(q: string, p: string) => void>) {
    cb(quality, prevQuality);
  }
}

beforeEach(() => {
  connectionStatsMock.listeners.length = 0;
  connectionStatsMock.qualityListeners.length = 0;
  resetStores();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("VoiceWidget connection panel (Option C)", () => {
  it("splits the header into status + timer, then channel + Secured chip + ping", () => {
    const { widget, container } = mount();
    const header = container.querySelector(".vw-header")!;
    const main = header.querySelector(".vw-header-main")!;
    const sub = header.querySelector(".vw-header-sub")!;
    expect(main.querySelector("[data-testid='vw-status']")).not.toBeNull();
    expect(main.querySelector(".vw-timer")).not.toBeNull();
    expect(sub.querySelector(".vw-channel")).not.toBeNull();
    expect(sub.querySelector("[data-testid='vw-secured']")).not.toBeNull();
    expect(sub.querySelector("[data-testid='vw-signal']")).not.toBeNull();

    // The chip is an icon plus a plain word: no emoji crammed into the line.
    const chip = sub.querySelector("[data-testid='vw-secured']")!;
    expect(chip.textContent).toBe("Secured");
    expect(chip.querySelector("svg")).not.toBeNull();

    widget.destroy?.();
  });

  it("keeps the degraded chip visible but never reading Secured", () => {
    voiceStore.setState((prev) => ({ ...prev, encryptionDegraded: true }));
    const { widget, container } = mount();
    const chip = container.querySelector("[data-testid='vw-secured']")!;
    expect(chip.textContent).toBe("Unsecured");
    expect(chip.classList.contains("vw-secured--degraded")).toBe(true);
    expect(chip.querySelector("svg")).not.toBeNull();
    widget.destroy?.();
  });

  it("shows Upload and Download tiles, each with a rate and a packet count", () => {
    const { widget, container } = mount();
    const pane = container.querySelector(".vw-stats")!;
    // The visible title is gone; the pane keeps it as its accessible name.
    expect(pane.querySelector(".vw-stats-title")).toBeNull();
    expect(pane.getAttribute("role")).toBe("group");
    expect(pane.getAttribute("aria-label")).toBe("Transport Statistics");

    const tiles = pane.querySelectorAll(".vw-stats-grid .vw-stats-tile");
    expect(tiles).toHaveLength(2);
    expect(tiles[0]!.querySelector(".vw-stats-tile-label")!.textContent).toContain("Upload");
    expect(tiles[1]!.querySelector(".vw-stats-tile-label")!.textContent).toContain("Download");
    for (const tile of tiles) {
      expect(tile.querySelector(".vw-stat-rate")).not.toBeNull();
      expect(tile.querySelector(".vw-stat-packets")).not.toBeNull();
    }

    pushStats({ outRate: 331_250, outPackets: 2305, inRate: 42_600, inPackets: 1 });
    expect(tiles[0]!.querySelector(".vw-stat-rate")!.textContent).toBe("331250 B/s");
    expect(tiles[0]!.querySelector(".vw-stat-packets")!.textContent).toBe("2,305 packets");
    expect(tiles[1]!.querySelector(".vw-stat-rate")!.textContent).toBe("42600 B/s");
    expect(tiles[1]!.querySelector(".vw-stat-packets")!.textContent).toBe("1 packet");
    for (const tile of tiles) {
      expect(tile.querySelector(".vw-stat-rate")!.classList.contains("vw-stat-value--empty")).toBe(
        false,
      );
    }

    widget.destroy?.();
  });

  it("reads an idle direction as Idle / no packets, softened", () => {
    const { widget, container } = mount();
    pushStats({ outRate: 331_250, outPackets: 2305, inRate: 0, inPackets: 0 });

    const download = container.querySelectorAll(".vw-stats-tile")[1]!;
    const rate = download.querySelector(".vw-stat-rate")!;
    expect(rate.textContent).toBe("Idle");
    expect(rate.classList.contains("vw-stat-value--empty")).toBe(true);
    expect(download.querySelector(".vw-stat-packets")!.textContent).toBe("no packets");

    widget.destroy?.();
  });

  it("shows the RTT in the footer only once it is known", () => {
    const { widget, container } = mount();
    const footer = container.querySelector(".vw-stats-footer")!;

    pushStats({ rtt: 0, totalUp: 2360, totalDown: 631 });
    expect(footer.textContent).not.toContain("RTT");
    expect(footer.textContent).not.toContain("—");
    expect(footer.querySelector(".vw-stats-footer-lead")!.textContent).toBe("Session");

    pushStats({ rtt: 42, totalUp: 2360, totalDown: 631 });
    const lead = footer.querySelector(".vw-stats-footer-lead")!;
    expect(lead.textContent).toBe("RTT 42.0 ms");
    expect(lead.querySelector(".vw-stat-value")!.textContent).toBe("42.0 ms");

    widget.destroy?.();
  });

  it("puts the session totals on the footer line", () => {
    const { widget, container } = mount();
    pushStats({ totalUp: 2360, totalDown: 631 });
    const totals = container.querySelectorAll(".vw-stats-footer .vw-stat-total .vw-stat-value");
    expect(totals).toHaveLength(2);
    expect(totals[0]!.textContent).toBe("2360 B");
    expect(totals[1]!.textContent).toBe("631 B");
    widget.destroy?.();
  });

  it("a quality drop to poor does not add `visible` to the stats pane", () => {
    const { widget, container } = mount();
    const pane = container.querySelector(".vw-stats")!;
    // The pane starts closed and manual toggling still owns it: a quality
    // change must never open it on its own.
    expect(pane.classList.contains("visible")).toBe(false);

    // The drop arrives both as a live sample and as the debounced change.
    pushStats({ quality: "poor", rtt: 300 });
    expect(container.querySelector(".vw-signal .vw-ping")?.textContent).toBe("300ms");
    fireQualityChange("poor", "excellent");

    expect(pane.classList.contains("visible")).toBe(false);

    widget.destroy?.();
  });

  it("keeps five equal controls with the screen-share state on the button, no text label", () => {
    voiceStore.setState((prev) => ({ ...prev, localScreenshare: true }));
    const { widget, container } = mount();

    expect(container.querySelectorAll(".vw-controls button")).toHaveLength(5);
    const shareBtn = container.querySelector('[aria-label="Screenshare"]')!;
    expect(shareBtn.getAttribute("aria-pressed")).toBe("true");
    expect(shareBtn.classList.contains("active-ctrl")).toBe(true);
    expect(shareBtn.textContent).toBe("");
    expect(container.querySelector(".vw-share-label")).toBeNull();

    widget.destroy?.();
  });
});
