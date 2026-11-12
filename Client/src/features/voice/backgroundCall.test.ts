import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../../platform/desktop", () => ({ desktop: { callService: { update: host.update } } }));

import { startBackgroundCall } from "./backgroundCall";
import { isVideoOnScreen, reportVideoOnScreen } from "./videoOnScreen";
import { resetVoiceStore, voiceStore, type VoiceStatus } from "../../stores/voice.store";
import type { CallMic } from "../../platform/contracts/callService";

function setCall(channel: number | null, status: VoiceStatus, camera = false): void {
  voiceStore.setState((s) => ({
    ...s,
    currentChannelId: channel,
    voiceStatus: status,
    localCamera: camera,
  }));
  voiceStore.flush();
}

/** A video grid starts drawing a picture, or stops; the report lands in a microtask. */
async function setVideo(on: boolean): Promise<void> {
  if (on !== isVideoOnScreen()) reportVideoOnScreen(on);
  await Promise.resolve();
}

const call = (camera: boolean, videoOnScreen = false, mic: CallMic = "live") => [
  { active: true, camera, videoOnScreen, mic },
];
const NO_CALL = [{ active: false, camera: false, videoOnScreen: false, mic: "live" }];

/** The member mutes or unmutes, or a moderator does. */
function setMic(muted: boolean, byModerator = false): void {
  voiceStore.setState((s) => ({ ...s, localMuted: muted, localServerMuted: byModerator }));
  voiceStore.flush();
}

describe("background call service", () => {
  let owner: AbortController;

  beforeEach(() => {
    resetVoiceStore();
    host.update.mockReset();
    owner = new AbortController();
  });

  afterEach(async () => {
    owner.abort();
    await setVideo(false);
  });

  it("says where it stands as it starts: the host side outlives a reload of the page", () => {
    startBackgroundCall(owner.signal);
    expect(host.update.mock.calls).toEqual([NO_CALL]);
  });

  it("says nothing for an owner that is already gone", () => {
    owner.abort();
    startBackgroundCall(owner.signal);
    setCall(7, "connected");
    expect(host.update).not.toHaveBeenCalled();
  });

  it("starts at joining, follows the camera, and stops on leave", () => {
    startBackgroundCall(owner.signal);
    setCall(7, "joining");
    setCall(7, "connected");
    setCall(7, "connected", true);
    setCall(7, "connected", false);
    setCall(null, "idle");
    expect(host.update.mock.calls).toEqual([
      NO_CALL,
      call(false),
      call(true),
      call(false),
      NO_CALL,
    ]);
  });

  it("keeps one running service through a reconnect and a quick rejoin", () => {
    startBackgroundCall(owner.signal);
    setCall(7, "connected", true);
    setCall(7, "reconnecting", true);
    setCall(7, "connected", true);
    // Leave and rejoin within one store batch: no stop is sent in between.
    voiceStore.setState((s) => ({ ...s, currentChannelId: null, voiceStatus: "idle" }));
    voiceStore.setState((s) => ({ ...s, currentChannelId: 9, voiceStatus: "joining" }));
    voiceStore.flush();
    expect(host.update.mock.calls).toEqual([NO_CALL, call(true)]);
  });

  it("never reports a camera outside a call", () => {
    startBackgroundCall(owner.signal);
    setCall(null, "idle", true);
    expect(host.update.mock.calls).toEqual([NO_CALL]);
  });

  it("stops a running service when its owner goes away", () => {
    setCall(7, "connected");
    startBackgroundCall(owner.signal);
    expect(host.update.mock.calls).toEqual([call(false)]);
    owner.abort();
    setCall(null, "idle");
    expect(host.update.mock.calls).toEqual([call(false), NO_CALL]);
  });

  describe("the notification's microphone", () => {
    it("follows a mute and its lift, wherever they were made", () => {
      startBackgroundCall(owner.signal);
      setCall(7, "connected");
      setMic(true);
      setMic(false);
      expect(host.update.mock.calls).toEqual([
        NO_CALL,
        call(false),
        call(false, false, "muted"),
        call(false),
      ]);
    });

    it("is locked under a moderator's mute, whatever the member's own was", () => {
      startBackgroundCall(owner.signal);
      setCall(7, "connected");
      setMic(false, true);
      // The member's own mute changes under it: still not theirs to lift.
      setMic(true, true);
      setMic(true);
      expect(host.update.mock.calls).toEqual([
        NO_CALL,
        call(false),
        call(false, false, "locked"),
        call(false, false, "muted"),
      ]);
    });

    it("is the state a call starts in, when the member joins muted", () => {
      setMic(true);
      startBackgroundCall(owner.signal);
      setCall(7, "joining");
      expect(host.update.mock.calls).toEqual([NO_CALL, call(false, false, "muted")]);
    });

    it("says nothing of a mute outside a call", () => {
      startBackgroundCall(owner.signal);
      setMic(true);
      setMic(false, true);
      expect(host.update.mock.calls).toEqual([NO_CALL]);
    });
  });

  describe("screen stays on while a picture shows", () => {
    it("says so while a camera or a stream is on screen, and takes it back when it goes", async () => {
      startBackgroundCall(owner.signal);
      setCall(7, "connected");
      await setVideo(true);
      await setVideo(false);
      expect(host.update.mock.calls).toEqual([
        NO_CALL,
        call(false),
        call(false, true),
        call(false),
      ]);
    });

    it("reports a picture that was already on screen when the call service starts", async () => {
      setCall(7, "connected", true);
      await setVideo(true);
      startBackgroundCall(owner.signal);
      expect(host.update.mock.calls).toEqual([call(true, true)]);
    });

    it("lets the screen sleep when the call ends with the picture still up", async () => {
      startBackgroundCall(owner.signal);
      setCall(7, "connected");
      await setVideo(true);
      // The leave reaches the store before the grid drops its tiles.
      setCall(null, "idle");
      await setVideo(false);
      expect(host.update.mock.calls).toEqual([NO_CALL, call(false), call(false, true), NO_CALL]);
    });

    it("never keeps the screen on outside a call", async () => {
      startBackgroundCall(owner.signal);
      await setVideo(true);
      expect(host.update.mock.calls).toEqual([NO_CALL]);
    });

    it("lets the screen sleep when its owner goes away", async () => {
      startBackgroundCall(owner.signal);
      setCall(7, "connected");
      await setVideo(true);
      owner.abort();
      await setVideo(false);
      expect(host.update.mock.calls).toEqual([NO_CALL, call(false), call(false, true), NO_CALL]);
    });
  });
});
