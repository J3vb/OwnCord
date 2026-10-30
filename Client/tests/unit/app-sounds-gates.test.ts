/**
 * WP M-8: each sound answers to its own switch *and* its group switch. A
 * sound plays only when both are on; a per-sound switch nobody set is on.
 * Uses the real preferences, with the player mocked so the question is only
 * "was this sound asked for".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const { playNotificationSound, playVoiceSound } = vi.hoisted(() => ({
  playNotificationSound: vi.fn(),
  playVoiceSound: vi.fn(),
}));

vi.mock("../../src/lib/media/notificationSound", () => ({ playNotificationSound, playVoiceSound }));
vi.mock("../../src/lib/voice/livekitSession", () => ({
  leaveVoice: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

import {
  voiceStore,
  setLocalMuted,
  setLocalDeafened,
  updateVoiceState,
  resetVoiceStore,
} from "@stores/voice.store";
import { authStore } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { startVoiceUiSounds } from "../../src/features/voice/uiSounds";
import {
  notifyChannelActivity,
  notifyIncomingMessage,
  notifyMention,
  resetNotificationCoalescing,
} from "../../src/lib/notifications";
import { setGlobalNotificationLevel } from "../../src/lib/prefs/notificationLevel";
import { savePref } from "../../src/lib/prefs/preferences";
import type {
  ChannelActivityEntry,
  ChatMessagePayload,
  VoiceStatePayload,
} from "../../src/lib/types";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
  requestPermission: vi.fn().mockResolvedValue("granted"),
  sendNotification: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn().mockReturnValue({
    requestUserAttention: vi.fn().mockResolvedValue(undefined),
  }),
}));

function payload(overrides: Partial<ChatMessagePayload> = {}): ChatMessagePayload {
  return {
    id: 1,
    channel_id: 1,
    user: { id: 2, username: "TestUser", avatar: null },
    content: "Hello world",
    reply_to: null,
    attachments: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  playNotificationSound.mockClear();
  playVoiceSound.mockClear();
  resetNotificationCoalescing();
  setGlobalNotificationLevel("all");
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  channelsStore.setState((prev) => ({ ...prev, activeChannelId: 99 }));
  savePref("desktopNotifications", false);
  savePref("flashTaskbar", false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("message and mention sounds", () => {
  it("plays a plain message with both switches on (the default)", () => {
    notifyIncomingMessage(payload());
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("is silent for a plain message when its own switch is off, group on", () => {
    savePref("soundMessage", false);
    notifyIncomingMessage(payload());
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("is silent for a plain message when the group switch is off, own switch on", () => {
    savePref("notificationSounds", false);
    notifyIncomingMessage(payload());
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("keeps a mention audible when only the message switch is off", () => {
    savePref("soundMessage", false);
    notifyIncomingMessage(payload({ content: "hi @everyone", mentions_everyone: true }));
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("silences a mention on the mention switch alone, and a message stays audible", () => {
    savePref("soundMention", false);
    notifyIncomingMessage(payload({ content: "hi @everyone", mentions_everyone: true }));
    expect(playNotificationSound).not.toHaveBeenCalled();

    resetNotificationCoalescing();
    notifyIncomingMessage(payload({ id: 2 }));
    expect(playNotificationSound).toHaveBeenCalledTimes(1);
  });

  it("gates the cross-channel mention alert on the mention switch and the group switch", () => {
    savePref("soundMessage", false);
    notifyMention(5);
    expect(playNotificationSound).toHaveBeenCalledTimes(1);

    playNotificationSound.mockClear();
    savePref("soundMention", false);
    notifyMention(5);
    expect(playNotificationSound).not.toHaveBeenCalled();

    savePref("soundMention", true);
    savePref("notificationSounds", false);
    notifyMention(5);
    expect(playNotificationSound).not.toHaveBeenCalled();
  });

  it("gates a channel_activity entry on the switch of the sound it would make", () => {
    const entry = (over: Partial<ChannelActivityEntry>): ChannelActivityEntry => ({
      channel_id: 5,
      message_id: 7,
      mentions_you: false,
      mentions_everyone: false,
      ...over,
    });

    savePref("soundMessage", false);
    notifyChannelActivity(entry({}));
    expect(playNotificationSound).not.toHaveBeenCalled();

    resetNotificationCoalescing();
    notifyChannelActivity(entry({ mentions_you: true }));
    expect(playNotificationSound).toHaveBeenCalledTimes(1);

    playNotificationSound.mockClear();
    resetNotificationCoalescing();
    savePref("soundMention", false);
    notifyChannelActivity(entry({ mentions_you: true }));
    expect(playNotificationSound).not.toHaveBeenCalled();
  });
});

describe("voice sounds", () => {
  let stop: () => void = () => {};

  function voiceState(channelId: number, userId: number, over: Partial<VoiceStatePayload> = {}) {
    return {
      channel_id: channelId,
      user_id: userId,
      username: `user-${userId}`,
      muted: false,
      deafened: false,
      speaking: false,
      camera: false,
      screenshare: false,
      ...over,
    };
  }

  beforeEach(() => {
    authStore.setState(() => ({
      token: "t",
      user: null,
      serverName: null,
      motd: null,
      isAuthenticated: true,
    }));
    resetVoiceStore();
    voiceStore.setState((prev) => ({ ...prev, currentChannelId: 10 }));
    voiceStore.flush();
    stop = startVoiceUiSounds();
    playVoiceSound.mockClear();
  });

  afterEach(() => {
    stop();
    resetVoiceStore();
  });

  it("mute plays by default and not with its own (mute/deafen) switch off", () => {
    setLocalMuted(true);
    voiceStore.flush();
    expect(playVoiceSound).toHaveBeenCalledWith("mute");

    playVoiceSound.mockClear();
    savePref("soundMuteDeafen", false);
    setLocalMuted(false);
    voiceStore.flush();
    expect(playVoiceSound).not.toHaveBeenCalled();
  });

  it("deafen shares the mute/deafen switch", () => {
    savePref("soundMuteDeafen", false);
    setLocalDeafened(true);
    voiceStore.flush();
    expect(playVoiceSound).not.toHaveBeenCalled();
  });

  it("a join is silenced by the join/leave switch but not by the others", () => {
    savePref("soundJoinLeave", false);
    updateVoiceState(voiceState(10, 2));
    voiceStore.flush();
    expect(playVoiceSound).not.toHaveBeenCalled();

    savePref("soundJoinLeave", true);
    savePref("soundMuteDeafen", false);
    savePref("soundStream", false);
    updateVoiceState(voiceState(10, 3));
    voiceStore.flush();
    expect(playVoiceSound).toHaveBeenCalledWith("join");
  });

  it("a stream edge answers to the stream switch alone", () => {
    updateVoiceState(voiceState(10, 2));
    voiceStore.flush();
    playVoiceSound.mockClear();

    savePref("soundStream", false);
    updateVoiceState(voiceState(10, 2, { screenshare: true }));
    voiceStore.flush();
    expect(playVoiceSound).not.toHaveBeenCalled();

    savePref("soundStream", true);
    updateVoiceState(voiceState(10, 2, { screenshare: false }));
    voiceStore.flush();
    expect(playVoiceSound).toHaveBeenCalledWith("streamEnd");
  });

  it("the group switch still wins over an own switch that is on", () => {
    savePref("voiceSounds", false);
    setLocalMuted(true);
    voiceStore.flush();
    expect(playVoiceSound).not.toHaveBeenCalled();
  });
});
