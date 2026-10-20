import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  channelsStore,
  resetChannelsStore,
  setActiveChannel,
  setChannels,
} from "@stores/channels.store";
import {
  joinVoiceChannel,
  leaveVoiceChannel,
  resetVoiceStore,
  voiceStore,
  setVoiceStatus,
} from "@stores/voice.store";
import { createCallChat, type CallChat } from "../../src/pages/main-page/callChat";

const TEXT = 1;
const VOICE_A = 10;
const VOICE_B = 11;
const DM = 20;

function channel(id: number, type: "text" | "voice" | "dm") {
  return { id, name: `c${id}`, type, category: null, position: id };
}

function fakeCtrl() {
  let videoMode = false;
  return {
    openCall: vi.fn(() => {
      videoMode = true;
    }),
    setChatBeside: vi.fn<(on: boolean) => void>(),
    isVideoMode: () => videoMode,
    close: () => {
      videoMode = false;
    },
  };
}

/** The stores tell subscribers a microtask later; deliver now. */
function flush(): void {
  channelsStore.flush();
  voiceStore.flush();
}

function lastBeside(ctrl: ReturnType<typeof fakeCtrl>): boolean | undefined {
  return ctrl.setChatBeside.mock.calls.at(-1)?.[0];
}

describe("callChat (WP 6.1b)", () => {
  let chat: CallChat | null = null;

  beforeEach(() => {
    resetChannelsStore();
    resetVoiceStore();
    setChannels([
      channel(TEXT, "text"),
      channel(VOICE_A, "voice"),
      channel(VOICE_B, "voice"),
      channel(DM, "dm"),
    ]);
    setActiveChannel(TEXT);
    flush();
  });

  afterEach(() => {
    chat?.destroy();
    chat = null;
  });

  it("opening a guild call selects its voice channel then opens the grid", () => {
    const ctrl = fakeCtrl();
    chat = createCallChat({ videoModeCtrl: ctrl });
    joinVoiceChannel(VOICE_A);
    flush();

    chat.openVoiceCall();

    expect(channelsStore.getState().activeChannelId).toBe(VOICE_A);
    expect(ctrl.openCall).toHaveBeenCalledTimes(1);
    // The channel was active before the grid opened.
    expect(ctrl.openCall.mock.invocationCallOrder[0]).toBeGreaterThan(
      ctrl.setChatBeside.mock.invocationCallOrder[0]!,
    );
    expect(lastBeside(ctrl)).toBe(true);
  });

  it("opening the call while its channel is already active does not navigate again", () => {
    const ctrl = fakeCtrl();
    chat = createCallChat({ videoModeCtrl: ctrl });
    joinVoiceChannel(VOICE_A);
    flush();
    setActiveChannel(VOICE_A);
    flush();

    chat.openVoiceCall();

    expect(channelsStore.getState().activeChannelId).toBe(VOICE_A);
    expect(ctrl.openCall).toHaveBeenCalledTimes(1);
  });

  it("a DM call does not navigate and never splits", () => {
    const ctrl = fakeCtrl();
    chat = createCallChat({ videoModeCtrl: ctrl });
    joinVoiceChannel(DM);
    flush();

    chat.openVoiceCall();

    expect(channelsStore.getState().activeChannelId).toBe(TEXT);
    expect(ctrl.openCall).toHaveBeenCalledTimes(1);
    expect(lastBeside(ctrl)).toBe(false);
  });

  it("splits only while the active channel is the joined voice channel", () => {
    const ctrl = fakeCtrl();
    chat = createCallChat({ videoModeCtrl: ctrl });
    joinVoiceChannel(VOICE_A);
    flush();
    expect(lastBeside(ctrl)).toBe(false);

    setActiveChannel(VOICE_A);
    flush();
    expect(lastBeside(ctrl)).toBe(true);

    // Looking at another channel (or an unjoined voice chat) drops the split.
    setActiveChannel(VOICE_B);
    flush();
    expect(lastBeside(ctrl)).toBe(false);
  });

  it("a move A to B follows to B while the call view is open", () => {
    const ctrl = fakeCtrl();
    chat = createCallChat({ videoModeCtrl: ctrl });
    joinVoiceChannel(VOICE_A);
    flush();
    chat.openVoiceCall();
    expect(channelsStore.getState().activeChannelId).toBe(VOICE_A);

    joinVoiceChannel(VOICE_B);
    flush();

    expect(channelsStore.getState().activeChannelId).toBe(VOICE_B);
    expect(lastBeside(ctrl)).toBe(true);
  });

  it("a move A to B does not follow when A was not the open chat", () => {
    const ctrl = fakeCtrl();
    chat = createCallChat({ videoModeCtrl: ctrl });
    joinVoiceChannel(VOICE_A);
    flush();
    chat.openVoiceCall();
    setActiveChannel(TEXT);
    flush();

    joinVoiceChannel(VOICE_B);
    flush();

    expect(channelsStore.getState().activeChannelId).toBe(TEXT);
  });

  it("a move does not follow when the call view is closed", () => {
    const ctrl = fakeCtrl();
    chat = createCallChat({ videoModeCtrl: ctrl });
    joinVoiceChannel(VOICE_A);
    flush();
    setActiveChannel(VOICE_A);
    flush();
    ctrl.close();

    joinVoiceChannel(VOICE_B);
    flush();

    expect(channelsStore.getState().activeChannelId).toBe(VOICE_A);
    expect(lastBeside(ctrl)).toBe(false);
  });

  it("leaving keeps the voice chat and drops the split", () => {
    const ctrl = fakeCtrl();
    chat = createCallChat({ videoModeCtrl: ctrl });
    joinVoiceChannel(VOICE_A);
    flush();
    chat.openVoiceCall();
    expect(lastBeside(ctrl)).toBe(true);

    leaveVoiceChannel();
    flush();

    expect(channelsStore.getState().activeChannelId).toBe(VOICE_A);
    expect(lastBeside(ctrl)).toBe(false);
  });

  it("a status change in the same call keeps the split", () => {
    const ctrl = fakeCtrl();
    chat = createCallChat({ videoModeCtrl: ctrl });
    joinVoiceChannel(VOICE_A);
    flush();
    chat.openVoiceCall();

    setVoiceStatus("connected");
    flush();
    setVoiceStatus("reconnecting");
    flush();

    expect(channelsStore.getState().activeChannelId).toBe(VOICE_A);
    expect(lastBeside(ctrl)).toBe(true);
  });

  it("destroy stops listening and clears the split", () => {
    const ctrl = fakeCtrl();
    chat = createCallChat({ videoModeCtrl: ctrl });
    joinVoiceChannel(VOICE_A);
    flush();
    setActiveChannel(VOICE_A);
    flush();
    chat.destroy();
    expect(lastBeside(ctrl)).toBe(false);

    ctrl.setChatBeside.mockClear();
    joinVoiceChannel(VOICE_B);
    flush();
    expect(ctrl.setChatBeside).not.toHaveBeenCalled();
  });
});
