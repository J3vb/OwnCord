// B9-24 voice/media interaction polish (BPR-090, BPR-091).
//
// Each case pins one measured Q1 gap found while inventorying the voice widget
// and the video grid: the transport-stats toggle was pointer-only, the ping
// readout used a fill colour as text, a moderator-imposed mute/deafen was
// announced nowhere (a disabled control cannot take focus, so its title was
// unreachable), the tile audio overlay revealed only on hover, and a tile
// rebuild/removal dropped keyboard focus to <body>. jsdom never applies
// app.css, so the CSS-only facts (the focus-within reveal) are asserted in
// b9-voice-polish-css.test.ts.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@lib/livekitSession", () => ({
  getRoomForStats: vi.fn().mockReturnValue(null),
  retryMicPermission: vi.fn().mockResolvedValue(undefined),
  getUserVolume: vi.fn().mockReturnValue(100),
  setUserVolume: vi.fn(),
  getScreenshareAudioMuted: vi.fn().mockReturnValue(false),
  getScreenshareAudioVolume: vi.fn().mockReturnValue(1),
  muteScreenshareAudio: vi.fn(),
  setScreenshareAudioVolume: vi.fn(),
}));

vi.mock("@lib/connectionStats", () => ({
  createConnectionStatsPoller: vi.fn().mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
    onUpdate: vi.fn().mockReturnValue(() => {}),
    onQualityChanged: vi.fn().mockReturnValue(() => {}),
  }),
  formatBytes: vi.fn((v: number) => `${v} B`),
  formatRate: vi.fn((v: number) => `${v} B/s`),
  formatBitrate: vi.fn((v: number) => `${v} bps`),
}));

import { createVoiceWidget } from "../../src/components/VoiceWidget";
import { createVideoGrid, type TileConfig } from "../../src/components/VideoGrid";
import { voiceStore } from "../../src/stores/voice.store";
import { channelsStore } from "../../src/stores/channels.store";
import { membersStore } from "../../src/stores/members.store";
import { uiStore, setConnectionStatus } from "../../src/stores/ui.store";

function resetStores(): void {
  voiceStore.setState(() => ({
    currentChannelId: null,
    voiceUsers: new Map(),
    voiceConfigs: new Map(),
    localMuted: false,
    localDeafened: false,
    localCamera: false,
    localScreenshare: false,
    joinedAt: null,
    listenOnly: false,
    voiceStatus: "idle",
  }));
  channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
  membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
  setConnectionStatus("connected");
}

function mountWidget(container: HTMLElement) {
  const widget = createVoiceWidget({
    onDisconnect: vi.fn(),
    onMuteToggle: vi.fn(),
    onDeafenToggle: vi.fn(),
    onCameraToggle: vi.fn(),
    onScreenshareToggle: vi.fn(),
  });
  widget.mount(container);
  return widget;
}

function fakeStream(): MediaStream {
  return { getTracks: () => [], getVideoTracks: () => [] } as unknown as MediaStream;
}

const tileConfig: TileConfig = { isSelf: false, audioUserId: 42, isScreenshare: false };

beforeEach(() => {
  resetStores();
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("B9-24 voice widget", () => {
  it("makes the transport-stats toggle a real button with aria-expanded", () => {
    const container = document.createElement("div");
    const widget = mountWidget(container);

    const signal = container.querySelector<HTMLButtonElement>("[data-testid='vw-signal']");
    expect(signal).not.toBeNull();
    expect(signal!.tagName).toBe("BUTTON");
    expect(signal!.getAttribute("aria-expanded")).toBe("false");

    signal!.click();
    expect(container.querySelector(".vw-stats")!.classList.contains("visible")).toBe(true);
    expect(signal!.getAttribute("aria-expanded")).toBe("true");

    widget.destroy?.();
  });

  it("announces a moderator-imposed mute once, and clears it when lifted", () => {
    const container = document.createElement("div");
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 1 }));
    const widget = mountWidget(container);

    const status = container.querySelector("[data-testid='vw-mod-status']")!;
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("");

    voiceStore.setState((prev) => ({ ...prev, localServerMuted: true }));
    voiceStore.flush();
    expect(status.textContent).toBe("You were muted by a moderator");

    voiceStore.setState((prev) => ({ ...prev, localServerMuted: false }));
    voiceStore.flush();
    expect(status.textContent).toBe("");

    widget.destroy?.();
  });

  it("gives the stats pane a keyboard-reachable owner even while frozen", () => {
    const container = document.createElement("div");
    const widget = mountWidget(container);
    // The stats toggle stays operable when the socket is down: it is local UI,
    // not a signaling action, so it is never disabled by updateFrozen.
    setConnectionStatus("reconnecting");
    uiStore.flush();
    const signal = container.querySelector<HTMLButtonElement>("[data-testid='vw-signal']")!;
    expect(signal.disabled).toBe(false);
    widget.destroy?.();
  });
});

describe("B9-24 video grid focus stability", () => {
  function mountGrid() {
    const container = document.createElement("div");
    // jsdom only focuses elements connected to the document.
    document.body.appendChild(container);
    const grid = createVideoGrid();
    grid.mount(container);
    return { container, grid };
  }

  it("tags the tile audio controls that focus restore keys on", () => {
    const { container, grid } = mountGrid();
    grid.addStream(42, "alice", fakeStream(), tileConfig);
    const mute = container.querySelector(".tile-mute-btn")!;
    const slider = container.querySelector(".tile-volume-slider")!;
    expect(mute.getAttribute("data-tile-control")).toBe("mute");
    expect(slider.getAttribute("data-tile-control")).toBe("volume");
    grid.destroy?.();
  });

  it("keeps focus on the same control when a focused tile is re-laid out", () => {
    const { container, grid } = mountGrid();
    grid.addStream(1, "alice", fakeStream(), tileConfig);
    grid.addStream(2, "bob", fakeStream(), tileConfig);
    grid.setFocusedTile(1);

    const mute = container.querySelector<HTMLButtonElement>(
      ".video-cell[data-user-id='1'] .tile-mute-btn",
    )!;
    mute.focus();
    expect(document.activeElement).toBe(mute);

    // Rebuild the layout the way a tile add/update does; focus must survive.
    grid.setFocusedTile(2);
    grid.setFocusedTile(1);
    expect((document.activeElement as HTMLElement).dataset["tileControl"]).toBe("mute");
    expect(
      (document.activeElement as Element).closest(".video-cell")!.getAttribute("data-user-id"),
    ).toBe("1");
    grid.destroy?.();
  });

  it("moves focus to the grid, not another peer's control, when the focused peer leaves", () => {
    const { container, grid } = mountGrid();
    grid.addStream(1, "alice", fakeStream(), tileConfig);
    grid.addStream(2, "bob", fakeStream(), tileConfig);

    const mute = container.querySelector<HTMLButtonElement>(
      ".video-cell[data-user-id='1'] .tile-mute-btn",
    )!;
    mute.focus();
    expect(document.activeElement).toBe(mute);

    grid.removeStream(1);

    expect(document.activeElement).toBe(container.querySelector("[data-testid='video-grid']"));
    grid.destroy?.();
  });

  it("falls back to the grid itself when the last tile leaves with focus inside", () => {
    const { container, grid } = mountGrid();
    grid.addStream(1, "alice", fakeStream(), tileConfig);
    const mute = container.querySelector<HTMLButtonElement>(".tile-mute-btn")!;
    mute.focus();

    grid.removeStream(1);

    const root = container.querySelector("[data-testid='video-grid']")!;
    expect(document.activeElement).toBe(root);
    expect(root.getAttribute("tabindex")).toBe("-1");
    grid.destroy?.();
  });
});
