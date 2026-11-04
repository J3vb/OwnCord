import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import { SessionScope } from "@lib/net/sessionScope";
import { isLinuxDesktop } from "../../src/features/voice/native/platform";
import { settingsText as t } from "../../src/i18n/settings";
import {
  runConnectionDiagnostics,
  type DiagnosticResult,
  type DiagnosticServices,
} from "@lib/net/connectionDiagnostics";

vi.mock("../../src/features/voice/native/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/features/voice/native/platform")>()),
  isLinuxDesktop: vi.fn(() => false),
}));

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
      probeNativeInput: vi.fn().mockResolvedValue("levels"),
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

  /** Runs the media check against a subscriber whose getStats is `stats`; it must end "not-tested". */
  async function expectMediaNotTested(stats: ReturnType<typeof vi.fn>): Promise<void> {
    services.getRoom = vi.fn().mockReturnValue({
      state: "connected",
      remoteParticipants: new Map([["other", {}]]),
      engine: {
        client: { ws: { readyState: WebSocket.OPEN } },
        pcManager: { subscriber: { getStats: stats } },
      },
    });
    const work = run(false);
    await vi.advanceTimersByTimeAsync(3_100);
    await work;
    expect(final("media")?.status).toBe("not-tested");
  }

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

  describe("check outcomes", () => {
    const sequence = () => results.map((r) => `${r.stage}:${r.status}`);

    afterEach(() => localStorage.removeItem("owncord:settings:audioInputDevice"));

    it("reports each stage as running and then settled, in order", async () => {
      await run();
      expect(sequence()).toEqual([
        "connection:running",
        "connection:passed",
        "authentication:running",
        "authentication:passed",
        "websocket:running",
        "websocket:passed",
        "microphone:running",
        "microphone:passed",
        "signaling:not-tested",
        "media:not-tested",
      ]);
      expect(results[0]?.detail).toBe(t("diagnostics.detail.checking"));
      expect(final("connection")?.detail).toBe(t("diagnostics.detail.connectionPassed"));
      expect(final("authentication")?.detail).toBe(t("diagnostics.detail.authPassed"));
      expect(final("websocket")?.detail).toBe(t("diagnostics.detail.wsPassed"));
      expect(final("microphone")?.detail).toBe(t("diagnostics.detail.micPassed"));
      expect(final("signaling")?.detail).toBe(t("diagnostics.detail.joinVoice"));
      expect(final("media")?.detail).toBe(t("diagnostics.detail.joinCall"));
    });

    it("does not test the connection, and says so, when no server is chosen", async () => {
      services.api.getConfig = () => ({ host: "", token: "[redacted]" });
      await run(false);
      expect(services.api.getHealth).not.toHaveBeenCalled();
      expect(results[0]).toEqual({
        stage: "connection",
        status: "not-tested",
        detail: t("diagnostics.detail.noServer"),
      });
      expect(final("authentication")?.status).toBe("passed");
    });

    it("does not test sign-in or messages, and says so, when signed out", async () => {
      services.api.getConfig = () => ({ host: "server.test:8443", token: undefined });
      await run(false);
      expect(services.api.getMe).not.toHaveBeenCalled();
      expect(services.ws.ping).not.toHaveBeenCalled();
      expect(final("connection")?.status).toBe("passed");
      expect(final("authentication")).toEqual({
        stage: "authentication",
        status: "not-tested",
        detail: t("diagnostics.detail.signInAccount"),
      });
      expect(final("websocket")).toEqual({
        stage: "websocket",
        status: "not-tested",
        detail: t("diagnostics.detail.signInMessage"),
      });
    });

    it("explains a skipped microphone check", async () => {
      await run(false);
      expect(final("microphone")).toEqual({
        stage: "microphone",
        status: "not-tested",
        detail: t("diagnostics.detail.micSkipped"),
      });
    });

    it("emits nothing further once the run is cancelled between results", async () => {
      services.api.getConfig = () => ({ host: "", token: undefined });
      const work = runConnectionDiagnostics(
        (r) => {
          results.push(r);
          ac.abort();
        },
        ac.signal,
        false,
        services,
      );
      await expect(work).rejects.toMatchObject({ name: "AbortError" });
      expect(results).toHaveLength(1);
      expect(results[0]?.stage).toBe("connection");
    });

    it("settles at once when the run is cancelled as a check starts", async () => {
      services.api.getHealth = vi.fn().mockReturnValue(new Promise(() => {}));
      let settled = false;
      const work = runConnectionDiagnostics(
        (r) => {
          results.push(r);
          ac.abort();
        },
        ac.signal,
        false,
        services,
      ).then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(true);
      await work;
      expect(results).toHaveLength(1);
    });

    it("refuses to run before diagnostics are configured", async () => {
      await expect(
        runConnectionDiagnostics((r) => results.push(r), ac.signal, false, null),
      ).rejects.toBeInstanceOf(Error);
      expect(results).toEqual([]);
    });

    describe("timing and cleanup", () => {
      it("gives a server check eight seconds and then reports a timeout", async () => {
        services.api.getHealth = vi.fn().mockReturnValue(new Promise(() => {}));
        const work = run(false);
        await vi.advanceTimersByTimeAsync(7_900);
        expect(final("connection")?.status).toBe("running");
        await vi.advanceTimersByTimeAsync(200);
        expect(final("connection")).toEqual({
          stage: "connection",
          status: "failed",
          detail: t("diagnostics.detail.connectionTimeout"),
        });
        await work;
      });

      it("does not call another DOMException a timeout", async () => {
        services.api.getHealth = vi
          .fn()
          .mockRejectedValue(new DOMException("blocked", "NetworkError"));
        await run(false);
        expect(final("connection")?.detail).toBe(t("diagnostics.detail.connectionRefused"));
      });

      it("reports a refused connection with its own wording", async () => {
        services.api.getHealth = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
        await run(false);
        expect(final("connection")).toEqual({
          stage: "connection",
          status: "failed",
          detail: t("diagnostics.detail.connectionRefused"),
        });
      });

      it("reports a failed account request and a failed heartbeat with their own wording", async () => {
        services.api.getMe = vi.fn().mockRejectedValue(new Error("401"));
        services.ws.ping = vi.fn().mockRejectedValue(new Error("closed"));
        await run(false);
        expect(final("authentication")?.detail).toBe(t("diagnostics.detail.authFailed"));
        expect(final("websocket")?.detail).toBe(t("diagnostics.detail.wsFailed"));
      });

      it("gives the microphone twelve seconds, not eight", async () => {
        services.getUserMedia = () => new Promise(() => {});
        const work = run();
        await vi.advanceTimersByTimeAsync(8_100);
        expect(final("microphone")?.status).toBe("running");
        await vi.advanceTimersByTimeAsync(3_800);
        expect(final("microphone")?.status).toBe("running");
        await vi.advanceTimersByTimeAsync(200);
        expect(final("microphone")?.detail).toBe(t("diagnostics.detail.micTimeout"));
        await work;
      });

      it("leaves no timer behind when every check finishes", async () => {
        await run();
        expect(vi.getTimerCount()).toBe(0);
      });

      /** Watches the run's combined signal: every abort listener must be added once-only and removed again. */
      function watchLifetime(): { expectReleased(): void; stop(): void } {
        const lifetimes: AbortSignal[] = [];
        const realAny = AbortSignal.any.bind(AbortSignal);
        const spy = vi.spyOn(AbortSignal, "any").mockImplementation((signals) => {
          const signal = realAny(signals);
          vi.spyOn(signal, "addEventListener");
          vi.spyOn(signal, "removeEventListener");
          lifetimes.push(signal);
          return signal;
        });
        return {
          stop: () => spy.mockRestore(),
          expectReleased: () => {
            expect(lifetimes).toHaveLength(1);
            const lifetime = lifetimes[0]!;
            const added = vi.mocked(lifetime.addEventListener).mock.calls;
            const removed = vi.mocked(lifetime.removeEventListener).mock.calls;
            expect(added.length).toBeGreaterThan(0);
            for (const [type, listener, options] of added) {
              expect(type).toBe("abort");
              expect(options).toEqual({ once: true });
              expect(removed).toContainEqual(["abort", listener]);
            }
            expect(vi.getTimerCount()).toBe(0);
          },
        };
      }

      it("releases its abort listeners and timers after a full media check", async () => {
        const watch = watchLifetime();
        try {
          activeRoom({ framesDecoded: 1 }, { framesDecoded: 5 });
          const work = run();
          await vi.advanceTimersByTimeAsync(3_100);
          await work;
          expect(vi.mocked(AbortSignal.any).mock.calls).toHaveLength(1);
          watch.expectReleased();
        } finally {
          watch.stop();
        }
      });

      it("releases them after a check that fails", async () => {
        const watch = watchLifetime();
        try {
          services.api.getHealth = vi.fn().mockRejectedValue(new Error("down"));
          await run(false);
          watch.expectReleased();
        } finally {
          watch.stop();
        }
      });

      it("releases them after a check that times out", async () => {
        const watch = watchLifetime();
        try {
          services.api.getHealth = vi.fn().mockReturnValue(new Promise(() => {}));
          const work = run(false);
          await vi.advanceTimersByTimeAsync(8_100);
          await work;
          watch.expectReleased();
        } finally {
          watch.stop();
        }
      });

      it("releases them when the run is cancelled during a check", async () => {
        const watch = watchLifetime();
        try {
          services.api.getHealth = vi.fn().mockReturnValue(new Promise(() => {}));
          const work = run(false).catch((e: unknown) => e);
          await vi.advanceTimersByTimeAsync(100);
          ac.abort();
          await expect(work).resolves.toMatchObject({ name: "AbortError" });
          watch.expectReleased();
        } finally {
          watch.stop();
        }
      });

      it("stops a pending wait for media when the run is cancelled, and rejects", async () => {
        const watch = watchLifetime();
        try {
          activeRoom({ framesDecoded: 1 }, { framesDecoded: 5 });
          const work = run().catch((e: unknown) => e);
          await vi.advanceTimersByTimeAsync(1_500);
          expect(final("media")?.status).toBe("running");
          ac.abort();
          await expect(work).resolves.toMatchObject({ name: "AbortError" });
          expect(final("media")?.status).toBe("running");
          watch.expectReleased();
        } finally {
          watch.stop();
        }
      });
    });

    describe("microphone", () => {
      it("opens the saved device by exact id, audio only", async () => {
        localStorage.setItem("owncord:settings:audioInputDevice", JSON.stringify("mic-1"));
        await run();
        expect(services.getUserMedia).toHaveBeenCalledTimes(1);
        expect(services.getUserMedia).toHaveBeenCalledWith({
          audio: { deviceId: { exact: "mic-1" } },
          video: false,
        });
      });

      it("opens the system default, audio only, when none is saved", async () => {
        await run();
        expect(services.getUserMedia).toHaveBeenCalledTimes(1);
        expect(services.getUserMedia).toHaveBeenCalledWith({ audio: {}, video: false });
      });

      it("does not retry a missing device when none was asked for", async () => {
        services.getUserMedia = vi
          .fn()
          .mockRejectedValue(new DOMException("none", "NotFoundError"));
        await run();
        expect(services.getUserMedia).toHaveBeenCalledTimes(1);
        expect(final("microphone")).toEqual({
          stage: "microphone",
          status: "failed",
          detail: t("diagnostics.detail.micFailed"),
        });
      });

      it("passes when one of several tracks is live, and stops them all", async () => {
        const first = { readyState: "ended", stop: vi.fn() };
        const second = { readyState: "live", stop: vi.fn() };
        services.getUserMedia = vi.fn().mockResolvedValue({
          getAudioTracks: () => [first, second],
          getTracks: () => [first, second],
        });
        await run();
        expect(final("microphone")?.status).toBe("passed");
        expect(first.stop).toHaveBeenCalledTimes(1);
        expect(second.stop).toHaveBeenCalledTimes(1);
      });

      it("fails when no track is live, and still stops the capture", async () => {
        const ended = { readyState: "ended", stop: vi.fn() };
        services.getUserMedia = vi.fn().mockResolvedValue({
          getAudioTracks: () => [ended],
          getTracks: () => [ended],
        });
        await run();
        expect(final("microphone")).toEqual({
          stage: "microphone",
          status: "failed",
          detail: t("diagnostics.detail.micFailed"),
        });
        expect(ended.stop).toHaveBeenCalledTimes(1);
      });

      it("fails when the stream has no audio track at all", async () => {
        services.getUserMedia = vi.fn().mockResolvedValue({
          getAudioTracks: () => [],
          getTracks: () => [],
        });
        await run();
        expect(final("microphone")?.status).toBe("failed");
      });

      it.each([
        ["a denied permission", new DOMException("x", "NotAllowedError"), "micDenied"],
        ["a prompt that timed out", new DOMException("x", "TimeoutError"), "micTimeout"],
        ["another DOMException", new DOMException("x", "SecurityError"), "micFailed"],
        ["a plain Error", new Error("x"), "micFailed"],
        [
          "an Error named like a timeout",
          Object.assign(new Error("x"), { name: "TimeoutError" }),
          "micFailed",
        ],
      ] as const)("words %s", async (_name, thrown, key) => {
        services.getUserMedia = vi.fn().mockRejectedValue(thrown);
        await run();
        expect(final("microphone")?.detail).toBe(t(`diagnostics.detail.${key}`));
      });

      describe("native backend", () => {
        const inputs = [{ deviceId: "alsa:default", label: "Default", kind: "audioinput" }];

        it("opens the default with no saved choice and calls it the selected microphone", async () => {
          services.listNativeInputs = vi.fn().mockResolvedValue(inputs);
          await run();
          expect(services.probeNativeInput).toHaveBeenCalledWith("", expect.any(AbortSignal));
          expect(final("microphone")).toEqual({
            stage: "microphone",
            status: "passed",
            detail: t("diagnostics.detail.micNativePresent"),
          });
        });

        it("says the default was used when the saved microphone is gone", async () => {
          localStorage.setItem("owncord:settings:audioInputDevice", JSON.stringify("alsa:gone"));
          services.listNativeInputs = vi.fn().mockResolvedValue(inputs);
          await run();
          expect(final("microphone")?.detail).toBe(t("diagnostics.detail.micNativeDefault"));
        });

        it("words a capture that opened but reported no audio", async () => {
          services.listNativeInputs = vi.fn().mockResolvedValue(inputs);
          services.probeNativeInput = vi.fn().mockResolvedValue("silent");
          await run();
          expect(final("microphone")).toEqual({
            stage: "microphone",
            status: "failed",
            detail: t("diagnostics.detail.micSilent"),
          });
        });

        it("words a list with no microphone as a failure", async () => {
          services.listNativeInputs = vi.fn().mockResolvedValue([]);
          await run();
          expect(final("microphone")).toEqual({
            stage: "microphone",
            status: "failed",
            detail: t("diagnostics.detail.micFailed"),
          });
          expect(services.probeNativeInput).not.toHaveBeenCalled();
        });
      });
    });

    describe("voice signaling and media", () => {
      function browserRoom(patch: Record<string, unknown> = {}): Room {
        const room = {
          state: "connected",
          remoteParticipants: new Map([["other", {}]]),
          engine: {
            client: { ws: { readyState: WebSocket.OPEN } },
            pcManager: { subscriber: { getStats: vi.fn().mockResolvedValue(new Map()) } },
          },
          ...patch,
        } as unknown as Room;
        services.getRoom = vi.fn().mockReturnValue(room);
        return room;
      }

      it("passes signaling and then reports that nobody else is in the call", async () => {
        browserRoom({ remoteParticipants: new Map() });
        await run(false);
        expect(final("signaling")).toEqual({
          stage: "signaling",
          status: "passed",
          detail: t("diagnostics.detail.signalingOpen"),
        });
        expect(final("media")).toEqual({
          stage: "media",
          status: "not-tested",
          detail: t("diagnostics.detail.noParticipant"),
        });
      });

      it.each([
        ["a socket that is closed", { state: "connected", ws: { readyState: WebSocket.CLOSED } }],
        ["no socket", { state: "connected", ws: undefined }],
        [
          "a call that is reconnecting",
          { state: "reconnecting", ws: { readyState: WebSocket.OPEN } },
        ],
        ["a call that is reconnecting with no socket", { state: "reconnecting", ws: undefined }],
      ])("fails signaling for %s and does not test media", async (_name, shape) => {
        browserRoom({
          state: shape.state,
          engine: { client: { ws: shape.ws }, pcManager: undefined },
        });
        await run(false);
        expect(final("signaling")).toEqual({
          stage: "signaling",
          status: "failed",
          detail: t("diagnostics.detail.signalingClosed"),
        });
        expect(final("media")).toEqual({
          stage: "media",
          status: "not-tested",
          detail: t("diagnostics.detail.restoreVoice"),
        });
      });

      it("announces the listening window before it ends", async () => {
        activeRoom({ framesDecoded: 1 }, { framesDecoded: 5 });
        const work = run(false);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(final("media")).toEqual({
          stage: "media",
          status: "running",
          detail: t("diagnostics.detail.listening"),
        });
        await vi.advanceTimersByTimeAsync(2_100);
        await work;
        expect(final("media")?.status).toBe("passed");
      });

      it("reports audio and video together", async () => {
        activeRoom(
          { totalAudioEnergy: 1, totalSamplesReceived: 100, concealedSamples: 0, framesDecoded: 1 },
          { totalAudioEnergy: 2, totalSamplesReceived: 200, concealedSamples: 0, framesDecoded: 9 },
        );
        const work = run(false);
        await vi.advanceTimersByTimeAsync(3_100);
        await work;
        expect(final("media")).toEqual({
          stage: "media",
          status: "passed",
          detail: t("diagnostics.detail.mediaPassed", {
            kinds: t("diagnostics.detail.kinds.audioAndVideo"),
          }),
        });
      });

      it("reports audio alone", async () => {
        activeRoom(
          { totalAudioEnergy: 1, totalSamplesReceived: 100, concealedSamples: 0 },
          { totalAudioEnergy: 2, totalSamplesReceived: 200, concealedSamples: 0 },
        );
        const work = run(false);
        await vi.advanceTimersByTimeAsync(3_100);
        await work;
        expect(final("media")?.detail).toBe(
          t("diagnostics.detail.mediaPassed", { kinds: t("diagnostics.detail.kinds.audio") }),
        );
      });

      it("reports video alone", async () => {
        activeRoom({ framesDecoded: 1 }, { framesDecoded: 2 });
        const work = run(false);
        await vi.advanceTimersByTimeAsync(3_100);
        await work;
        expect(final("media")?.detail).toBe(
          t("diagnostics.detail.mediaPassed", { kinds: t("diagnostics.detail.kinds.video") }),
        );
      });

      it.each([
        [
          "energy rises but decoded samples do not",
          { totalAudioEnergy: 1, totalSamplesReceived: 100, concealedSamples: 0 },
          { totalAudioEnergy: 2, totalSamplesReceived: 100, concealedSamples: 0 },
        ],
        [
          "decoded samples rise but energy does not",
          { totalAudioEnergy: 1, totalSamplesReceived: 100, concealedSamples: 0 },
          { totalAudioEnergy: 1, totalSamplesReceived: 200, concealedSamples: 0 },
        ],
        [
          "energy rises while every new sample is concealed",
          { totalAudioEnergy: 3, totalSamplesReceived: 100, concealedSamples: 0 },
          { totalAudioEnergy: 4, totalSamplesReceived: 200, concealedSamples: 100 },
        ],
        [
          "nothing changes",
          { totalAudioEnergy: 1, totalSamplesReceived: 100, concealedSamples: 0, framesDecoded: 3 },
          { totalAudioEnergy: 1, totalSamplesReceived: 100, concealedSamples: 0, framesDecoded: 3 },
        ],
      ])("does not call it working media when %s", async (_name, before, after) => {
        activeRoom(before, after);
        const work = run(false);
        await vi.advanceTimersByTimeAsync(3_100);
        await work;
        expect(final("media")).toEqual({
          stage: "media",
          status: "not-tested",
          detail: t("diagnostics.detail.mediaMissing"),
        });
      });

      it("counts only inbound streams as evidence", async () => {
        const stats = vi
          .fn()
          .mockResolvedValueOnce(
            new Map([["out", { id: "out", type: "outbound-rtp", framesDecoded: 1 }]]),
          )
          .mockResolvedValue(
            new Map([["out", { id: "out", type: "outbound-rtp", framesDecoded: 50 }]]),
          );
        await expectMediaNotTested(stats);
      });

      it("ignores an inbound stream that has no string id", async () => {
        const stats = vi
          .fn()
          .mockResolvedValueOnce(new Map([["x", { type: "inbound-rtp", framesDecoded: 1 }]]))
          .mockResolvedValue(new Map([["x", { type: "inbound-rtp", framesDecoded: 50 }]]));
        await expectMediaNotTested(stats);
      });

      it("fails the media check when the call reconnects during the wait", async () => {
        const room = activeRoom({ framesDecoded: 1 }, { framesDecoded: 9 });
        const work = run(false);
        await vi.advanceTimersByTimeAsync(1_000);
        (room as unknown as { state: string }).state = "reconnecting";
        await vi.advanceTimersByTimeAsync(2_100);
        await work;
        expect(final("media")).toEqual({
          stage: "media",
          status: "failed",
          detail: t("diagnostics.detail.callChanged"),
        });
      });

      it("fails the media check when the statistics cannot be read", async () => {
        const room = activeRoom({ framesDecoded: 1 }, { framesDecoded: 9 });
        (
          room.engine.pcManager as unknown as { subscriber: { getStats: unknown } }
        ).subscriber.getStats = vi.fn().mockRejectedValue(new Error("stats unavailable"));
        await run(false);
        expect(final("media")).toEqual({
          stage: "media",
          status: "failed",
          detail: t("diagnostics.detail.mediaFailed"),
        });
      });
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
      expect(services.probeNativeInput).toHaveBeenCalledWith(
        "alsa:usb-mic",
        expect.any(AbortSignal),
      );
      expect(final("microphone")).toMatchObject({
        status: "passed",
        detail: expect.stringContaining("microphone opened and reported audio"),
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
      expect(services.probeNativeInput).toHaveBeenCalledWith("", expect.any(AbortSignal));
    });

    it("fails the microphone check when the native backend lists no microphone", async () => {
      services.listNativeInputs = vi.fn().mockResolvedValue([]);
      await run();
      expect(services.getUserMedia).not.toHaveBeenCalled();
      expect(final("microphone")?.status).toBe("failed");
    });

    describe("microphone capture", () => {
      beforeEach(() => {
        services.listNativeInputs = vi
          .fn()
          .mockResolvedValue([{ deviceId: "alsa:default", label: "Default", kind: "audioinput" }]);
      });

      it("fails with the microphone wording when the opened device reports nothing", async () => {
        services.probeNativeInput = vi.fn().mockResolvedValue("silent");
        await run();
        expect(final("microphone")).toMatchObject({
          status: "failed",
          detail: expect.stringContaining("no audio arrived"),
        });
      });

      it("fails when the capture cannot open", async () => {
        services.probeNativeInput = vi.fn().mockRejectedValue(new Error("no device"));
        await run();
        expect(final("microphone")).toMatchObject({
          status: "failed",
          detail: expect.stringContaining("could not open"),
        });
      });

      it("does not call it a pass when a call already holds the capture", async () => {
        services.probeNativeInput = vi.fn().mockResolvedValue("in-call");
        await run();
        expect(final("microphone")).toMatchObject({
          status: "not-tested",
          detail: expect.stringContaining("You are in a call"),
        });
      });

      it("hands the probe a signal that cancelling the run aborts", async () => {
        let seen!: AbortSignal;
        services.probeNativeInput = vi.fn().mockImplementation((_input, signal: AbortSignal) => {
          seen = signal;
          return new Promise(() => {});
        });
        const work = run().catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(1);
        expect(seen.aborted).toBe(false);
        ac.abort();
        await work;
        expect(seen.aborted).toBe(true);
      });

      it("skips the capture when the microphone check is unchecked", async () => {
        await run(false);
        expect(services.probeNativeInput).not.toHaveBeenCalled();
      });
    });

    it("says why incoming media was not tested when no call is joined", async () => {
      vi.mocked(isLinuxDesktop).mockReturnValue(true);
      try {
        await run(false);
        expect(final("media")).toMatchObject({
          status: "not-tested",
          detail: expect.stringContaining("no WebRTC"),
        });
      } finally {
        vi.mocked(isLinuxDesktop).mockReturnValue(false);
      }
    });

    it("keeps asking for a call elsewhere when no call is joined", async () => {
      await run(false);
      expect(final("media")?.detail).toContain("Join a call");
    });
  });
});
