// Behaviour suite for the `ExternalContentBroker` contract
// (`src/platform/contracts/externalContent.ts`), run against
// `platform/desktop` in `externalContent.desktop.test.ts`.
//
// Asserts only what the CALLER receives: the typed minimum, the image bytes,
// and the failure class that replaces them. No command name, no argument
// shape — the one thing pinned about the request is that the partition and
// the target the caller named are the ones the native broker is asked for.
import { beforeEach, describe, expect, test } from "vitest";
import type {
  ExternalContentBroker,
  ExternalContentFailure,
  ExternalImageHandle,
  ExternalPreview,
} from "../../../src/platform/contracts/externalContent";

export interface NativeControl {
  /** The native broker answers every request with this value. */
  answers(value: unknown): void;
  /** The native broker refuses with this error. */
  refuses(error: unknown): void;
  /** There is no native host. */
  unavailable(): void;
  /** What the native broker was asked for, in call order: the partition and
   *  the URL or handle. */
  asked(): readonly { readonly partition: string; readonly target: string }[];
}

export interface ExternalContentSubject {
  readonly subject: ExternalContentBroker;
  readonly native: NativeControl;
}

const partition = "chat.example.com#0";
const pageUrl = "https://news.example.com/post";
const handle = "h1" as ExternalImageHandle;
const preview: ExternalPreview = {
  title: "A title",
  description: "A description",
  siteName: "News",
  image: handle,
  imageWidth: 1200,
  imageHeight: 630,
};
const failures: readonly ExternalContentFailure[] = [
  "blocked-destination",
  "too-many-redirects",
  "oversized",
  "wrong-type",
  "unavailable",
];

export function describeExternalContentSuite(
  makeSubject: () => Promise<ExternalContentSubject>,
  options?: { expectEveryTestToFail?: boolean },
): void {
  const check = options?.expectEveryTestToFail ? test.fails : test;
  describe("ExternalContentBroker", () => {
    let ctx: ExternalContentSubject;
    beforeEach(async () => {
      ctx = await makeSubject();
    });

    describe("preview", () => {
      check("resolves the typed minimum the native broker returned", async () => {
        ctx.native.answers(preview);
        await expect(ctx.subject.preview(partition, pageUrl)).resolves.toEqual({
          ok: true,
          value: preview,
        });
      });

      check("asks the native broker for the partition and URL it was given", async () => {
        ctx.native.answers(preview);
        await ctx.subject.preview(partition, pageUrl);
        expect(ctx.native.asked()).toEqual([{ partition, target: pageUrl }]);
      });

      for (const failure of failures) {
        check(`resolves a ${failure} refusal as that failure class`, async () => {
          ctx.native.refuses(failure);
          await expect(ctx.subject.preview(partition, pageUrl)).resolves.toEqual({
            ok: false,
            failure,
          });
        });
      }

      check("resolves an unrecognised native error as unavailable, not a throw", async () => {
        ctx.native.refuses(new Error("boom"));
        await expect(ctx.subject.preview(partition, pageUrl)).resolves.toEqual({
          ok: false,
          failure: "unavailable",
        });
      });

      check("resolves no native host as unavailable, not a throw", async () => {
        ctx.native.unavailable();
        await expect(ctx.subject.preview(partition, pageUrl)).resolves.toEqual({
          ok: false,
          failure: "unavailable",
        });
      });
    });

    describe("image", () => {
      check("resolves the bytes the native broker returned as a Blob", async () => {
        ctx.native.answers(new Uint8Array([71, 73, 70, 56]).buffer);
        const result = await ctx.subject.image(partition, { handle });
        expect(result.ok).toBe(true);
        const blob = result.ok ? result.value : null;
        expect(blob).toBeInstanceOf(Blob);
        expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([71, 73, 70, 56]));
      });

      check("asks for a handle or a URL, whichever the caller holds", async () => {
        ctx.native.answers(new Uint8Array([1]).buffer);
        await ctx.subject.image(partition, { handle });
        await ctx.subject.image(partition, { url: "https://img.example.com/a.png" });
        expect(ctx.native.asked()).toEqual([
          { partition, target: handle },
          { partition, target: "https://img.example.com/a.png" },
        ]);
      });

      check("resolves a refusal as its failure class", async () => {
        ctx.native.refuses("oversized");
        await expect(ctx.subject.image(partition, { handle })).resolves.toEqual({
          ok: false,
          failure: "oversized",
        });
      });

      check("resolves no native host as unavailable, not a throw", async () => {
        ctx.native.unavailable();
        await expect(
          ctx.subject.image(partition, { url: "https://img.example.com/a.png" }),
        ).resolves.toEqual({ ok: false, failure: "unavailable" });
      });
    });
  });
}
