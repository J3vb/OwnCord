import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import { SessionScope } from "@lib/sessionScope";
import {
  runConnectionDiagnostics,
  type DiagnosticResult,
  type DiagnosticServices,
} from "@lib/connectionDiagnostics";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("connection diagnostics", () => {
  let scope: SessionScope;
  let ac: AbortController;
  let services: DiagnosticServices;
  let results: DiagnosticResult[];
  let stop: ReturnType<typeof vi.fn>;
  let stream: MediaStream;
  const final = (stage: DiagnosticResult["stage"]) =>
    results.filter((r) => r.stage === stage).at(-1);
  const run = (microphone = true) =>
    runConnectionDiagnostics((r) => results.push(r), ac.signal, microphone, services);

  beforeEach(() => {
    vi.useFakeTimers();
    scope = new SessionScope({ host: "server.test:8443", generation: 1 });
    ac = new AbortController();
    results = [];
    stop = vi.fn();
    const track = { readyState: "live", stop };
    stream = { getAudioTracks: () => [track], getTracks: () => [track] } as unknown as MediaStream;
    services = {
      api: {
        getSession: () => scope,
        getConfig: () => ({ host: "server.test:8443", token: "[redacted]" }),
        getHealth: vi.fn().mockResolvedValue({}),
        getMe: vi.fn().mockResolvedValue({ id: 1 }),
      },
      ws: { ping: vi.fn().mockResolvedValue(undefined) },
      getRoom: vi.fn().mockReturnValue(null),
      getUserMedia: vi.fn().mockResolvedValue(stream),
      listNativeInputs: vi.fn().mockResolvedValue(null),
    };
  });
  afterEach(() => {
    ac.abort();
    scope.dispose();
    vi.useRealTimers();
  });

  it("uses the configured authenticated services and reports untested media without joining", async () => {
    await run();
    expect(services.api.getHealth).toHaveBeenCalledWith(undefined, 5000, expect.any(AbortSignal));
    expect(services.api.getMe).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(services.ws.ping).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(final("connection")?.status).toBe("passed");
    expect(final("authentication")?.status).toBe("passed");
    expect(final("websocket")?.status).toBe("passed");
    expect(final("signaling")?.status).toBe("not-tested");
    expect(final("media")?.status).toBe("not-tested");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not request the microphone when unchecked", async () => {
    await run(false);
    expect(services.getUserMedia).not.toHaveBeenCalled();
    expect(final("microphone")?.status).toBe("not-tested");
  });

  it("checks the system default microphone when the saved one is unplugged", async () => {
    localStorage.setItem("owncord:settings:audioInputDevice", JSON.stringify("gone-mic"));
    services.getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(new DOMException("gone", "OverconstrainedError"))
      .mockResolvedValueOnce(stream);
    try {
      await run();
    } finally {
      localStorage.removeItem("owncord:settings:audioInputDevice");
    }
    expect(services.getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: "default" },
      video: false,
    });
    expect(final("microphone")?.status).toBe("passed");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("reports denied microphone access without treating the call as tested", async () => {
    services.getUserMedia = vi
      .fn()
      .mockRejectedValue(new DOMException("secret", "NotAllowedError"));
    await run();
    expect(final("microphone")).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("denied"),
    });
    expect(final("media")?.status).toBe("not-tested");
    expect(JSON.stringify(results)).not.toContain("secret");
  });

  it("bounds a hung permission prompt and stops capture granted after the timeout", async () => {
    const late = deferred<MediaStream>();
    services.getUserMedia = () => late.promise;
    const work = run();
    await vi.advanceTimersByTimeAsync(12_100);
    await work;
    expect(final("microphone")).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("prompt did not finish"),
    });
    const before = [...results];
    late.resolve(stream);
    await vi.advanceTimersByTimeAsync(0);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(results).toEqual(before);
  });

  it.each(["cancel", "session change"])(
    "stops late microphone capture after %s and emits no stale success",
    async (reason) => {
      const late = deferred<MediaStream>();
      services.getUserMedia = () => late.promise;
      const work = run();
      const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(0);
      expect(final("microphone")?.status).toBe("running");
      if (reason === "cancel") ac.abort();
      else scope.dispose();
      await rejected;
      const before = [...results];
      late.resolve(stream);
      await vi.advanceTimersByTimeAsync(0);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(results).toEqual(before);
    },
  );

  it("does not accept a late health result after switching accounts on the same server", async () => {
    const late = deferred<never>();
    services.api.getHealth = () => late.promise;
    const work = run();
    const rejected = expect(work).rejects.toMatchObject({ name: "AbortError" });
    scope.dispose();
    await rejected;
    expect(services.api.getMe).not.toHaveBeenCalled();
    expect(services.getUserMedia).not.toHaveBeenCalled();
    expect(final("connection")?.status).toBe("running");
  });

  it("separates HTTP failure from other path evidence and redacts raw errors", async () => {
    services.api.getHealth = vi
      .fn()
      .mockRejectedValue(new Error("https://secret:token@host/private"));
    services.ws.ping = vi.fn().mockRejectedValue(new Error("private"));
    await run();
    expect(final("connection")?.status).toBe("failed");
    expect(final("websocket")?.status).toBe("failed");
    expect(final("authentication")?.status).toBe("passed");
    expect(JSON.stringify(results)).not.toContain("secret");
  });

  function activeRoom(
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    singleConnection = false,
  ): Room {
    const stats = vi
      .fn()
      .mockResolvedValueOnce(new Map([["audio", { id: "audio", type: "inbound-rtp", ...before }]]))
      .mockResolvedValue(new Map([["audio", { id: "audio", type: "inbound-rtp", ...after }]]));
    const room = {
      state: "connected",
      remoteParticipants: new Map([["other", {}]]),
      engine: {
        client: { ws: { readyState: WebSocket.OPEN } },
        pcManager: singleConnection
          ? { publisher: { getStats: stats } }
          : {
              subscriber: { getStats: stats },
              // Outgoing media must never be accepted as incoming evidence.
              publisher: { getStats: vi.fn().mockRejectedValue(new Error("publisher read")) },
            },
      },
    } as unknown as Room;
    services.getRoom = vi.fn().mockReturnValue(room);
    return room;
  }

  it.each([false, true])(
    "requires advancing decoded audio energy and nonconcealed samples (single connection: %s)",
    async (singleConnection) => {
      activeRoom(
        { totalAudioEnergy: 4, totalSamplesReceived: 100, concealedSamples: 0 },
        { totalAudioEnergy: 5, totalSamplesReceived: 200, concealedSamples: 0 },
        singleConnection,
      );
      const work = run();
      await vi.advanceTimersByTimeAsync(3100);
      await work;
      expect(final("signaling")?.status).toBe("passed");
      expect(final("media")).toMatchObject({
        status: "passed",
        detail: expect.stringContaining("Incoming audio decoded"),
      });
    },
  );

  it.each([
    [{ bytesReceived: 1 }, { bytesReceived: 50 }],
    [
      { totalAudioEnergy: 3, totalSamplesReceived: 100, concealedSamples: 0 },
      { totalAudioEnergy: 3, totalSamplesReceived: 200, concealedSamples: 100 },
    ],
    [{ framesDecoded: 5 }, { framesDecoded: 5 }],
  ])(
    "does not report packet receipt, concealment or old decoded frames as working media",
    async (before, after) => {
      activeRoom(before, after);
      const work = run();
      await vi.advanceTimersByTimeAsync(3100);
      await work;
      expect(final("media")?.status).toBe("not-tested");
    },
  );

  it("can prove incoming video without claiming audio works", async () => {
    activeRoom({ framesDecoded: 4 }, { framesDecoded: 9 });
    const work = run();
    await vi.advanceTimersByTimeAsync(3100);
    await work;
    expect(final("media")?.detail).toContain("Incoming video decoded");
    expect(final("media")?.detail).not.toContain("audio decoded");
  });

  it("rejects media evidence collected from a replaced call", async () => {
    activeRoom({ framesDecoded: 4 }, { framesDecoded: 9 });
    const work = run();
    await vi.advanceTimersByTimeAsync(1);
    services.getRoom = vi.fn().mockReturnValue(null);
    await vi.advanceTimersByTimeAsync(3100);
    await work;
    expect(final("media")).toMatchObject({
      status: "failed",
      detail: expect.stringContaining("call changed"),
    });
  });

  describe("Linux native voice", () => {
    afterEach(() => localStorage.removeItem("owncord:settings:audioInputDevice"));
    function nativeRoom(state = "connected", signaling = true): Room {
      const room = {
        state,
        remoteParticipants: new Map([["other", {}]]),
        // The native room has no browser transports or signaling socket.
        engine: { pcManager: undefined, client: { ws: undefined } },
        isSignalingConnected: vi.fn().mockReturnValue(signaling),
      } as unknown as Room;
      services.getRoom = vi.fn().mockReturnValue(room);
      return room;
    }

    it("passes signaling on a connected native call and does not claim media was checked", async () => {
      nativeRoom();
      await run(false);
      expect(final("signaling")?.status).toBe("passed");
      expect(final("media")).toMatchObject({
        status: "not-tested",
        detail: expect.stringContaining("Linux"),
      });
    });

    it("fails signaling while the native backend is reconnecting", async () => {
      nativeRoom("reconnecting", false);
      await run(false);
      expect(final("signaling")?.status).toBe("failed");
    });

    it("checks the saved microphone against the native list without opening a webview device", async () => {
      localStorage.setItem("owncord:settings:audioInputDevice", JSON.stringify("alsa:usb-mic"));
      services.listNativeInputs = vi.fn().mockResolvedValue([
        { deviceId: "alsa:default", label: "Default", kind: "audioinput" },
        { deviceId: "alsa:usb-mic", label: "USB mic", kind: "audioinput" },
      ]);
      await run();
      expect(services.getUserMedia).not.toHaveBeenCalled();
      expect(final("microphone")).toMatchObject({
        status: "passed",
        detail: expect.stringContaining("microphone is connected"),
      });
    });

    it("says calls will use the default when the saved native microphone is gone", async () => {
      localStorage.setItem("owncord:settings:audioInputDevice", JSON.stringify("alsa:gone"));
      services.listNativeInputs = vi
        .fn()
        .mockResolvedValue([{ deviceId: "alsa:default", label: "Default", kind: "audioinput" }]);
      await run();
      expect(final("microphone")).toMatchObject({
        status: "passed",
        detail: expect.stringContaining("system default"),
      });
    });

    it("fails the microphone check when the native backend lists no microphone", async () => {
      services.listNativeInputs = vi.fn().mockResolvedValue([]);
      await run();
      expect(services.getUserMedia).not.toHaveBeenCalled();
      expect(final("microphone")?.status).toBe("failed");
    });
  });
});
