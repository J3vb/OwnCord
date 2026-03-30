import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Must mock before imports
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
      rtt: 0, quality: "excellent", outRate: 0, inRate: 0,
      outPackets: 0, inPackets: 0, totalUp: 0, totalDown: 0,
    }),
    onUpdate: vi.fn().mockReturnValue(() => {}),
    onQualityChanged: vi.fn().mockReturnValue(() => {}),
  }),
  formatBytes: vi.fn((v: number) => `${v} B`),
  formatRate: vi.fn((v: number) => `${v} B/s`),
  formatBitrate: vi.fn((v: number) => `${v} bps`),
}));

import { createVoiceWidget } from "../../src/components/VoiceWidget";
import { voiceStore } from "../../src/stores/voice.store";
import { channelsStore } from "../../src/stores/channels.store";
import { membersStore } from "../../src/stores/members.store";
import type { VoiceUser } from "../../src/stores/voice.store";

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

function setVoiceChannel(channelId: number, users: VoiceUser[]): void {
  const userMap = new Map<number, VoiceUser>();
  for (const u of users) {
    userMap.set(u.userId, u);
  }
  const voiceUsers = new Map<number, ReadonlyMap<number, VoiceUser>>();
  voiceUsers.set(channelId, userMap);

  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: channelId,
    voiceUsers,
  }));
}

describe("VoiceWidget", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders hidden when not connected to a voice channel", () => {
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const root = container.querySelector('[data-testid="voice-widget"]');
    expect(root).not.toBeNull();
    expect(root!.classList.contains("visible")).toBe(false);

    widget.destroy?.();
  });

  it("shows visible when connected to a voice channel", () => {
    channelsStore.setState((prev) => {
      const channels = new Map(prev.channels);
      channels.set(1, {
        id: 1,
        name: "Voice Lobby",
        type: "voice",
        category: null,
        position: 0,
        unreadCount: 0,
        lastMessageId: null,
      });
      return { ...prev, channels };
    });

    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const root = container.querySelector('[data-testid="voice-widget"]');
    expect(root!.classList.contains("visible")).toBe(true);

    widget.destroy?.();
  });

  it("displays channel name", () => {
    channelsStore.setState((prev) => {
      const channels = new Map(prev.channels);
      channels.set(1, {
        id: 1,
        name: "Voice Lobby",
        type: "voice",
        category: null,
        position: 0,
        unreadCount: 0,
        lastMessageId: null,
      });
      return { ...prev, channels };
    });

    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const channelName = container.querySelector(".vw-channel");
    expect(channelName?.textContent).toBe("Voice Lobby");

    widget.destroy?.();
  });

  it("does not render voice users (users only shown in sidebar)", () => {
    channelsStore.setState((prev) => {
      const channels = new Map(prev.channels);
      channels.set(1, {
        id: 1,
        name: "Voice Lobby",
        type: "voice",
        category: null,
        position: 0,
        unreadCount: 0,
        lastMessageId: null,
      });
      return { ...prev, channels };
    });

    setVoiceChannel(1, [
      {
        userId: 10,
        username: "Alice",
        muted: false,
        deafened: false,
        speaking: false,
        camera: false,
        screenshare: false,
      },
    ]);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const userItems = container.querySelectorAll(".voice-user-item");
    expect(userItems.length).toBe(0);

    widget.destroy?.();
  });

  it("calls onMuteToggle when mute button is clicked", () => {
    const onMuteToggle = vi.fn();
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle,
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const muteBtn = container.querySelector('[aria-label="Mute"]') as HTMLButtonElement;
    expect(muteBtn).not.toBeNull();
    muteBtn.click();
    expect(onMuteToggle).toHaveBeenCalledOnce();

    widget.destroy?.();
  });

  it("calls onDisconnect when disconnect button is clicked", () => {
    const onDisconnect = vi.fn();
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect,
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const disconnectBtn = container.querySelector('[aria-label="Disconnect"]') as HTMLButtonElement;
    expect(disconnectBtn).not.toBeNull();
    disconnectBtn.click();
    expect(onDisconnect).toHaveBeenCalledOnce();

    widget.destroy?.();
  });

  it("toggles mute active state based on store", () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const muteBtn = container.querySelector('[aria-label="Mute"]') as HTMLButtonElement;
    expect(muteBtn.classList.contains("active-ctrl")).toBe(true);

    widget.destroy?.();
  });

  it("toggles screenshare active state based on store", () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, localScreenshare: true }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const screenshareBtn = container.querySelector('[aria-label="Screenshare"]') as HTMLButtonElement;
    expect(screenshareBtn).not.toBeNull();
    expect(screenshareBtn.classList.contains("active-ctrl")).toBe(true);
    expect(screenshareBtn.getAttribute("aria-pressed")).toBe("true");

    widget.destroy?.();
  });

  it("cleans up on destroy", () => {
    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const root = container.querySelector('[data-testid="voice-widget"]');
    expect(root).not.toBeNull();

    widget.destroy?.();
    expect(container.querySelector('[data-testid="voice-widget"]')).toBeNull();
  });

  it("calls onDeafenToggle when deafen button is clicked", () => {
    const onDeafenToggle = vi.fn();
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle,
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const deafenBtn = container.querySelector('[aria-label="Deafen"]') as HTMLButtonElement;
    expect(deafenBtn).not.toBeNull();
    deafenBtn.click();
    expect(onDeafenToggle).toHaveBeenCalledOnce();

    widget.destroy?.();
  });

  it("calls onCameraToggle when camera button is clicked", () => {
    const onCameraToggle = vi.fn();
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle,
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const cameraBtn = container.querySelector('[aria-label="Camera"]') as HTMLButtonElement;
    expect(cameraBtn).not.toBeNull();
    cameraBtn.click();
    expect(onCameraToggle).toHaveBeenCalledOnce();

    widget.destroy?.();
  });

  it("calls onScreenshareToggle when screenshare button is clicked", () => {
    const onScreenshareToggle = vi.fn();
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle,
    });
    widget.mount(container);

    const shareBtn = container.querySelector('[aria-label="Screenshare"]') as HTMLButtonElement;
    expect(shareBtn).not.toBeNull();
    shareBtn.click();
    expect(onScreenshareToggle).toHaveBeenCalledOnce();

    widget.destroy?.();
  });

  it("toggles deafen active state based on store", () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, localDeafened: true }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const deafenBtn = container.querySelector('[aria-label="Deafen"]') as HTMLButtonElement;
    expect(deafenBtn.classList.contains("active-ctrl")).toBe(true);
    expect(deafenBtn.getAttribute("aria-pressed")).toBe("true");

    widget.destroy?.();
  });

  it("toggles camera active state based on store", () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, localCamera: true }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const cameraBtn = container.querySelector('[aria-label="Camera"]') as HTMLButtonElement;
    expect(cameraBtn.classList.contains("active-ctrl")).toBe(true);
    expect(cameraBtn.getAttribute("aria-pressed")).toBe("true");

    widget.destroy?.();
  });

  it("falls back to 'Voice Channel' when channel is not in store", () => {
    // Don't add channel to channelsStore
    setVoiceChannel(999, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const channelName = container.querySelector(".vw-channel");
    expect(channelName?.textContent).toBe("Voice Channel");

    widget.destroy?.();
  });

  it("shows 'Grant Microphone' button when in listen-only mode", () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, listenOnly: true }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const grantBtn = container.querySelector(".vw-grant-mic") as HTMLButtonElement;
    expect(grantBtn).not.toBeNull();
    expect(grantBtn.style.display).toBe("block");
    expect(grantBtn.textContent).toBe("Grant Microphone");

    widget.destroy?.();
  });

  it("hides 'Grant Microphone' button when not in listen-only mode", () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, listenOnly: false }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const grantBtn = container.querySelector(".vw-grant-mic") as HTMLButtonElement;
    expect(grantBtn.style.display).toBe("none");

    widget.destroy?.();
  });

  it("clicking 'Grant Microphone' calls retryMicPermission", async () => {
    setVoiceChannel(1, []);
    voiceStore.setState((prev) => ({ ...prev, listenOnly: true }));

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const grantBtn = container.querySelector(".vw-grant-mic") as HTMLButtonElement;
    grantBtn.click();

    expect(mockRetryMicPermission).toHaveBeenCalledOnce();
    // Wait for the promise to resolve
    await vi.waitFor(() => {
      expect(grantBtn.textContent).toBe("Grant Microphone");
      expect(grantBtn.disabled).toBe(false);
    });

    widget.destroy?.();
  });

  it("displays stats pane toggle on signal icon click", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const statsPane = container.querySelector(".vw-stats") as HTMLDivElement;
    expect(statsPane).not.toBeNull();
    // Initially hidden
    expect(statsPane.classList.contains("visible")).toBe(false);

    // Click signal icon to toggle stats visibility
    const signalWrap = container.querySelector(".vw-signal") as HTMLDivElement;
    signalWrap.click();
    expect(statsPane.classList.contains("visible")).toBe(true);

    // Click again to hide
    signalWrap.click();
    expect(statsPane.classList.contains("visible")).toBe(false);

    widget.destroy?.();
  });

  it("displays elapsed timer element with initial 00:00", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const timerEl = container.querySelector(".vw-timer");
    expect(timerEl).not.toBeNull();
    // Timer starts and updates; with joinedAt=null the timer shows "00:00"
    // or if joinedAt is set, shows elapsed
    expect(timerEl?.textContent).toMatch(/^\d{2}:\d{2}/);

    widget.destroy?.();
  });

  it("hides widget and stops timer when voice channel is left", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const root = container.querySelector('[data-testid="voice-widget"]') as HTMLDivElement;
    expect(root.classList.contains("visible")).toBe(true);

    // Leave voice channel
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: null }));
    voiceStore.flush();

    expect(root.classList.contains("visible")).toBe(false);

    widget.destroy?.();
  });

  it("contains transport stats labels (Outgoing, Incoming, Session Totals)", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const statsPane = container.querySelector(".vw-stats") as HTMLDivElement;
    expect(statsPane.textContent).toContain("Transport Statistics");
    expect(statsPane.textContent).toContain("Outgoing");
    expect(statsPane.textContent).toContain("Incoming");
    expect(statsPane.textContent).toContain("Session Totals");

    widget.destroy?.();
  });

  it("reacts to voice store changes for mute toggle", () => {
    setVoiceChannel(1, []);

    const widget = createVoiceWidget({
      onDisconnect: vi.fn(),
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const muteBtn = container.querySelector('[aria-label="Mute"]') as HTMLButtonElement;
    expect(muteBtn.classList.contains("active-ctrl")).toBe(false);

    // Toggle mute in store
    voiceStore.setState((prev) => ({ ...prev, localMuted: true }));
    voiceStore.flush();

    expect(muteBtn.classList.contains("active-ctrl")).toBe(true);
    expect(muteBtn.getAttribute("aria-pressed")).toBe("true");

    widget.destroy?.();
  });
});
