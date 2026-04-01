import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRetryMicPermission = vi.fn().mockResolvedValue(undefined);
vi.mock("@lib/livekitSession", () => ({
  getRoomForStats: vi.fn().mockReturnValue(null),
  retryMicPermission: (...args: unknown[]) => mockRetryMicPermission(...args),
  joinVoice: vi.fn(),
  leaveVoice: vi.fn(),
  toggleMute: vi.fn(),
  toggleDeafen: vi.fn(),
}));

vi.mock("@lib/connectionStats", () => ({
  createConnectionStatsPoller: vi.fn().mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
    getStats: vi.fn().mockReturnValue({
      rtt: 0,
      quality: "excellent",
      outRate: 0,
      inRate: 0,
      outPackets: 0,
      inPackets: 0,
      totalUp: 0,
      totalDown: 0,
    }),
    onUpdate: vi.fn().mockReturnValue(() => {}),
    onQualityChanged: vi.fn().mockReturnValue(() => {}),
  }),
  formatBytes: vi.fn((v: number) => `${v} B`),
  formatRate: vi.fn((v: number) => `${v} B/s`),
  formatBitrate: vi.fn((v: number) => `${v} bps`),
}));

import { createVoiceWidget } from "@components/VoiceWidget";
import { voiceStore } from "@stores/voice.store";
import { channelsStore } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";

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
  }));
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
    roles: [],
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
}

function setVoiceConnected(screenshare = false): void {
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map([
      [1, { id: 1, name: "Voice", type: "voice" as const, category: null, position: 0 }],
    ]),
  }));
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: 1,
    localScreenshare: screenshare,
    joinedAt: Date.now(),
  }));
}

describe("Screen Share Button in VoiceWidget", () => {
  let container: HTMLDivElement;
  let comp: ReturnType<typeof createVoiceWidget>;
  let handlers: {
    onDisconnect: ReturnType<typeof vi.fn>;
    onMuteToggle: ReturnType<typeof vi.fn>;
    onDeafenToggle: ReturnType<typeof vi.fn>;
    onCameraToggle: ReturnType<typeof vi.fn>;
    onScreenshareToggle: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
    handlers = {
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    };
  });

  afterEach(() => {
    comp?.destroy?.();
    container.remove();
    resetStores();
  });

  it("clicking share button calls onScreenshareToggle", () => {
    setVoiceConnected();
    comp = createVoiceWidget(handlers);
    comp.mount(container);

    const shareBtn = container.querySelector('[aria-label="Screenshare"]') as HTMLButtonElement;
    expect(shareBtn).not.toBeNull();
    shareBtn.click();

    expect(handlers.onScreenshareToggle).toHaveBeenCalledOnce();
  });

  it("share button has aria-pressed=true when screenshare is active", () => {
    setVoiceConnected(true);
    comp = createVoiceWidget(handlers);
    comp.mount(container);

    const shareBtn = container.querySelector('[aria-label="Screenshare"]') as HTMLButtonElement;
    expect(shareBtn).not.toBeNull();
    expect(shareBtn.getAttribute("aria-pressed")).toBe("true");
  });

  it("share button has active-ctrl and sharing-active class when screensharing", () => {
    setVoiceConnected(true);
    comp = createVoiceWidget(handlers);
    comp.mount(container);

    const shareBtn = container.querySelector('[aria-label="Screenshare"]') as HTMLButtonElement;
    expect(shareBtn.classList.contains("active-ctrl")).toBe(true);
    expect(shareBtn.classList.contains("sharing-active")).toBe(true);
  });

  it("share button shows 'Sharing' label when active", () => {
    setVoiceConnected(true);
    comp = createVoiceWidget(handlers);
    comp.mount(container);

    const label = container.querySelector(".vw-share-label") as HTMLElement;
    expect(label).not.toBeNull();
    expect(label.textContent).toBe("Sharing");
    expect(label.style.display).toBe("inline");
  });

  it("share button hides 'Sharing' label when inactive", () => {
    setVoiceConnected(false);
    comp = createVoiceWidget(handlers);
    comp.mount(container);

    const label = container.querySelector(".vw-share-label") as HTMLElement;
    expect(label).not.toBeNull();
    expect(label.textContent).toBe("");
    expect(label.style.display).toBe("none");
  });
});
