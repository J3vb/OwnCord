// Behaviour suite for the LiveKit half of the `NativeProxies` contract
// (`src/platform/contracts/nativeProxies.ts`): `setLiveKitServerHost`,
// `resolveLiveKitUrl`, `stopLiveKitProxy`. Written in B7-5 against the
// in-place seam (`LiveKitUrlResolver`, `lib/livekitUrlResolver.ts`) before
// the move, so it pins today's behaviour rather than the moved code's.
//
// No test for `stopLiveKitProxy` on its own: it is fire-and-forget and hands
// the caller nothing back, so "it does not throw" is exactly what a subject
// that does nothing also does. `resolveLiveKitUrl` re-starts the tunnel on
// every call by design, so there is no "restarts after stop" effect to pin
// either.
import { beforeEach, describe, expect, test } from "vitest";
import type { NativeProxies } from "../../../src/platform/contracts/nativeProxies";

export interface NativeControl {
  /** The native tunnel starts, listening on `port`. */
  succeedWith(port: number): void;
  failWith(error: unknown): void;
}

export type LiveKitProxiesSeam = Pick<
  NativeProxies,
  "setLiveKitServerHost" | "resolveLiveKitUrl" | "stopLiveKitProxy"
>;

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
      ).resolves.toBe("ws://127.0.0.1:40123/livekit/rtc");
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
          "ws://127.0.0.1:40123/livekit/rtc",
        );
      });
    }

    check("passes an absolute URL through when no server host is set", async () => {
      ctx.native.succeedWith(40123);
      await expect(ctx.subject.resolveLiveKitUrl("wss://sfu.example/rtc")).resolves.toBe(
        "wss://sfu.example/rtc",
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
