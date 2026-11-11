import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Room } from "livekit-client";
import { diagnosticServices, platformModuleMock } from "../helpers/diagnosticsServices";
import { SessionScope } from "@lib/net/sessionScope";
import { settingsText as t } from "../../src/i18n/settings";
import { isLinuxDesktop } from "../../src/features/voice/native/platform";
import {
  runConnectionDiagnostics,
  type DiagnosticResult,
  type DiagnosticServices,
} from "@lib/net/connectionDiagnostics";

vi.mock("../../src/features/voice/native/platform", async (importOriginal) =>
  platformModuleMock(
    await importOriginal<typeof import("../../src/features/voice/native/platform")>(),
  ),
);

/** The ordered stage and status of every result one run emits. */
type Sequence = string[];

describe("connection diagnostics result order", () => {
  let scope: SessionScope;
  let results: DiagnosticResult[];
  let config: { host: string; token: string };
  let services: DiagnosticServices;
  const track = { readyState: "live", stop: vi.fn() };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;

  const sequence = (): Sequence => results.map((r) => `${r.stage}:${r.status}`);
  const finalOf = (stage: string) => results.filter((r) => r.stage === stage).at(-1);
  const run = async (microphone: boolean, advanceMs = 0): Promise<void> => {
    const work = runConnectionDiagnostics(
      (r) => results.push(r),
      new AbortController().signal,
      microphone,
      services,
    );
    if (advanceMs > 0) await vi.advanceTimersByTimeAsync(advanceMs);
    await work;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    scope = new SessionScope({ host: "server.test:8443", generation: 1 });
    results = [];
    config = { host: "server.test:8443", token: "[redacted]" };
    vi.mocked(isLinuxDesktop).mockReturnValue(false);
    services = diagnosticServices(scope, stream, () => config);
  });
  afterEach(() => {
    scope.dispose();
    vi.useRealTimers();
  });

  it.each([
    [
      "everything checked and no call joined",
      { host: "server.test:8443", token: "t" },
      true,
      [
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
      ],
    ],
    [
      "nothing configured and the microphone unchecked",
      { host: "", token: "" },
      false,
      [
        "connection:not-tested",
        "authentication:not-tested",
        "websocket:not-tested",
        "microphone:not-tested",
        "signaling:not-tested",
        "media:not-tested",
      ],
    ],
    [
      "a server but no sign-in",
      { host: "server.test:8443", token: "" },
      false,
      [
        "connection:running",
        "connection:passed",
        "authentication:not-tested",
        "websocket:not-tested",
        "microphone:not-tested",
        "signaling:not-tested",
        "media:not-tested",
      ],
    ],
  ])("emits in stage order for %s", async (_name, cfg, microphone, expected) => {
    config = cfg;
    await run(microphone);
    expect(sequence()).toEqual(expected);
  });

  it.each([
    ["a permission denial", new DOMException("no", "NotAllowedError"), "micDenied" as const],
    ["another DOMException", new DOMException("no", "AbortError"), "micFailed" as const],
    ["a plain error", new Error("boom"), "micFailed" as const],
  ])("words a microphone rejected with %s", async (_name, error, key) => {
    services.getUserMedia = vi.fn().mockRejectedValue(error);
    await run(true);
    const detail = finalOf("microphone");
    expect(detail?.status).toBe("failed");
    expect(detail?.detail).toBe(t(`diagnostics.detail.${key}`));
  });

  describe("a joined call", () => {
    function room(pcManager: unknown, state = "connected", native = false): Room {
      const joined = {
        state,
        remoteParticipants: new Map([["other", {}]]),
        engine: { client: { ws: { readyState: WebSocket.OPEN } }, pcManager },
        ...(native ? { isSignalingConnected: vi.fn().mockReturnValue(true) } : {}),
      } as unknown as Room;
      services.getRoom = vi.fn().mockReturnValue(joined);
      return joined;
    }
    const stats = (frames: number[]) => {
      const getStats = vi.fn();
      for (const framesDecoded of frames) {
        getStats.mockResolvedValueOnce(
          new Map([["in", { id: "in", type: "inbound-rtp", framesDecoded }]]),
        );
      }
      return { getStats };
    };

    it.each([
      ["the subscriber", { subscriber: stats([1, 9, 9, 9]) }, "passed"],
      ["the publisher when there is no subscriber", { publisher: stats([1, 9, 9, 9]) }, "passed"],
      ["no transport at all", undefined, "not-tested"],
    ])("reads incoming media from %s", async (_name, pcManager, status) => {
      room(pcManager);
      await run(false, 3_100);
      expect(sequence().slice(-3)).toEqual([
        "signaling:passed",
        "media:running",
        `media:${status}`,
      ]);
      expect(finalOf("media")?.status).toBe(status);
    });

    it("asks a native call for its signaling even when it is not connected", async () => {
      const native = room(undefined, "reconnecting", true);
      await run(false);
      expect(
        (native as unknown as { isSignalingConnected: ReturnType<typeof vi.fn> })
          .isSignalingConnected,
      ).toHaveBeenCalledTimes(1);
      expect(sequence().slice(-2)).toEqual(["signaling:failed", "media:not-tested"]);
    });
  });
});
