// The voice connection panel redesign (captain 2026-09-30, Option C "detailed
// but tidy"): a two-line header (status + timer, then channel + a small
// Secured chip + ping), Upload and Download tiles each with a big rate and a
// packet count, one quiet footer with the RTT (hidden while unknown) and the
// session totals, and the screen-share state carried by the button itself.
//
// jsdom never applies app.css, so the visual rules are pinned separately in
// voice-polish-css.test.ts; here we pin the DOM the redesign produces.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

const connectionStatsMock = vi.hoisted(() => ({
  listeners: [] as unknown[],
  qualityListeners: [] as unknown[],
}));

vi.mock("../../src/features/voice/livekitSession", () => voiceSession.defaults());

vi.mock("@lib/voice/connectionStats", () => ({
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
      const listeners = connectionStatsMock.listeners as Array<(stats: unknown) => void>;
      listeners.push(cb);
      // A stopped poller's listener hears nothing more.
      return () => listeners.splice(listeners.indexOf(cb), 1);
    }),
    onQualityChanged: vi.fn().mockImplementation((cb: unknown) => {
      connectionStatsMock.qualityListeners.push(cb);
      return () => {};
    }),
  }),
  formatBytes: (v: number) => `${v} B`,
  formatRateCompact: (v: number) => `${v} B/s`,
}));

import { createVoiceWidget } from "../../src/features/voice/VoiceWidget";
import { voiceStore } from "../../src/stores/voice.store";
import { setConnectionStatus } from "../../src/stores/ui.store";
import type { ConnectionStats } from "../../src/lib/voice/connectionStats";
import { resetMembersState } from "../helpers/storeResets";
import { resetChannelsState } from "../helpers/storeSeeds";

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
  resetChannelsState();
  resetMembersState();
  setConnectionStatus("connected");
}

function mount(): { widget: ReturnType<typeof createVoiceWidget>; container: HTMLDivElement } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const widget = createVoiceWidget({
    onDisconnect: vi.fn(),
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

  it("leads the connection card with the quality and the ping, the session in its footer", () => {
    const { widget, container } = mount();
    const pane = container.querySelector(".vw-stats")!;
    const ping = pane.querySelector("[data-testid='vw-conn-ping']")!;
    const pill = pane.querySelector<HTMLElement>("[data-testid='vw-conn-quality']")!;
    expect(pane.querySelector(".vw-card-eyebrow")!.textContent).toBe("Connection");
    // No sample yet: no number and no verdict.
    expect(ping.textContent).toBe("—");
    expect(pill.hidden).toBe(true);

    pushStats({ rtt: 0, totalUp: 2360, totalDown: 631 });
    expect(ping.textContent).toBe("—");
    expect(pill.textContent).toBe("Good");
    expect(pane.querySelector(".vw-stats-footer-lead")!.textContent).toBe("This session");
    expect(pane.querySelector(".vw-stats-footer")!.textContent).not.toContain("RTT");

    pushStats({ rtt: 42.4, quality: "fair" });
    expect(ping.textContent).toBe("42");
    expect(pill.textContent).toBe("Fair");
    expect(pill.dataset["quality"]).toBe("fair");
    expect(pane.querySelector(".vw-conn-secured")!.textContent).toBe("Secured");

    widget.destroy?.();
  });

  it("meters each direction's rate", () => {
    const { widget, container } = mount();
    pushStats({ outRate: 250_000, inRate: 0 });
    const meters = container.querySelectorAll<HTMLElement>(".vw-stat-meter-fill");
    expect(meters[0]!.style.width).toBe("50%");
    expect(meters[1]!.style.width).toBe("0%");
    widget.destroy?.();
  });

  it("opens the card as a popover over the ping button under Deck, closed by Esc", () => {
    document.documentElement.classList.add("layout-deck");
    const { widget, container } = mount();
    try {
      const pane = container.querySelector<HTMLElement>("[data-testid='vw-stats']")!;
      const signal = container.querySelector<HTMLButtonElement>(".vw-signal")!;
      expect(pane.classList.contains("vw-pop")).toBe(true);
      expect(signal.getAttribute("aria-haspopup")).toBe("dialog");
      signal.click();
      expect(pane.classList.contains("visible")).toBe(true);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(pane.classList.contains("visible")).toBe(false);
      expect(signal.getAttribute("aria-expanded")).toBe("false");
      signal.click();
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(pane.classList.contains("visible")).toBe(false);
    } finally {
      widget.destroy?.();
      document.documentElement.classList.remove("layout-deck");
    }
  });

  describe("the ping graph", () => {
    const points = (container: HTMLElement): string[] => {
      const line = container.querySelector(".vw-spark-line")!.getAttribute("points") ?? "";
      return line === "" ? [] : line.split(" ");
    };

    it("draws one point per sample, skipping the polls with no ping", () => {
      const { widget, container } = mount();
      pushStats({ rtt: 30 });
      pushStats({ rtt: 0 });
      pushStats({ rtt: 40 });
      pushStats({ rtt: 35, available: false });
      expect(points(container)).toHaveLength(2);
      expect(container.querySelector(".vw-spark-fill")!.getAttribute("d")).toMatch(/^M0 46 L/);
      widget.destroy?.();
    });

    it("starts over for the new call when the call switches, with no old pings", () => {
      const { widget, container } = mount();
      container.querySelector<HTMLButtonElement>(".vw-signal")!.click();
      pushStats({ rtt: 30 });
      pushStats({ rtt: 31 });
      expect(points(container)).toHaveLength(2);

      voiceStore.setState((prev) => ({ ...prev, currentChannelId: 2 }));
      voiceStore.flush();
      expect(points(container)).toEqual([]);
      // Only the new call's poller is heard; the card stays open.
      pushStats({ rtt: 80 });
      expect(points(container)).toHaveLength(1);
      expect(container.querySelector(".vw-stats")!.classList.contains("visible")).toBe(true);
      widget.destroy?.();
    });

    it("starts over when the link drops, and again once it is back", () => {
      const { widget, container } = mount();
      pushStats({ rtt: 30 });
      pushStats({ rtt: 31 });

      voiceStore.setState((prev) => ({ ...prev, voiceStatus: "reconnecting" }));
      voiceStore.flush();
      expect(points(container)).toEqual([]);
      pushStats({ rtt: 900 });

      voiceStore.setState((prev) => ({ ...prev, voiceStatus: "connected", joinedAt: 5 }));
      voiceStore.flush();
      expect(points(container)).toEqual([]);
      pushStats({ rtt: 32 });
      expect(points(container)).toHaveLength(1);
      widget.destroy?.();
    });

    it("keeps the history across store updates within the same call", () => {
      const { widget, container } = mount();
      pushStats({ rtt: 30 });
      voiceStore.setState((prev) => ({ ...prev, localMuted: true }));
      voiceStore.flush();
      pushStats({ rtt: 31 });
      expect(points(container)).toHaveLength(2);
      widget.destroy?.();
    });

    it("forgets the call's pings when you leave", () => {
      const { widget, container } = mount();
      pushStats({ rtt: 30 });
      voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
      voiceStore.flush();
      expect(points(container)).toEqual([]);
      expect(connectionStatsMock.listeners).toHaveLength(0);
      widget.destroy?.();
    });
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

  it("reads the signal button as collapsed again after the call ends", () => {
    const { widget, container } = mount();
    try {
      const signal = container.querySelector<HTMLButtonElement>(".vw-signal")!;
      signal.click();
      expect(signal.getAttribute("aria-expanded")).toBe("true");

      voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
      voiceStore.flush();
      expect(container.querySelector(".vw-stats")!.classList.contains("visible")).toBe(false);
      expect(signal.getAttribute("aria-expanded")).toBe("false");
    } finally {
      widget.destroy?.();
    }
  });

  it("keeps four equal controls with the screen-share state on the button, no text label", () => {
    voiceStore.setState((prev) => ({ ...prev, localScreenshare: true }));
    const { widget, container } = mount();

    // Mute and deafen moved to the user panel (WP 1D-1).
    // Camera, screen share, Share music and Disconnect.
    expect(container.querySelectorAll(".vw-controls button")).toHaveLength(4);
    const shareBtn = container.querySelector('[aria-label="Screenshare"]')!;
    expect(shareBtn.getAttribute("aria-pressed")).toBe("true");
    expect(shareBtn.classList.contains("active-ctrl")).toBe(true);
    expect(shareBtn.textContent).toBe("");
    expect(container.querySelector(".vw-share-label")).toBeNull();

    widget.destroy?.();
  });
});
