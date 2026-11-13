// A press on a ring the Android app showed from a push: the page never heard
// that ring, so Accept joins the call once the app is connected and the caller
// is still in it, a tap opens the conversation, and Decline tells the caller.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loggerMock } from "../../../tests/helpers/loggerMock";

const host = vi.hoisted(() => ({
  clearCall: vi.fn(),
  instance: "a.example#1" as string | null,
}));

vi.mock("@lib/logger", () => loggerMock());
vi.mock("../../platform/desktop", () => ({
  desktop: { notifier: { clearCall: host.clearCall } },
}));
vi.mock("../push/pushSubscription", () => ({ pushSessionInstance: () => host.instance }));

import { actOnPushRing, PUSH_ACCEPT_WAIT_MS, type PushRingAction } from "./pushRingActions";
import { Disposable } from "../../lib/disposable";
import { setMessageJumpHandler } from "../../lib/nav/messageNavigation";
import type { WsClient } from "../../lib/ws";
import { setConnectionStatus } from "../../stores/ui.store";
import { resetVoiceStore, voiceStore } from "../../stores/voice.store";
import type { VoiceUser } from "../../stores/voiceModel";

const CHANNEL = 50;

let send: ReturnType<typeof vi.fn>;
let joinDmCall: ReturnType<typeof vi.fn<(channelId: number) => void>>;
let opened: ReturnType<typeof vi.fn<(channelId: number, messageId?: number) => void>>;
let forgetJump: () => void;
let page: Disposable;

function press(kind: PushRingAction["kind"], instance = "a.example#1"): void {
  actOnPushRing(
    { kind, channelId: CHANNEL, instance },
    { ws: { send } as unknown as WsClient },
    { joinDmCall },
    page.signal,
  );
}

function callerInCall(): void {
  voiceStore.setState((s) => ({
    ...s,
    voiceUsers: new Map([[CHANNEL, new Map([[10, { userId: 10 } as unknown as VoiceUser]])]]),
  }));
  voiceStore.flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  resetVoiceStore();
  setConnectionStatus("connected");
  host.instance = "a.example#1";
  host.clearCall.mockReset().mockResolvedValue(undefined);
  send = vi.fn();
  joinDmCall = vi.fn();
  opened = vi.fn();
  forgetJump = setMessageJumpHandler(opened);
  page = new Disposable();
});

afterEach(() => {
  page.destroy();
  forgetJump();
  setConnectionStatus("disconnected");
  vi.useRealTimers();
});

describe("a press on a ring from push", () => {
  it("Accept opens the conversation and joins the call the caller is in", () => {
    callerInCall();
    press("accept");
    expect(opened).toHaveBeenCalledWith(CHANNEL, undefined);
    expect(joinDmCall).toHaveBeenCalledWith(CHANNEL);
    expect(host.clearCall).toHaveBeenCalledWith(CHANNEL);
  });

  it("Accept before the app connected joins once it has and sees the caller", () => {
    setConnectionStatus("reconnecting");
    press("accept");
    expect(joinDmCall).not.toHaveBeenCalled();
    setConnectionStatus("connected");
    expect(joinDmCall).not.toHaveBeenCalled();
    callerInCall();
    expect(joinDmCall).toHaveBeenCalledTimes(1);
    callerInCall();
    expect(joinDmCall).toHaveBeenCalledTimes(1);
  });

  it("Accept gives up when the caller never shows, and takes the ring down", () => {
    press("accept");
    vi.advanceTimersByTime(PUSH_ACCEPT_WAIT_MS);
    expect(host.clearCall).toHaveBeenCalledWith(CHANNEL);
    callerInCall();
    expect(joinDmCall).not.toHaveBeenCalled();
  });

  it("an Accept still waiting ends with the page", () => {
    press("accept");
    page.destroy();
    callerInCall();
    expect(joinDmCall).not.toHaveBeenCalled();
  });

  it("a tap opens the conversation and takes the ring down, joining nothing", () => {
    callerInCall();
    press("open");
    expect(opened).toHaveBeenCalledWith(CHANNEL, undefined);
    expect(host.clearCall).toHaveBeenCalledWith(CHANNEL);
    expect(joinDmCall).not.toHaveBeenCalled();
  });

  it("Decline tells the caller", () => {
    press("decline");
    expect(send).toHaveBeenCalledWith({ type: "call_decline", payload: { channel_id: CHANNEL } });
    expect(opened).not.toHaveBeenCalled();
  });

  it("a ring for another server or account is not this page's", () => {
    callerInCall();
    press("accept", "b.example#1");
    press("decline", "b.example#1");
    host.instance = null;
    press("open");
    expect(opened).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(joinDmCall).not.toHaveBeenCalled();
  });
});
