// Behaviour suite for the LiveKit half of the `NativeProxies` contract
// (`src/platform/contracts/nativeProxies.ts`): `setLiveKitServerHost`,
// `resolveLiveKitUrl`, `stopLiveKitProxy`. Written in B7-5 against the
// in-place seam (`LiveKitUrlResolver`, `lib/voice/livekitUrlResolver.ts`) before
// the move, so it pins today's behaviour rather than the moved code's.
//
// No test for `stopLiveKitProxy` on its own: it is fire-and-forget and hands
// the caller nothing back, so "it does not throw" is exactly what a subject
// that does nothing also does. `resolveLiveKitUrl` re-starts the tunnel on
// every call by design, so there is no "restarts after stop" effect to pin
// either.
import { beforeEach, describe, expect, test, type Mock } from "vitest";
import type { NativeProxies } from "../../../src/platform/contracts/nativeProxies";

export interface NativeControl {
  /** The native tunnel starts, listening on `port` with path token `tun`. */
  succeedWith(port: number): void;
  failWith(error: unknown): void;
}

/** Drives the `start_livekit_proxy` command on a mocked Tauri `invoke`. */
export function livekitNativeControl(invoke: Mock): NativeControl {
  return {
    succeedWith(port) {
      invoke.mockImplementation((cmd: string) =>
        cmd === "start_livekit_proxy"
          ? Promise.resolve({ port, token: "tun" })
          : Promise.resolve(undefined),
      );
    },
    failWith(error) {
      invoke.mockImplementation((cmd: string) =>
        cmd === "start_livekit_proxy" ? Promise.reject(error) : Promise.resolve(undefined),
      );
    },
  };
}

export type LiveKitProxiesSeam = Pick<
  NativeProxies,
  "setLiveKitServerHost" | "resolveLiveKitUrl" | "stopLiveKitProxy"
>;

// Matched by name: a suite may load the subject through a fresh module graph.
const REFUSED = { name: "LiveKitAddressError" };

export interface LiveKitProxiesSubject {
  readonly subject: LiveKitProxiesSeam;
  readonly native: NativeControl;
}

export function describeLiveKitProxiesSuite(
  makeSubject: () => Promise<LiveKitProxiesSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("NativeProxies (LiveKit seam)", () => {
    let ctx: LiveKitProxiesSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("routes a remote server's proxy path through the loopback tunnel", async () => {
      ctx.native.succeedWith(40123);
      ctx.subject.setLiveKitServerHost("chat.example:8443");
      await expect(
        ctx.subject.resolveLiveKitUrl("/livekit/rtc", "wss://chat.example:7880"),
      ).resolves.toBe("ws://127.0.0.1:40123/tun/livekit/rtc");
    });

    check("returns the direct URL unchanged for a local server", async () => {
      ctx.native.succeedWith(40123);
      ctx.subject.setLiveKitServerHost("localhost:8443");
      await expect(
        ctx.subject.resolveLiveKitUrl("/livekit/rtc", "ws://localhost:7880"),
      ).resolves.toBe("ws://localhost:7880");
    });

    // connect-src admits only loopback ws:/http:, so a local server whose
    // LiveKit is elsewhere (Cloud, a TLS host) must tunnel, not go direct.
    for (const directUrl of [
      "wss://project.livekit.cloud",
      "ws://sfu.example:7880",
      "wss://localhost:7880",
    ]) {
      check(`tunnels a local server whose direct URL is ${directUrl}`, async () => {
        ctx.native.succeedWith(40123);
        ctx.subject.setLiveKitServerHost("localhost:8443");
        await expect(ctx.subject.resolveLiveKitUrl("/livekit/rtc", directUrl)).resolves.toBe(
          "ws://127.0.0.1:40123/tun/livekit/rtc",
        );
      });
    }

    check(
      "refuses an address that is not the server's proxy path, with no server host",
      async () => {
        ctx.native.succeedWith(40123);
        await expect(ctx.subject.resolveLiveKitUrl("wss://sfu.example/rtc")).rejects.toMatchObject(
          REFUSED,
        );
      },
    );

    check("refuses an absolute address from a remote server", async () => {
      ctx.native.succeedWith(40123);
      ctx.subject.setLiveKitServerHost("chat.example:8443");
      await expect(
        ctx.subject.resolveLiveKitUrl("wss://other.example/x", "wss://chat.example:7880"),
      ).rejects.toMatchObject(REFUSED);
    });

    check("refuses an address that is not loopback from a local server", async () => {
      ctx.native.succeedWith(40123);
      ctx.subject.setLiveKitServerHost("localhost:8443");
      await expect(ctx.subject.resolveLiveKitUrl("wss://other.example/x")).rejects.toMatchObject(
        REFUSED,
      );
    });

    check("accepts a loopback direct address as the URL itself from a local server", async () => {
      ctx.native.succeedWith(40123);
      ctx.subject.setLiveKitServerHost("localhost:8443");
      await expect(ctx.subject.resolveLiveKitUrl("ws://127.0.0.1:7880")).resolves.toBe(
        "ws://127.0.0.1:7880",
      );
    });

    check("stops tunneling once the server host is cleared", async () => {
      ctx.native.succeedWith(40123);
      ctx.subject.setLiveKitServerHost("chat.example");
      ctx.subject.setLiveKitServerHost(null);
      await expect(ctx.subject.resolveLiveKitUrl("/livekit/rtc")).resolves.toBe("/livekit/rtc");
    });

    check("rejects when the native tunnel fails to start", async () => {
      ctx.native.failWith(new Error("bind failed"));
      ctx.subject.setLiveKitServerHost("chat.example");
      await expect(ctx.subject.resolveLiveKitUrl("/livekit/rtc")).rejects.toThrow("bind failed");
    });
  });
}
