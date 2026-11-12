import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as mod from "../../../../src/features/messaging/toneSheets";
import { TWEMOJI_BASE } from "../../../../src/features/messaging/content/emojiImage";
import {
  EMOJI_SHEETS,
  SHEETS_CATALOG_HASH,
} from "../../../../src/features/messaging/emojiSheetsData";

// The module keeps its sheets for the page's life, so each test uses its own group key.

function fakeCache(stored: Map<string, Blob>): Cache {
  return {
    match: vi.fn((url: string) =>
      Promise.resolve(stored.has(url) ? new Response(stored.get(url)) : undefined),
    ),
    put: vi.fn((url: string, res: Response) => res.blob().then((b) => void stored.set(url, b))),
    keys: vi.fn(() => Promise.resolve([...stored.keys()].map((u) => new Request(u)))),
    delete: vi.fn((req: Request) => Promise.resolve(stored.delete(req.url))),
  } as unknown as Cache;
}

const base = [{ tone: "" }, { tone: "0" }];
const toned = ["👋🏽", "😀"];

describe("skin-tone sheets", () => {
  let stored: Map<string, Blob>;
  let urls = 0;

  beforeEach(() => {
    stored = new Map();
    vi.stubGlobal("caches", { open: vi.fn(() => Promise.resolve(fakeCache(stored))) });
    URL.createObjectURL = vi.fn(() => `blob:sheet-${++urls}`);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("use the shipped sheet with no tone, or for a group nothing in which takes one", () => {
    expect(mod.groupSheetUrl("people", 0, base, toned)).toBe(EMOJI_SHEETS["people"]);
    expect(mod.groupSheetUrl("food", 3, [{ tone: "" }], ["🍕"])).toBe(EMOJI_SHEETS["food"]);
  });

  it("serve a cached tone sheet once it is read back, and start only one load", async () => {
    const key = new URL(`${TWEMOJI_BASE}tone-sheets/${SHEETS_CATALOG_HASH}/people-3`, location.href)
      .href;
    stored.set(key, new Blob(["webp"], { type: "image/webp" }));
    const open = vi.mocked(caches.open);
    expect(mod.groupSheetUrl("people", 3, base, toned)).toBeNull();
    expect(mod.groupSheetUrl("people", 3, base, toned)).toBeNull();
    await vi.waitFor(() => expect(mod.toneSheetUrl("people-3", toned)).toMatch(/^blob:sheet-/));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("stay on single images when the sheet cannot be drawn, and try again later", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(mod.toneSheetUrl("people-2", toned)).toBeNull();
    await vi.waitFor(() => expect(vi.mocked(caches.open)).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => {
      expect(mod.toneSheetUrl("people-2", toned)).toBeNull();
      expect(vi.mocked(caches.open)).toHaveBeenCalledTimes(2);
    });
  });

  it("drop sheets of other versions when storing a new one", async () => {
    stored.set("http://localhost/assets/twemoji/0.0.1/tone-sheets/old/people-1", new Blob(["x"]));
    const ctx = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx as never);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((cb) =>
      cb(new Blob(["webp"], { type: "image/webp" })),
    );
    expect(await mod.drawSheet([])).not.toBeNull();
    expect(mod.toneSheetUrl("smileys-1", [])).toBeNull();
    await vi.waitFor(() => expect(mod.toneSheetUrl("smileys-1", [])).toMatch(/^blob:sheet-/));
    expect([...stored.keys()].some((k) => k.includes("/0.0.1/"))).toBe(false);
  });
});
