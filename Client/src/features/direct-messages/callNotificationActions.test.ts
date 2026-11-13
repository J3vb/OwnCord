// The buttons of the Android app's call notifications, as the app acts on
// them. The host is a fake that hands over what was pressed; the voice
// controls, the ring and the stores are the real ones, wired the way the main
// page wires them, so a press is seen to go through the same doors as the
// app's own buttons.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggerMock } from "../../../tests/helpers/loggerMock";
import * as voiceSession from "../../../tests/helpers/voiceSessionMock";
import type { CallAction } from "../../platform/contracts/callService";

const host = vi.hoisted(() => ({
  /** What the app registered for the buttons, and the owner it gave. */
  heard: null as ((action: CallAction) => void) | null,
  owner: null as AbortSignal | null,
  showCall: vi.fn(),
  clearCall: vi.fn(),
  leaveVoice: vi.fn(),
  setMuted: vi.fn(),
}));

vi.mock("@lib/logger", () => loggerMock());
vi.mock("../../platform/desktop", () => ({
  desktop: {
    callService: {
      onAction: (signal: AbortSignal, handler: (action: CallAction) => void) => {
        host.owner = signal;
        host.heard = handler;
      },
    },
    notifier: {
      ringsCalls: true,
      showCall: host.showCall,
      clearCall: host.clearCall,
      requestAttention: () => Promise.resolve(),
    },
  },
}));
vi.mock("@lib/voice/livekitSession", () =>
  voiceSession.withOverrides({ leaveVoice: host.leaveVoice, setMuted: host.setMuted }),
);

import { followCallActions } from "./callNotificationActions";
import { alertIncomingCall, clearIncomingCall } from "./callAlerts";
import { setMessageJumpHandler } from "../../lib/nav/messageNavigation";
import { setChannelMutesHost } from "../../lib/prefs/channelMutes";
import { createRingController, type RingController } from "../../lib/voice/callRing";
import type { WsClient } from "../../lib/ws";
import { createVoiceWidgetCallbacks } from "../../pages/main-page/VoiceCallbacks";
import { setConnectionStatus } from "../../stores/ui.store";
import {
  resetVoiceStore,
  setLocalMuted,
  voiceStore,
  type VoiceStatus,
} from "../../stores/voice.store";

const RING = { channelId: 50, fromUserId: 10, fromUsername: "Otto" };

let send: ReturnType<typeof vi.fn>;
let opened: ReturnType<typeof vi.fn<(channelId: number, messageId?: number) => void>>;
let joined: number[];
let declined: number[];
let st: { ringCtrl: RingController | null; ws: WsClient };
let acceptRing: ReturnType<typeof vi.fn<(withVideo: boolean) => void>>;
let stop: () => void;
let forgetJump: () => void;

/** A button is pressed on one of the host's notifications. */
function press(action: CallAction): void {
  host.heard?.(action);
}

/** The frames of one type the app sent to the server. */
const sentFrames = (type: string): unknown[] =>
  send.mock.calls.map(([frame]) => frame).filter((frame) => frame.type === type);

function inCall(status: VoiceStatus, mic: { muted?: boolean; byModerator?: boolean } = {}): void {
  voiceStore.setState((s) => ({
    ...s,
    currentChannelId: 7,
    voiceStatus: status,
    localMuted: mic.muted ?? false,
    localServerMuted: mic.byModerator ?? false,
  }));
  voiceStore.flush();
}

/** A call rings while the app is out of sight, so the host shows it. */
function ringOnHost(ring = RING): void {
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  st.ringCtrl?.incoming(ring);
}

beforeEach(() => {
  localStorage.clear();
  resetVoiceStore();
  setConnectionStatus("connected");
  setChannelMutesHost("a.example");
  host.showCall.mockReset().mockResolvedValue(undefined);
  host.clearCall.mockReset().mockResolvedValue(undefined);
  host.leaveVoice.mockReset();
  // The session's mute lands in the store, as the real one's does.
  host.setMuted.mockReset().mockImplementation((muted: boolean) => setLocalMuted(muted));
  send = vi.fn();
  opened = vi.fn<(channelId: number, messageId?: number) => void>();
  forgetJump = setMessageJumpHandler(opened);
  joined = [];
  declined = [];
  st = { ringCtrl: null, ws: { send } as unknown as WsClient };
  st.ringCtrl = createRingController({
    onRingStateChange: () => undefined,
    onChime: () => undefined,
    onAccept: (channelId) => joined.push(channelId),
    onDecline: (channelId) => declined.push(channelId),
    onRingStart: alertIncomingCall,
    onRingEnd: clearIncomingCall,
  });
  // The page's accept, on its way through: it answers the ring on screen.
  acceptRing = vi.fn<(withVideo: boolean) => void>(() => st.ringCtrl?.accept());
  const controls = createVoiceWidgetCallbacks({ send } as unknown as WsClient, {
    voice: { tryConsume: () => true },
    voiceVideo: { tryConsume: () => true },
  });
  stop = followCallActions(st, { acceptRing, joinDmCall: vi.fn() }, controls);
});

afterEach(() => {
  stop();
  st.ringCtrl?.destroy();
  forgetJump();
  setChannelMutesHost(null);
  setConnectionStatus("disconnected");
  vi.restoreAllMocks();
});

describe("the in-call notification's buttons", () => {
  it("Mute mutes the microphone and tells the server, once however often it is pressed", () => {
    inCall("connected");
    press({ kind: "mute" });
    // The notification still shows Mute for a moment: a second press of it.
    press({ kind: "mute" });
    expect(host.setMuted.mock.calls).toEqual([[true]]);
    expect(sentFrames("voice_mute")).toEqual([{ type: "voice_mute", payload: { muted: true } }]);
    expect(voiceStore.getState().localMuted).toBe(true);
  });

  it("Unmute lifts the member's own mute, once", () => {
    inCall("connected", { muted: true });
    press({ kind: "unmute" });
    press({ kind: "unmute" });
    expect(host.setMuted.mock.calls).toEqual([[false]]);
    expect(sentFrames("voice_mute")).toEqual([{ type: "voice_mute", payload: { muted: false } }]);
  });

  it("a press that crosses a change made in the app does not flip it back", () => {
    // Muted in the app as Mute was pressed on the notification.
    inCall("connected", { muted: true });
    press({ kind: "mute" });
    // And the other way round.
    inCall("connected");
    press({ kind: "unmute" });
    expect(host.setMuted).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("Unmute does not lift a moderator's mute", () => {
    // The button went as the moderator muted; this press was on its way.
    inCall("connected", { muted: true, byModerator: true });
    press({ kind: "unmute" });
    expect(host.setMuted).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["mute", "unmute"] as const)(
    "%s pressed as the call ended changes nothing for the next call",
    (kind) => {
      // No call any more, and a microphone the press would have flipped.
      setLocalMuted(kind === "unmute");
      voiceStore.flush();
      press({ kind });
      expect(host.setMuted).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(voiceStore.getState().localMuted).toBe(kind === "unmute");
    },
  );

  it.each<VoiceStatus>(["joining", "securing", "connected", "reconnecting"])(
    "Leave ends a call that is %s with one teardown, and nothing is left half open",
    (status) => {
      inCall(status);
      press({ kind: "leave" });
      // The notification is still up for a moment: a second press of Leave.
      press({ kind: "leave" });
      expect(host.leaveVoice.mock.calls).toEqual([[false]]);
      expect(sentFrames("voice_leave")).toEqual([{ type: "voice_leave", payload: {} }]);
      expect(voiceStore.getState()).toMatchObject({ currentChannelId: null, voiceStatus: "idle" });
    },
  );

  it("Leave with no call left does nothing", () => {
    press({ kind: "leave" });
    expect(host.leaveVoice).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("the incoming call notification's buttons", () => {
  it("Accept answers the ring, without a camera", () => {
    ringOnHost();
    press({ kind: "accept", channelId: 50 });
    expect(acceptRing.mock.calls).toEqual([[false]]);
    expect(joined).toEqual([50]);
    expect(st.ringCtrl?.current()).toBeNull();
    expect(opened).not.toHaveBeenCalled();
  });

  it("Accept on a ring that ended before the tap landed opens its conversation and joins nothing", () => {
    ringOnHost();
    // The caller hung up as the button was pressed.
    st.ringCtrl?.cancel(50, "ringer-left");
    press({ kind: "accept", channelId: 50 });
    expect(acceptRing).not.toHaveBeenCalled();
    expect(joined).toEqual([]);
    expect(opened.mock.calls).toEqual([[50, undefined]]);
  });

  it.each(["accept", "decline"] as const)(
    "%s on a ring that ended leaves the one that rings now alone",
    (kind) => {
      ringOnHost();
      st.ringCtrl?.cancel(50, "ringer-left");
      // Another call rings in the app, which is in front by now.
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      st.ringCtrl?.incoming({ channelId: 51, fromUserId: 11, fromUsername: "Mira" });
      press({ kind, channelId: 50 });
      expect(joined).toEqual([]);
      expect(declined).toEqual([]);
      expect(st.ringCtrl?.current()?.channelId).toBe(51);
      expect(opened.mock.calls).toEqual(kind === "accept" ? [[50, undefined]] : []);
    },
  );

  it("Decline declines the ring, and does nothing for one that is over", () => {
    ringOnHost();
    press({ kind: "decline", channelId: 50 });
    press({ kind: "decline", channelId: 50 });
    expect(declined).toEqual([50]);
    expect(st.ringCtrl?.current()).toBeNull();
    expect(opened).not.toHaveBeenCalled();
  });

  it("a tap on the notification opens the conversation and leaves the ring to be answered there", () => {
    ringOnHost();
    press({ kind: "open", channelId: 50 });
    expect(opened.mock.calls).toEqual([[50, undefined]]);
    expect(st.ringCtrl?.current()).toEqual(RING);
    expect(acceptRing).not.toHaveBeenCalled();
  });

  it.each(["accept", "decline", "open"] as const)(
    "%s for a ring this page never put on the host does nothing",
    (kind) => {
      // It rings in the app, in front: the host shows nothing for it.
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      st.ringCtrl?.incoming({ ...RING, channelId: 99 });
      press({ kind, channelId: 99 });
      expect(st.ringCtrl?.current()?.channelId).toBe(99);
      expect(joined).toEqual([]);
      expect(declined).toEqual([]);
      expect(opened).not.toHaveBeenCalled();
    },
  );

  it.each(["accept", "open"] as const)(
    "%s for a ring of another server opens nothing on this one",
    (kind) => {
      ringOnHost();
      st.ringCtrl?.cancel(50, "ringer-left");
      setChannelMutesHost("b.example");
      press({ kind, channelId: 50 });
      expect(opened).not.toHaveBeenCalled();
      expect(joined).toEqual([]);
    },
  );
});

describe("following the buttons", () => {
  it("ends with the page: the host is told through the owner it was given", () => {
    expect(host.owner?.aborted).toBe(false);
    stop();
    expect(host.owner?.aborted).toBe(true);
  });
});
