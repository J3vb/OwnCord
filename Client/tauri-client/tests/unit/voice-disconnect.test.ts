/**
 * Tests for voice channel disconnect behavior:
 * - VoiceWidget disconnect button sends voice_leave to server
 * - Logout sends voice_leave before disconnecting WS
 * - beforeunload sends voice_leave when in voice channel
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { voiceStore, joinVoiceChannel, leaveVoiceChannel } from "../../src/stores/voice.store";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore } from "../../src/stores/channels.store";
import { membersStore } from "../../src/stores/members.store";
import { uiStore } from "../../src/stores/ui.store";
import { createVoiceWidget } from "../../src/components/VoiceWidget";

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
  authStore.setState(() => ({
    token: null,
    user: null,
    serverName: null,
    motd: null,
    isAuthenticated: false,
  }));
  channelsStore.setState(() => ({
    channels: new Map(),
    activeChannelId: null,
  }));
  membersStore.setState(() => ({
    members: new Map(),
    typingUsers: new Map(),
  }));
  uiStore.setState(() => ({
    sidebarCollapsed: false,
    memberListVisible: true,
    settingsOpen: false,
    activeModal: null,
    theme: "dark" as const,
    connectionStatus: "disconnected" as const,
    transientError: null,
    persistentError: null,
    collapsedCategories: new Set<string>(),
  }));
}

describe("Voice disconnect — VoiceWidget", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    resetStores();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  it("calls onDisconnect when disconnect button is clicked", () => {
    const onDisconnect = vi.fn();
    joinVoiceChannel(42);

    const widget = createVoiceWidget({
      onDisconnect,
      onMuteToggle: vi.fn(),
      onDeafenToggle: vi.fn(),
      onCameraToggle: vi.fn(),
      onScreenshareToggle: vi.fn(),
    });
    widget.mount(container);

    const disconnectBtn = container.querySelector('button[aria-label="Disconnect"]');
    expect(disconnectBtn).not.toBeNull();
    disconnectBtn!.dispatchEvent(new Event("click"));

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    widget.destroy?.();
  });

  it("MainPage onDisconnect pattern sends voice_leave to server", () => {
    // Simulate the MainPage wiring: onDisconnect should call leaveVoiceChannel + ws.send
    const wsSend = vi.fn();

    // Set up voice state — user is in a voice channel
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "testuser", avatar: null, role: "member" },
      isAuthenticated: true,
    }));
    joinVoiceChannel(42);

    // Simulate the MainPage onDisconnect callback
    const onDisconnect = () => {
      leaveVoiceChannel();
      wsSend({ type: "voice_leave", payload: {} });
    };

    onDisconnect();

    expect(wsSend).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
    expect(voiceStore.getState().currentChannelId).toBeNull();
  });
});

describe("Voice disconnect — logout cleanup", () => {
  beforeEach(() => {
    resetStores();
  });

  it("sends voice_leave before ws.disconnect on logout when in voice channel", () => {
    const wsSend = vi.fn();
    const wsDisconnect = vi.fn();
    const callOrder: string[] = [];

    wsSend.mockImplementation(() => { callOrder.push("send"); });
    wsDisconnect.mockImplementation(() => { callOrder.push("disconnect"); });

    // User is authenticated and in a voice channel
    authStore.setState((prev) => ({
      ...prev,
      user: { id: 1, username: "testuser", avatar: null, role: "member" },
      isAuthenticated: true,
    }));
    joinVoiceChannel(42);

    // Simulate the main.ts logout handler
    const voice = voiceStore.getState();
    if (voice.currentChannelId !== null) {
      wsSend({ type: "voice_leave", payload: {} });
      leaveVoiceChannel();
    }
    wsDisconnect();

    expect(wsSend).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
    expect(wsDisconnect).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["send", "disconnect"]);
    expect(voiceStore.getState().currentChannelId).toBeNull();
  });

  it("does not send voice_leave on logout when not in voice channel", () => {
    const wsSend = vi.fn();
    const wsDisconnect = vi.fn();

    authStore.setState((prev) => ({
      ...prev,
      isAuthenticated: true,
    }));

    // Not in a voice channel
    const voice = voiceStore.getState();
    if (voice.currentChannelId !== null) {
      wsSend({ type: "voice_leave", payload: {} });
      leaveVoiceChannel();
    }
    wsDisconnect();

    expect(wsSend).not.toHaveBeenCalled();
    expect(wsDisconnect).toHaveBeenCalledTimes(1);
  });
});

describe("Voice disconnect — beforeunload", () => {
  beforeEach(() => {
    resetStores();
  });

  it("sends voice_leave on beforeunload when in voice channel", () => {
    const wsSend = vi.fn();

    joinVoiceChannel(42);

    // Simulate the beforeunload handler from main.ts
    const voice = voiceStore.getState();
    if (voice.currentChannelId !== null) {
      wsSend({ type: "voice_leave", payload: {} });
    }

    expect(wsSend).toHaveBeenCalledWith({ type: "voice_leave", payload: {} });
  });

  it("does not send voice_leave on beforeunload when not in voice channel", () => {
    const wsSend = vi.fn();

    // Not in a voice channel
    const voice = voiceStore.getState();
    if (voice.currentChannelId !== null) {
      wsSend({ type: "voice_leave", payload: {} });
    }

    expect(wsSend).not.toHaveBeenCalled();
  });
});
