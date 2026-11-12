import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioRouteKind, MobileAudioState } from "../../platform/contracts/mobileAudio";

const host = vi.hoisted(() => ({
  watch: vi.fn(),
  setSession: vi.fn(),
  setRoute: vi.fn(),
  refresh: vi.fn(),
  syncMicrophoneGate: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock("../../platform/desktop", () => ({
  desktop: {
    mobileAudio: {
      watch: host.watch,
      setSession: host.setSession,
      setRoute: host.setRoute,
      refresh: host.refresh,
    },
  },
}));
vi.mock("../../lib/voice/livekitSession", () => ({
  syncMicrophoneGate: host.syncMicrophoneGate,
}));
vi.mock("../../lib/voice/audioPipeline", () => ({
  micProcessingOptions: () => ({ noiseSuppression: true, echoCancellation: false }),
}));
vi.mock("../../lib/ui/toast", () => ({ showToast: host.showToast }));

import { mobileRouteStore, pickRoute, startMobileRoutes } from "./mobileRoutes";
import { resetVoiceStore, voiceStore } from "../../stores/voice.store";
import { voiceText } from "../../i18n/voice";
import { expectConsole } from "../../../tests/helpers/console";
import { createDeferred } from "../../../tests/helpers/deferred";

/** Lets store notifications, the lazy imports and a capture settle. */
async function settle(): Promise<void> {
  await vi.dynamicImportSettled();
  await new Promise((r) => setTimeout(r, 0));
}

const ROUTES = [
  { kind: "speaker", name: "" },
  { kind: "earpiece", name: "" },
] as const;

function audio(over: Partial<MobileAudioState> = {}): MobileAudioState {
  return {
    supported: true,
    routes: ROUTES,
    active: "speaker",
    manual: null,
    interrupted: false,
    ...over,
  };
}

/** What the host reports, through the watcher the module registered. */
function report(state: MobileAudioState): void {
  const onState = host.watch.mock.calls.at(-1)![1] as (state: MobileAudioState) => void;
  onState(state);
}

/** The host reports a route the user picked (or, with null, its own choice). */
async function pick(manual: AudioRouteKind | null = "earpiece"): Promise<void> {
  report(audio({ manual, active: manual ?? "speaker" }));
  await settle();
}

/** The page went to the background or came back. */
function show(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
  document.dispatchEvent(new Event("visibilitychange"));
}

function joinCall(): void {
  voiceStore.setState((s) => ({ ...s, currentChannelId: 7, voiceStatus: "connected" }));
}

function leaveCall(): void {
  voiceStore.setState((s) => ({ ...s, currentChannelId: null, voiceStatus: "idle" }));
}

interface FakeCapture {
  readonly stream: MediaStream;
  readonly track: EventTarget & { enabled: boolean; stop: ReturnType<typeof vi.fn> };
}

function capture(): FakeCapture {
  const track = Object.assign(new EventTarget(), { enabled: true, stop: vi.fn() });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  return { stream: stream as unknown as MediaStream, track };
}

const LOST = voiceText("route.lost");

describe("mobile call audio", () => {
  let owner: AbortController;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetVoiceStore();
    owner = new AbortController();
    getUserMedia = vi.fn(() => Promise.resolve(capture().stream));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
  });

  afterEach(async () => {
    owner.abort();
    await settle();
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  describe("the call's start and end", () => {
    it("watches the host, and says nothing while there is no call", () => {
      startMobileRoutes(owner.signal);
      expect(host.watch).toHaveBeenCalledWith(owner.signal, expect.any(Function));
      expect(host.setSession).not.toHaveBeenCalled();
    });

    it("tells the host when a call begins and when it ends", async () => {
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      expect(host.setSession.mock.calls).toEqual([[true]]);
      leaveCall();
      await settle();
      expect(host.setSession.mock.calls).toEqual([[true], [false]]);
    });

    it("counts a join that is still connecting, and a call already running at start", async () => {
      voiceStore.setState((s) => ({ ...s, voiceStatus: "joining" }));
      startMobileRoutes(owner.signal);
      expect(host.setSession.mock.calls).toEqual([[true]]);
      // The channel arriving is the same call, not a second one.
      joinCall();
      await settle();
      expect(host.setSession).toHaveBeenCalledTimes(1);
    });

    it("never starts for an owner that is already gone", () => {
      owner.abort();
      startMobileRoutes(owner.signal);
      expect(host.watch).not.toHaveBeenCalled();
    });

    it("keeps what the host reports where the route control reads it", () => {
      startMobileRoutes(owner.signal);
      expect(mobileRouteStore.getState().supported).toBe(false);
      const state = audio({ active: "earpiece" });
      report(state);
      expect(mobileRouteStore.getState()).toBe(state);
    });

    it("passes a pick on to the host", () => {
      pickRoute("earpiece");
      expect(host.setRoute.mock.calls).toEqual([["earpiece"]]);
    });
  });

  describe("a phone call's hold", () => {
    it("closes the mic once, and gives it back when the phone call ends", async () => {
      startMobileRoutes(owner.signal);
      joinCall();
      voiceStore.setState((s) => ({ ...s, localMuted: true, localDeafened: true }));
      await settle();

      report(audio({ interrupted: true }));
      expect(voiceStore.getState().phoneCallHold).toBe(true);
      await settle();
      expect(host.syncMicrophoneGate).toHaveBeenCalledTimes(1);

      // Another report during the phone call (a headset unplugged) is no second hold.
      report(audio({ interrupted: true, active: "earpiece" }));
      await settle();
      expect(host.syncMicrophoneGate).toHaveBeenCalledTimes(1);

      report(audio({ interrupted: false }));
      expect(voiceStore.getState().phoneCallHold).toBe(false);
      await settle();
      expect(host.syncMicrophoneGate).toHaveBeenCalledTimes(2);
      // The user's own mute and deafen were never touched.
      expect(voiceStore.getState()).toMatchObject({ localMuted: true, localDeafened: true });
    });

    it("holds nothing when there is no call", async () => {
      startMobileRoutes(owner.signal);
      report(audio({ interrupted: true }));
      await settle();
      expect(voiceStore.getState().phoneCallHold).not.toBe(true);
      expect(host.syncMicrophoneGate).not.toHaveBeenCalled();
    });

    it("ends with the call, and opens no microphone on a call that is over", async () => {
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      report(audio({ interrupted: true, manual: "earpiece", active: "earpiece" }));
      await settle();
      expect(host.syncMicrophoneGate).toHaveBeenCalledTimes(1);

      leaveCall();
      await settle();
      expect(voiceStore.getState().phoneCallHold).toBe(false);
      expect(host.syncMicrophoneGate).toHaveBeenCalledTimes(1);
      // The pick and the pause go with the call, ahead of the host's answer.
      expect(mobileRouteStore.getState()).toMatchObject({ manual: null, interrupted: false });
    });

    it("does not start the next call on what the last one left", async () => {
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      report(audio({ interrupted: true, manual: "earpiece", active: "earpiece" }));
      await settle();
      leaveCall();
      await settle();
      host.syncMicrophoneGate.mockClear();

      joinCall();
      await settle();
      expect(voiceStore.getState().phoneCallHold).toBe(false);
      expect(host.syncMicrophoneGate).not.toHaveBeenCalled();
      expect(getUserMedia).not.toHaveBeenCalled();
    });

    it("says so when the hold cannot reach the microphone", async () => {
      host.syncMicrophoneGate.mockImplementationOnce(() => {
        throw new Error("no session");
      });
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      report(audio({ interrupted: true }));
      await settle();
      expectConsole("warn", "The hold did not reach the microphone");
      expect(voiceStore.getState().phoneCallHold).toBe(true);
    });
  });

  describe("the capture that keeps a picked route", () => {
    it("opens one muted capture for a pick, as a call captures", async () => {
      const kept = capture();
      getUserMedia.mockResolvedValueOnce(kept.stream);
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      await pick();
      expect(getUserMedia.mock.calls).toEqual([
        [{ audio: { noiseSuppression: true, echoCancellation: true } }],
      ]);
      expect(kept.track.enabled).toBe(false);
      expect(kept.track.stop).not.toHaveBeenCalled();

      // A change of the pick keeps the same capture.
      await pick("bluetooth");
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    it("closes it when the choice goes back to the host", async () => {
      const kept = capture();
      getUserMedia.mockResolvedValueOnce(kept.stream);
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      await pick();
      await pick(null);
      expect(kept.track.stop).toHaveBeenCalledTimes(1);
      expect(host.showToast).not.toHaveBeenCalled();
    });

    it("opens nothing without a call, and starts a call on no pick", async () => {
      startMobileRoutes(owner.signal);
      await pick();
      expect(getUserMedia).not.toHaveBeenCalled();
      // What was reported before the call is not the call's: it starts on the
      // host's own choice until the host says otherwise.
      joinCall();
      await settle();
      expect(mobileRouteStore.getState().manual).toBeNull();
      expect(getUserMedia).not.toHaveBeenCalled();
    });

    it("opens nothing while the host chooses the route", async () => {
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      await pick(null);
      expect(getUserMedia).not.toHaveBeenCalled();
    });

    it("closes for a phone call and opens again after it", async () => {
      const first = capture();
      getUserMedia.mockResolvedValueOnce(first.stream);
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      await pick();

      report(audio({ manual: "earpiece", active: "earpiece", interrupted: true }));
      await settle();
      expect(first.track.stop).toHaveBeenCalledTimes(1);
      expect(getUserMedia).toHaveBeenCalledTimes(1);

      await pick();
      expect(getUserMedia).toHaveBeenCalledTimes(2);
    });

    it("closes with the call", async () => {
      const kept = capture();
      getUserMedia.mockResolvedValueOnce(kept.stream);
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      await pick();
      leaveCall();
      await settle();
      expect(kept.track.stop).toHaveBeenCalledTimes(1);
      expect(host.showToast).not.toHaveBeenCalled();
    });

    it("stops a capture that arrives after the pick was given up", async () => {
      const late = createDeferred<MediaStream>();
      const kept = capture();
      getUserMedia.mockReturnValueOnce(late.promise);
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      await pick();
      await pick(null);
      late.resolve(kept.stream);
      await settle();
      expect(kept.track.stop).toHaveBeenCalledTimes(1);
      expect(host.showToast).not.toHaveBeenCalled();
      expect(host.setRoute).not.toHaveBeenCalled();
    });

    it("gives the pick up, and says so, when the capture cannot open", async () => {
      getUserMedia.mockRejectedValueOnce(new Error("NotAllowedError"));
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      await pick();
      expectConsole("warn", "The picked route could not be kept; back to automatic");
      expect(host.setRoute.mock.calls).toEqual([[null]]);
      expect(mobileRouteStore.getState().manual).toBeNull();
      expect(host.showToast.mock.calls).toEqual([[LOST, "error"]]);
      // Nothing reopens the capture while the host's answer is on its way.
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });

    it("stays quiet when a capture fails after its pick was already given up", async () => {
      const late = createDeferred<MediaStream>();
      getUserMedia.mockReturnValueOnce(late.promise);
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      await pick();
      await pick(null);
      late.reject(new Error("AbortError"));
      await settle();
      expect(host.showToast).not.toHaveBeenCalled();
      expect(host.setRoute).not.toHaveBeenCalled();
    });

    it("gives the pick up when the capture ends by itself", async () => {
      const kept = capture();
      getUserMedia.mockResolvedValueOnce(kept.stream);
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      await pick();
      kept.track.dispatchEvent(new Event("ended"));
      expectConsole("warn", "The picked route could not be kept; back to automatic");
      expect(kept.track.stop).toHaveBeenCalledTimes(1);
      expect(host.setRoute.mock.calls).toEqual([[null]]);
      expect(host.showToast.mock.calls).toEqual([[LOST, "error"]]);
    });

    it("ignores the end of a capture it already closed", async () => {
      const kept = capture();
      getUserMedia.mockResolvedValueOnce(kept.stream);
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      await pick();
      await pick(null);
      kept.track.dispatchEvent(new Event("ended"));
      expect(host.setRoute).not.toHaveBeenCalled();
      expect(host.showToast).not.toHaveBeenCalled();
    });
  });

  describe("a page that comes back", () => {
    afterEach(() => Reflect.deleteProperty(document, "visibilityState"));

    it("asks for the state again during a call", async () => {
      startMobileRoutes(owner.signal);
      show("visible");
      expect(host.refresh).not.toHaveBeenCalled();
      joinCall();
      await settle();
      show("hidden");
      expect(host.refresh).not.toHaveBeenCalled();
      show("visible");
      expect(host.refresh).toHaveBeenCalledTimes(1);
    });
  });

  describe("its owner going", () => {
    it("ends the call's audio session, the hold and the capture, and stops following", async () => {
      const kept = capture();
      getUserMedia.mockResolvedValueOnce(kept.stream);
      startMobileRoutes(owner.signal);
      joinCall();
      await settle();
      report(audio({ manual: "earpiece", active: "earpiece" }));
      await settle();
      report(audio({ manual: "earpiece", active: "earpiece", interrupted: true }));
      await settle();
      expect(voiceStore.getState().phoneCallHold).toBe(true);
      host.setSession.mockClear();

      owner.abort();
      await settle();
      expect(host.setSession.mock.calls).toEqual([[false]]);
      expect(mobileRouteStore.getState()).toMatchObject({ supported: false, routes: [] });
      expect(voiceStore.getState().phoneCallHold).toBe(false);
      expect(kept.track.stop).toHaveBeenCalledTimes(1);

      leaveCall();
      await settle();
      document.dispatchEvent(new Event("visibilitychange"));
      expect(host.setSession).toHaveBeenCalledTimes(1);
      expect(host.refresh).not.toHaveBeenCalled();
    });

    it("ends no session when there was no call", async () => {
      startMobileRoutes(owner.signal);
      owner.abort();
      await settle();
      expect(host.setSession).not.toHaveBeenCalled();
    });
  });
});
