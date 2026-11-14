// MusicShare: the races a start can lose, on the native path (the host
// publishes) and on the page path (a loopback socket the page publishes).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../tests/helpers/deferred";

const mocks = vi.hoisted(() => ({
  setLocalMusic: vi.fn(),
  showToast: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  openAppAudio: vi.fn(),
}));

vi.mock("@stores/voice.store", () => ({ setLocalMusic: mocks.setLocalMusic }));
vi.mock("@lib/ui/toast", () => ({ showToast: mocks.showToast }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock("@lib/voice/appAudioTrack", () => ({ openAppAudio: mocks.openAppAudio }));
vi.mock("livekit-client", () => ({ LocalAudioTrack: vi.fn() }));
vi.mock("@lib/voice/musicPublish", () => ({ MUSIC_PUBLISH: { name: "music" } }));
vi.mock("../../platform/desktop", () => ({
  desktop: { musicAudio: { start: mocks.start, stop: mocks.stop } },
}));

import { MusicShare, musicErrorCode } from "./musicShare";
import type { VoiceRoom } from "@lib/voice/voiceRoom";

function nativeRoom() {
  const ended: Array<() => void> = [];
  const room = {
    startMusic: vi.fn(() => Promise.resolve("sid")),
    stopMusic: vi.fn(() => Promise.resolve()),
    onMusicEnded: vi.fn((cb: () => void) => {
      ended.push(cb);
      return () => ended.splice(ended.indexOf(cb), 1);
    }),
  };
  return { room, ended };
}

function pageRoom() {
  return {
    localParticipant: {
      publishTrack: vi.fn(() => Promise.resolve()),
      unpublishTrack: vi.fn(() => Promise.resolve()),
    },
  };
}

const handle = () => ({ track: {}, close: vi.fn() });

function shareIn(room: unknown): MusicShare {
  return new MusicShare({ getRoom: () => room as VoiceRoom });
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.stop.mockResolvedValue(undefined);
});

describe("musicErrorCode", () => {
  it("reads a code from a string or a rejection carrying a reason", () => {
    expect(musicErrorCode("not_found")).toBe("not_found");
    expect(musicErrorCode({ reason: "superseded" })).toBe("superseded");
    expect(musicErrorCode(new Error("x"))).toBe("internal");
  });
});

describe("MusicShare on a native room", () => {
  it("starts, records the share and stops the host capture on stop", async () => {
    const { room } = nativeRoom();
    const share = shareIn(room);
    expect(await share.start("app-1")).toBe("started");
    expect(share.appId).toBe("app-1");
    expect(mocks.setLocalMusic).toHaveBeenLastCalledWith(true);
    share.stop();
    expect(room.stopMusic).toHaveBeenCalledTimes(1);
    expect(mocks.setLocalMusic).toHaveBeenLastCalledWith(false);
    expect(share.appId).toBeNull();
  });

  it("tells the user when the host refuses, and stays quiet for a restore", async () => {
    const { room } = nativeRoom();
    room.startMusic.mockRejectedValue({ reason: "not_found" });
    const share = shareIn(room);
    expect(await share.start("gone")).toBe("failed");
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(await share.start("gone", { quiet: true })).toBe("failed");
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
    expect(mocks.setLocalMusic).not.toHaveBeenCalled();
  });

  it("a stop before the host answers leaves nothing running", async () => {
    const { room } = nativeRoom();
    const answer = createDeferred<string>();
    room.startMusic.mockReturnValue(answer.promise);
    const share = shareIn(room);
    const pending = share.start("app-1");
    share.stop();
    answer.resolve("sid");
    expect(await pending).toBe("stale");
    expect(share.appId).toBeNull();
    expect(mocks.setLocalMusic).not.toHaveBeenCalled();
    expect(room.stopMusic).toHaveBeenCalled();
  });

  it("a newer start wins over one still waiting on the host", async () => {
    const { room } = nativeRoom();
    const first = createDeferred<string>();
    room.startMusic.mockReturnValueOnce(first.promise);
    const share = shareIn(room);
    const older = share.start("old");
    expect(await share.start("new")).toBe("started");
    first.resolve("sid");
    expect(await older).toBe("stale");
    expect(share.appId).toBe("new");
    // The older start must not stop the capture the newer one owns.
    expect(room.stopMusic).not.toHaveBeenCalled();
  });

  it("a room replaced during the start makes the start stale", async () => {
    const { room } = nativeRoom();
    const answer = createDeferred<string>();
    room.startMusic.mockReturnValue(answer.promise);
    let current: unknown = room;
    const share = new MusicShare({ getRoom: () => current as VoiceRoom });
    const pending = share.start("app-1");
    current = nativeRoom().room;
    answer.resolve("sid");
    expect(await pending).toBe("stale");
    expect(share.appId).toBeNull();
  });

  it("stops with a notice when the host ends the share itself", async () => {
    const { room, ended } = nativeRoom();
    const share = shareIn(room);
    await share.start("app-1");
    ended[0]!();
    expect(share.appId).toBeNull();
    expect(mocks.setLocalMusic).toHaveBeenLastCalledWith(false);
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a stop with no share, and fails with no room", async () => {
    const { room } = nativeRoom();
    shareIn(room).stop();
    expect(room.stopMusic).not.toHaveBeenCalled();
    expect(await new MusicShare({ getRoom: () => null }).start("x")).toBe("failed");
  });
});

describe("MusicShare on the page path", () => {
  it("opens the host socket, publishes and releases everything on stop", async () => {
    const room = pageRoom();
    const h = handle();
    mocks.start.mockResolvedValue({ ok: true, url: "ws://x" });
    mocks.openAppAudio.mockResolvedValue(h);
    const share = shareIn(room);
    expect(await share.start("app-1")).toBe("started");
    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    share.stop();
    expect(h.close).toHaveBeenCalled();
    expect(room.localParticipant.unpublishTrack).toHaveBeenCalledTimes(1);
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it("stops the capture when the socket cannot be opened", async () => {
    mocks.start.mockResolvedValue({ ok: true, url: "ws://x" });
    mocks.openAppAudio.mockRejectedValue(new Error("refused"));
    const share = shareIn(pageRoom());
    expect(await share.start("app-1")).toBe("failed");
    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
  });

  it("stops with a notice when the socket closes", async () => {
    mocks.start.mockResolvedValue({ ok: true, url: "ws://x" });
    mocks.openAppAudio.mockImplementation(async (_url: string, onClosed: () => void) => ({
      ...handle(),
      onClosed,
    }));
    const share = shareIn(pageRoom());
    await share.start("app-1");
    const onClosed = mocks.openAppAudio.mock.calls[0]![1] as () => void;
    onClosed();
    expect(share.appId).toBeNull();
    expect(mocks.showToast).toHaveBeenCalledTimes(1);
  });

  it("a stop while the socket opens closes it and ends stale", async () => {
    const opened = createDeferred<ReturnType<typeof handle>>();
    mocks.start.mockResolvedValue({ ok: true, url: "ws://x" });
    mocks.openAppAudio.mockReturnValue(opened.promise);
    const room = pageRoom();
    const share = shareIn(room);
    const pending = share.start("app-1");
    await vi.waitFor(() => expect(mocks.openAppAudio).toHaveBeenCalled());
    share.stop();
    const h = handle();
    opened.resolve(h);
    expect(await pending).toBe("stale");
    expect(h.close).toHaveBeenCalled();
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
  });
});
