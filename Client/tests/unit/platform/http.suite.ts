// Behaviour suite for the `HttpClient` contract
// (`src/platform/contracts/http.ts`). Run now against the legacy binding
// (`http.legacy.test.ts`, today's plugin `fetch` the REST callers use) and
// again in B7-4 against `platform/desktop` — a green run before and after
// that move is the evidence the move changed nothing.
//
// Asserts only what the CALLER receives: no command name, no options shape.
// What a caller of this seam can observe is the `Response` it gets back (and
// the error it gets instead), so that is all this suite pins.
import { beforeEach, describe, expect, test } from "vitest";
import type { HttpClient } from "../../../src/platform/contracts/http";

/** A small control handle the legacy/desktop binding supplies so the suite
 *  never has to know how "the native transport resolves/rejects/is
 *  unavailable" is actually wired for that binding. */
export interface NativeControl {
  /** The native transport answers with this response. */
  respondsWith(response: Response): void;
  /** The native transport rejects with this error. */
  failsWith(error: unknown): void;
  /** The URLs the native transport has been asked for, in call order. */
  requested(): readonly string[];
}

export interface HttpSubject {
  readonly subject: HttpClient;
  readonly native: NativeControl;
}

const url = "http://127.0.0.1:51820/api/v1/health";

export function describeHttpClientSuite(
  makeSubject: () => Promise<HttpSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("HttpClient", () => {
    let ctx: HttpSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    check("resolves the response the native transport returned", async () => {
      const response = new Response('{"ok":true}', { status: 200 });
      ctx.native.respondsWith(response);
      await expect(ctx.subject.fetch(url)).resolves.toBe(response);
    });

    check("resolves a response the caller can read as text", async () => {
      ctx.native.respondsWith(new Response("hello", { status: 200 }));
      const response = await ctx.subject.fetch(url);
      await expect(response.text()).resolves.toBe("hello");
    });

    check("resolves the status of a failed request rather than throwing", async () => {
      ctx.native.respondsWith(new Response("nope", { status: 401 }));
      const response = await ctx.subject.fetch(url);
      expect(response.status).toBe(401);
    });

    check("reaches the native transport with the URL it was given", async () => {
      ctx.native.respondsWith(new Response(null, { status: 200 }));
      await ctx.subject.fetch(url);
      expect(ctx.native.requested()).toEqual([url]);
    });

    // Pinned as-is (B7-4): a transport-level failure (a rejected certificate,
    // a dead proxy) propagates unchanged — the callers above this seam decide
    // what it means.
    check("propagates a rejection from the native transport", async () => {
      const failure = new Error("certificate fingerprint mismatch");
      ctx.native.failsWith(failure);
      await expect(ctx.subject.fetch(url)).rejects.toBe(failure);
    });
  });
}
