import { expect, it, vi } from "vitest";
import { twemojiSvg } from "../../../../src/features/messaging/content/emojiImage";
import { stubTwemoji } from "../../../helpers/twemojiStub";

// Its own file: the pack loader's caches start empty here.
it("reads the index once and each pack once, and retries a failed load", async () => {
  const restore = stubTwemoji({ "1f600": "<svg/>" });
  const fetchMock = vi.mocked(fetch);
  fetchMock.mockImplementationOnce(() => Promise.resolve(new Response(null, { status: 500 })));
  expect(await twemojiSvg("1f600")).toBeNull();
  expect(await twemojiSvg("1f600")).toBe("<svg/>");
  expect(await twemojiSvg("1f601")).toBeNull();
  expect(fetchMock.mock.calls.map(([u]) => String(u).split("/").pop())).toEqual([
    "index.json",
    "index.json",
    "pack-0.json",
  ]);
  restore();
});
