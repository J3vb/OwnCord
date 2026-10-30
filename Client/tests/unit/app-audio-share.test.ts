/**
 * The start step of Windows per-app share audio (src/lib/voice/appAudioShare.ts),
 * driven directly: which shares ask for the app's sound, what a refusal, a
 * stale start or a failed socket leave behind, and which of two overlapping
 * starts may stop the host's single capture.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalTrack, Room } from "livekit-client";
import type { AppAudioStart } from "../../src/platform/contracts/appAudio";

const host = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
}));
const openAppAudio = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());
const logCreate = vi.hoisted(() => vi.fn());

vi.mock("livekit-client", () => {
  class FakeLocalAudioTrack {
    constructor(
      readonly mediaStreamTrack: MediaStreamTrack,
      readonly constraints: unknown,
      readonly userProvidedTrack: boolean,
    ) {}
  }
  return { LocalAudioTrack: FakeLocalAudioTrack };
});
vi.mock("../../src/platform/desktop", () => ({ desktop: { appAudio: host } }));
vi.mock("../../src/lib/voice/appAudioTrack", () => ({
  openAppAudio: (...a: unknown[]) => openAppAudio(...a) as unknown,
}));
vi.mock("../../src/lib/toast", () => ({ showToast }));
vi.mock("../../src/lib/logger", () => ({
  createLogger: (name: string) => {
    logCreate(name);
    return { debug: vi.fn(), info: vi.fn(), warn: logWarn, error: vi.fn() };
  },
}));

// Loaded inside the first test that needs it, so what the module builds at load
// (its quiet-refusal list, its logger tag) is exercised by that test.
type Loaded = typeof import("../../src/lib/voice/appAudioShare");
const load = (): Promise<Loaded> => import("../../src/lib/voice/appAudioShare");
const startAppShareAudio: Loaded["startAppShareAudio"] = async (...args) =>
  (await load()).startAppShareAudio(...args);
const publishAppAudio: Loaded["publishAppAudio"] = async (...args) =>
  (await load()).publishAppAudio(...args);

const FAILED = "Couldn't share this app's sound. The picture is still shared.";

function mst(label = "win", surface?: string | null): MediaStreamTrack {
  return {
    label,
    getSettings: () => (surface === null ? undefined : { displaySurface: surface }),
  } as unknown as MediaStreamTrack;
}

function handle() {
  return { track: mst("app-sound"), close: vi.fn() };
}

function started(url = "ws://127.0.0.1:1/x"): AppAudioStart {
  return { ok: true, url };
}

const never = (): boolean => false;

function appOpens() {
  const h = handle();
  host.start.mockResolvedValue(started());
  openAppAudio.mockResolvedValue(h);
  return h;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(() => {
  host.start.mockReset();
  host.stop.mockReset().mockResolvedValue(undefined);
  openAppAudio.mockReset();
  showToast.mockReset();
  logWarn.mockReset();
});

describe("loading the module", () => {
  it("logs under its own tag and treats exactly the expected refusals as quiet", async () => {
    await load();
    expect(logCreate).toHaveBeenCalledWith("appAudioShare");
    const codes = ["not_window", "superseded", "own_window", "ancestor", "internal"] as const;
    for (const code of codes) host.start.mockResolvedValueOnce({ ok: false, code });
    const answers = await Promise.all(codes.map(() => startAppShareAudio(mst(), never)));
    expect(answers).toEqual([null, null, null, null, null]);
    // Only the last one is a fault worth a toast and a log line.
    expect(showToast).toHaveBeenCalledExactlyOnceWith(FAILED, "warning");
    expect(logWarn).toHaveBeenCalledExactlyOnceWith("App audio did not start", {
      code: "internal",
    });
  });
});

describe("wantsAppAudio", () => {
  it("wants the app's sound only for a window share with the switch on and no Chromium audio", async () => {
    const { wantsAppAudio } = await load();
    expect(wantsAppAudio(true, mst("w", "window"), false)).toBe(true);
  });

  it("does not want it when the switch is off or unset", async () => {
    const { wantsAppAudio } = await load();
    expect(wantsAppAudio(false, mst("w", "window"), false)).toBe(false);
    expect(wantsAppAudio(undefined, mst("w", "window"), false)).toBe(false);
  });

  it("does not want it when Chromium already gave audio", async () => {
    const { wantsAppAudio } = await load();
    expect(wantsAppAudio(true, mst("w", "window"), true)).toBe(false);
  });

  it("does not want it for a screen or an unknown surface", async () => {
    const { wantsAppAudio } = await load();
    expect(wantsAppAudio(true, mst("w", "monitor"), false)).toBe(false);
    expect(wantsAppAudio(true, mst("w", undefined), false)).toBe(false);
    expect(wantsAppAudio(true, mst("w", null), false)).toBe(false);
  });

  it("does not want it when the track cannot report its settings", async () => {
    const { wantsAppAudio } = await load();
    expect(wantsAppAudio(true, {} as unknown as MediaStreamTrack, false)).toBe(false);
  });
});

describe("startAppShareAudio", () => {
  it("does nothing for a share that is already stale", async () => {
    await expect(startAppShareAudio(mst(), () => true)).resolves.toBeNull();
    expect(host.start).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
  });

  it("asks the host to capture the window by its label", async () => {
    host.start.mockResolvedValue({ ok: false, code: "not_window" });
    await startAppShareAudio(mst("Notepad"), never);
    expect(host.start).toHaveBeenCalledExactlyOnceWith("Notepad", "window");
  });

  it("opens the host's socket and hands back a track made from it", async () => {
    const h = handle();
    host.start.mockResolvedValue(started("ws://host/audio"));
    openAppAudio.mockResolvedValue(h);
    const app = await startAppShareAudio(mst(), never);
    expect(openAppAudio).toHaveBeenCalledExactlyOnceWith("ws://host/audio");
    expect(app).not.toBeNull();
    const track = app?.track as unknown as {
      mediaStreamTrack: MediaStreamTrack;
      constraints: unknown;
      userProvidedTrack: boolean;
    };
    expect(track.mediaStreamTrack).toBe(h.track);
    expect(track.constraints).toBeUndefined();
    expect(track.userProvidedTrack).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
  });

  it.each(["not_window", "superseded", "own_window", "ancestor"] as const)(
    "refuses %s quietly: no toast, no log, nothing to stop",
    async (code) => {
      host.start.mockResolvedValue({ ok: false, code });
      await expect(startAppShareAudio(mst(), never)).resolves.toBeNull();
      expect(showToast).not.toHaveBeenCalled();
      expect(logWarn).not.toHaveBeenCalled();
      expect(host.stop).not.toHaveBeenCalled();
      expect(openAppAudio).not.toHaveBeenCalled();
    },
  );

  it.each(["unavailable", "not_found", "ambiguous", "activation_failed", "internal"] as const)(
    "toasts once and logs the code for a %s refusal",
    async (code) => {
      host.start.mockResolvedValue({ ok: false, code });
      await expect(startAppShareAudio(mst(), never)).resolves.toBeNull();
      expect(showToast).toHaveBeenCalledExactlyOnceWith(FAILED, "warning");
      expect(logWarn).toHaveBeenCalledExactlyOnceWith("App audio did not start", { code });
    },
  );

  it("stays silent about a refusal when the share went stale meanwhile", async () => {
    let stale = false;
    host.start.mockImplementation(() => {
      stale = true;
      return Promise.resolve({ ok: false, code: "internal" });
    });
    await expect(startAppShareAudio(mst(), () => stale)).resolves.toBeNull();
    expect(showToast).not.toHaveBeenCalled();
    expect(logWarn).not.toHaveBeenCalled();
  });

  it("stops the capture and opens nothing when the share went stale during the start", async () => {
    let stale = false;
    host.start.mockImplementation(() => {
      stale = true;
      return Promise.resolve(started());
    });
    await expect(startAppShareAudio(mst(), () => stale)).resolves.toBeNull();
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(openAppAudio).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("stops the capture, logs and toasts when the socket cannot open", async () => {
    const boom = new Error("socket");
    host.start.mockResolvedValue(started());
    openAppAudio.mockRejectedValue(boom);
    await expect(startAppShareAudio(mst(), never)).resolves.toBeNull();
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledExactlyOnceWith("App audio socket could not be opened", boom);
    expect(showToast).toHaveBeenCalledExactlyOnceWith(FAILED, "warning");
  });

  it("stops the capture without a toast when the socket fails after the share went stale", async () => {
    let stale = false;
    host.start.mockResolvedValue(started());
    openAppAudio.mockImplementation(() => {
      stale = true;
      return Promise.reject(new Error("socket"));
    });
    await expect(startAppShareAudio(mst(), () => stale)).resolves.toBeNull();
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("closes the socket and stops the capture when the share went stale while it opened", async () => {
    let stale = false;
    const h = handle();
    host.start.mockResolvedValue(started());
    openAppAudio.mockImplementation(() => {
      stale = true;
      return Promise.resolve(h);
    });
    await expect(startAppShareAudio(mst(), () => stale)).resolves.toBeNull();
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(host.stop).toHaveBeenCalledTimes(1);
  });

  it("close() releases the socket and the capture once, however often it is called", async () => {
    const h = handle();
    host.start.mockResolvedValue(started());
    openAppAudio.mockResolvedValue(h);
    const app = await startAppShareAudio(mst(), never);
    expect(host.stop).not.toHaveBeenCalled();
    app?.close();
    app?.close();
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(host.stop).toHaveBeenCalledTimes(1);
  });

  it("lets only the newest start stop the host: an older one closing later leaves the capture running", async () => {
    const a = handle();
    const b = handle();
    host.start.mockResolvedValue(started());
    openAppAudio.mockResolvedValueOnce(a).mockResolvedValueOnce(b);
    const first = await startAppShareAudio(mst("a"), never);
    const second = await startAppShareAudio(mst("b"), never);
    first?.close();
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(host.stop).not.toHaveBeenCalled();
    second?.close();
    expect(b.close).toHaveBeenCalledTimes(1);
    expect(host.stop).toHaveBeenCalledTimes(1);
  });

  it("does not stop a newer capture when an older start finds itself stale after the host answered", async () => {
    const firstAnswer = deferred<AppAudioStart>();
    host.start.mockImplementationOnce(() => firstAnswer.promise).mockResolvedValueOnce(started());
    const h = handle();
    openAppAudio.mockResolvedValue(h);
    let olderStale = false;
    const older = startAppShareAudio(mst("old"), () => olderStale);
    const newer = await startAppShareAudio(mst("new"), never);
    olderStale = true;
    firstAnswer.resolve(started());
    await expect(older).resolves.toBeNull();
    expect(host.stop).not.toHaveBeenCalled();
    expect(newer).not.toBeNull();
  });
});

describe("publishAppAudio", () => {
  const options = { name: "screen_share_audio" } as unknown as Parameters<
    typeof publishAppAudio
  >[5];

  function rig(generation = 3) {
    const publishTrack = vi.fn().mockResolvedValue(undefined);
    const unpublishTrack = vi.fn().mockResolvedValue(undefined);
    const room = { localParticipant: { publishTrack, unpublishTrack } } as unknown as Room;
    const screenTracks: LocalTrack[] = [];
    const state: Parameters<typeof publishAppAudio>[0] = {
      generation,
      manualScreenTracks: screenTracks,
    } as unknown as Parameters<typeof publishAppAudio>[0];
    const video = { mediaStreamTrack: mst("win", "window") } as unknown as LocalTrack;
    return { publishTrack, unpublishTrack, room, screenTracks, state, video };
  }

  it("does nothing for a share that is not of a window", async () => {
    const r = rig();
    const video = { mediaStreamTrack: mst("scr", "monitor") } as unknown as LocalTrack;
    await expect(publishAppAudio(r.state, r.room, r.screenTracks, video, 3, options)).resolves.toBe(
      "done",
    );
    expect(host.start).not.toHaveBeenCalled();
  });

  it("publishes the app's sound with the share-audio options and keeps it with the share", async () => {
    const r = rig();
    const h = appOpens();
    await expect(
      publishAppAudio(r.state, r.room, r.screenTracks, r.video, 3, options),
    ).resolves.toBe("done");
    expect(r.publishTrack).toHaveBeenCalledTimes(1);
    const published = r.publishTrack.mock.calls[0];
    expect(published?.[1]).toBe(options);
    expect(r.state.appAudio).toBeDefined();
    expect(r.screenTracks).toEqual([published?.[0]]);
    expect(h.close).not.toHaveBeenCalled();
    expect(host.stop).not.toHaveBeenCalled();
    // The share's release ends this capture.
    r.state.appAudio?.close();
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(host.stop).toHaveBeenCalledTimes(1);
  });

  it("leaves the video going when the host refuses", async () => {
    const r = rig();
    host.start.mockResolvedValue({ ok: false, code: "not_found" });
    await expect(
      publishAppAudio(r.state, r.room, r.screenTracks, r.video, 3, options),
    ).resolves.toBe("done");
    expect(r.publishTrack).not.toHaveBeenCalled();
    expect(r.state.appAudio).toBeUndefined();
    expect(r.screenTracks).toEqual([]);
  });

  it("reports stale when the share was replaced during the start", async () => {
    const r = rig();
    host.start.mockImplementation(() => {
      r.state.generation = 4;
      return Promise.resolve({ ok: false, code: "not_found" });
    });
    await expect(
      publishAppAudio(r.state, r.room, r.screenTracks, r.video, 3, options),
    ).resolves.toBe("stale");
  });

  it("reports stale when the share's track list was replaced during the start", async () => {
    const r = rig();
    host.start.mockImplementation(() => {
      r.state.manualScreenTracks = [];
      return Promise.resolve({ ok: false, code: "not_found" });
    });
    await expect(
      publishAppAudio(r.state, r.room, r.screenTracks, r.video, 3, options),
    ).resolves.toBe("stale");
  });

  it("reads an unset generation as 0", async () => {
    const r = rig();
    delete (r.state as { generation?: number }).generation;
    appOpens();
    await expect(
      publishAppAudio(r.state, r.room, r.screenTracks, r.video, 0, options),
    ).resolves.toBe("done");
    expect(r.publishTrack).toHaveBeenCalledTimes(1);
  });

  it("releases the sound and toasts when publishing fails, and the video share goes on", async () => {
    const r = rig();
    const h = appOpens();
    const boom = new Error("publish");
    r.publishTrack.mockRejectedValue(boom);
    await expect(
      publishAppAudio(r.state, r.room, r.screenTracks, r.video, 3, options),
    ).resolves.toBe("done");
    expect(r.state.appAudio).toBeUndefined();
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(r.screenTracks).toEqual([]);
    expect(showToast).toHaveBeenCalledExactlyOnceWith(FAILED, "warning");
    expect(logWarn).toHaveBeenCalledWith(
      "Publishing the app's sound failed; the video share goes on",
      boom,
    );
  });

  it("keeps a different sound the state holds when its own publish fails", async () => {
    const r = rig();
    appOpens();
    const other = { track: {}, close: vi.fn() } as unknown as NonNullable<typeof r.state.appAudio>;
    r.publishTrack.mockImplementation(() => {
      r.state.appAudio = other;
      return Promise.reject(new Error("publish"));
    });
    await publishAppAudio(r.state, r.room, r.screenTracks, r.video, 3, options);
    expect(r.state.appAudio).toBe(other);
  });

  it("reports stale without a toast when the share ended while publishing failed", async () => {
    const r = rig();
    appOpens();
    r.publishTrack.mockImplementation(() => {
      r.state.generation = 9;
      return Promise.reject(new Error("publish"));
    });
    await expect(
      publishAppAudio(r.state, r.room, r.screenTracks, r.video, 3, options),
    ).resolves.toBe("stale");
    expect(showToast).not.toHaveBeenCalled();
    expect(host.stop).toHaveBeenCalledTimes(1);
  });

  it("undoes the publish when the share ended while it was publishing", async () => {
    const r = rig();
    const h = appOpens();
    r.publishTrack.mockImplementation(() => {
      r.state.generation = 9;
      return Promise.resolve(undefined);
    });
    await expect(
      publishAppAudio(r.state, r.room, r.screenTracks, r.video, 3, options),
    ).resolves.toBe("stale");
    expect(r.state.appAudio).toBeUndefined();
    expect(h.close).toHaveBeenCalledTimes(1);
    expect(host.stop).toHaveBeenCalledTimes(1);
    expect(r.unpublishTrack).toHaveBeenCalledExactlyOnceWith(h.track);
    expect(r.screenTracks).toEqual([]);
  });

  it("keeps a different sound the state holds when the share ended while publishing", async () => {
    const r = rig();
    appOpens();
    const other = { track: {}, close: vi.fn() } as unknown as NonNullable<typeof r.state.appAudio>;
    r.publishTrack.mockImplementation(() => {
      r.state.generation = 9;
      r.state.appAudio = other;
      return Promise.resolve(undefined);
    });
    await publishAppAudio(r.state, r.room, r.screenTracks, r.video, 3, options);
    expect(r.state.appAudio).toBe(other);
  });

  it("logs and goes on when unpublishing the undone sound fails", async () => {
    const r = rig();
    appOpens();
    const boom = new Error("unpublish");
    r.unpublishTrack.mockRejectedValue(boom);
    r.publishTrack.mockImplementation(() => {
      r.state.generation = 9;
      return Promise.resolve(undefined);
    });
    await expect(
      publishAppAudio(r.state, r.room, r.screenTracks, r.video, 3, options),
    ).resolves.toBe("stale");
    await vi.waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith("Failed to unpublish the app's sound (non-fatal)", boom),
    );
  });

  it("keeps the video going when the host call itself throws", async () => {
    const r = rig();
    const boom = new Error("host");
    host.start.mockRejectedValue(boom);
    await expect(
      publishAppAudio(r.state, r.room, r.screenTracks, r.video, 3, options),
    ).resolves.toBe("done");
    expect(logWarn).toHaveBeenCalledWith("App audio failed; the video share goes on", boom);
  });

  it("reports stale when the host call throws after the share ended", async () => {
    const r = rig();
    host.start.mockImplementation(() => {
      r.state.generation = 9;
      return Promise.reject(new Error("host"));
    });
    await expect(
      publishAppAudio(r.state, r.room, r.screenTracks, r.video, 3, options),
    ).resolves.toBe("stale");
  });
});
