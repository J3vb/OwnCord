import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  }));
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
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
});
