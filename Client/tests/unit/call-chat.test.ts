import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePhone } from "../helpers/phoneMedia";
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
import { savePref } from "@lib/prefs/preferences";
import {
  createCallChat,
  type CallChat,
  type CallChatState,
} from "../../src/pages/main-page/callChat";

const TEXT = 1;
const VOICE_A = 10;
const VOICE_B = 11;
const DM = 20;

function channel(id: number, type: "text" | "voice" | "dm") {
  return { id, name: `c${id}`, type, category: null, position: id };
}

function fakeCtrl() {
  let videoMode = false;
  let poppedOut = false;
  return {
    openCall: vi.fn(() => {
      videoMode = true;
    }),
    setChatBeside: vi.fn<(on: boolean) => void>(),
    isVideoMode: () => videoMode,
    isGridInWindow: () => videoMode && !poppedOut,
    close: () => {
      videoMode = false;
    },
    popOut: (out: boolean) => {
      poppedOut = out;
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

describe("callChat", () => {
  let chat: CallChat | null = null;

  beforeEach(() => {
    localStorage.clear();
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

  describe("Hide chat / Show chat", () => {
    function inCall(ctrl: ReturnType<typeof fakeCtrl>, onStateChange?: (s: CallChatState) => void) {
      chat = createCallChat({ videoModeCtrl: ctrl, onStateChange });
      joinVoiceChannel(VOICE_A);
      flush();
      chat.openVoiceCall();
    }

    it("is split-capable only with the grid open on the joined voice channel", () => {
      const ctrl = fakeCtrl();
      const states: CallChatState[] = [];
      chat = createCallChat({ videoModeCtrl: ctrl, onStateChange: (s) => states.push(s) });
      joinVoiceChannel(VOICE_A);
      setActiveChannel(VOICE_A);
      flush();
      // Grid closed: not capable.
      expect(states.at(-1)).toEqual({ capable: false, open: true });

      ctrl.openCall();
      chat.refresh();
      expect(states.at(-1)).toEqual({ capable: true, open: true });

      ctrl.close();
      chat.refresh();
      expect(states.at(-1)).toEqual({ capable: false, open: true });
    });

    it("a popped-out call is not split-capable, so the toggle hides", () => {
      const ctrl = fakeCtrl();
      const states: CallChatState[] = [];
      chat = createCallChat({ videoModeCtrl: ctrl, onStateChange: (s) => states.push(s) });
      joinVoiceChannel(VOICE_A);
      setActiveChannel(VOICE_A);
      flush();
      ctrl.openCall();
      chat.refresh();
      expect(states.at(-1)?.capable).toBe(true);

      ctrl.popOut(true);
      chat.refresh();
      expect(states.at(-1)?.capable).toBe(false);

      ctrl.popOut(false);
      chat.refresh();
      expect(states.at(-1)?.capable).toBe(true);
    });

    it("a DM call or an unjoined voice chat is never capable", () => {
      const ctrl = fakeCtrl();
      const states: CallChatState[] = [];
      chat = createCallChat({ videoModeCtrl: ctrl, onStateChange: (s) => states.push(s) });
      joinVoiceChannel(DM);
      flush();
      chat.openVoiceCall();
      expect(states.at(-1)?.capable).toBe(false);

      leaveVoiceChannel();
      setActiveChannel(VOICE_B);
      flush();
      expect(states.at(-1)?.capable).toBe(false);
    });

    it("pref off keeps the chat hidden", () => {
      const ctrl = fakeCtrl();
      inCall(ctrl);
      expect(lastBeside(ctrl)).toBe(true);

      chat?.toggleChat();
      expect(lastBeside(ctrl)).toBe(false);

      // Moving around the call keeps the grid over the chat while it is off.
      setVoiceStatus("reconnecting");
      flush();
      expect(lastBeside(ctrl)).toBe(false);

      chat?.toggleChat();
      expect(lastBeside(ctrl)).toBe(true);
    });

    it("pref survives a reload", () => {
      const first = fakeCtrl();
      inCall(first);
      chat?.toggleChat();
      chat?.destroy();
      chat = null;

      const second = fakeCtrl();
      const states: CallChatState[] = [];
      chat = createCallChat({ videoModeCtrl: second, onStateChange: (s) => states.push(s) });
      chat.openVoiceCall();
      chat.refresh();
      expect(states.at(-1)).toEqual({ capable: true, open: false });
      expect(lastBeside(second)).toBe(false);
    });

    describe("on a phone", () => {
      beforeEach(() => {
        usePhone();
      });
      afterEach(() => {
        vi.unstubAllGlobals();
      });

      it("starts closed when the user never chose, so the call view has the screen", () => {
        const ctrl = fakeCtrl();
        inCall(ctrl);
        expect(lastBeside(ctrl)).toBe(false);
      });

      it("keeps a saved choice of open", () => {
        savePref("callChatOpen", true);
        const ctrl = fakeCtrl();
        inCall(ctrl);
        expect(lastBeside(ctrl)).toBe(true);
      });

      it("keeps a saved choice of closed", () => {
        savePref("callChatOpen", false);
        const ctrl = fakeCtrl();
        inCall(ctrl);
        expect(lastBeside(ctrl)).toBe(false);
      });

      it("opens from the header's toggle", () => {
        const ctrl = fakeCtrl();
        inCall(ctrl);
        chat?.toggleChat();
        expect(lastBeside(ctrl)).toBe(true);
      });
    });

    it("an unreadable pref falls back to the chat open", () => {
      localStorage.setItem("owncord:callChatOpen", JSON.stringify("nope"));
      const ctrl = fakeCtrl();
      inCall(ctrl);
      expect(lastBeside(ctrl)).toBe(true);
    });
  });
});
