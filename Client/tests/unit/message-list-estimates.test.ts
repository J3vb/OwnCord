import { beforeEach, describe, expect, it } from "vitest";

import { estimateItemHeight, type VirtualItem } from "@components/MessageList";
import { clearImageSizes, setImageBox } from "../../src/features/messaging/content/imageSizes";
import type { Message } from "@stores/messages.store";
import "../helpers/resizeObserverStub";

const LINE = 22;
/** 900 px list, 120 px of row padding, 7.5 px glyphs: 104 characters a line. */
const PER_LINE = 104;

function item(
  content: string,
  opts: { grouped?: boolean; attachments?: unknown[] } = {},
): VirtualItem {
  return {
    kind: "message",
    isGrouped: opts.grouped ?? false,
    message: { id: 1, content, attachments: opts.attachments ?? [] } as unknown as Message,
  };
}

function attachment(extra: Record<string, unknown> = {}): unknown {
  return {
    id: "a",
    filename: "p.png",
    mime: "image/png",
    size: 1,
    url: "https://img.test/files/p.png",
    ...extra,
  };
}

describe("estimateItemHeight", () => {
  beforeEach(() => {
    clearImageSizes();
  });

  it("keeps the one-line baselines", () => {
    expect(estimateItemHeight(item("hi"))).toBe(61);
    expect(estimateItemHeight(item("hi", { grouped: true }))).toBe(22);
    expect(estimateItemHeight({ kind: "divider", timestamp: "t" })).toBe(32);
  });

  it("adds a line height for every line the text wraps to", () => {
    expect(estimateItemHeight(item("x".repeat(PER_LINE)))).toBe(61);
    expect(estimateItemHeight(item("x".repeat(PER_LINE + 1)))).toBe(61 + LINE);
    expect(estimateItemHeight(item("a\n\nb"))).toBe(61 + 2 * LINE);
    expect(estimateItemHeight(item("x".repeat(PER_LINE * 5), { grouped: true }))).toBe(
      22 + 4 * LINE,
    );
  });

  it("wraps sooner in a narrower list", () => {
    const text = "x".repeat(100);
    expect(estimateItemHeight(item(text), 900)).toBe(61);
    expect(estimateItemHeight(item(text), 500)).toBe(61 + LINE);
    expect(estimateItemHeight(item(text), 300)).toBe(61 + 4 * LINE);
    expect(estimateItemHeight(item(text), 0)).toBeGreaterThan(61);
  });

  it("is within 25% of a row laid out with a fixed line height", () => {
    // What the browser does with this paragraph at the same glyph width:
    // fill each line with PER_LINE characters, then add the 17px margin above.
    const words = Array.from({ length: 120 }, (_, i) => `word${i % 10}`).join(" ");
    const lines = Math.ceil(words.length / PER_LINE) + 1; // word breaks cost one extra
    const laidOut = 17 + 18 + lines * LINE;
    const estimate = estimateItemHeight(item(words));
    expect(Math.abs(estimate - laidOut) / laidOut).toBeLessThan(0.25);
  });

  it("uses the 220px box for an image it has never seen", () => {
    expect(estimateItemHeight(item("https://img.test/cat.png"))).toBe(61 + 220);
    expect(estimateItemHeight(item("", { attachments: [attachment()] }))).toBe(61 + 220);
  });

  it("uses the cached scaled height for an inline image URL", () => {
    setImageBox("https://img.test/cat.png", { w: 400, h: 267 });
    expect(estimateItemHeight(item("https://img.test/cat.png"))).toBe(61 + 267 + 4);
  });

  it("ignores image URLs the renderer does not embed", () => {
    expect(estimateItemHeight(item("```\nhttps://img.test/a.png\n```"))).toBe(
      61 + 2 * LINE, // three source lines of text, no image box
    );
    expect(estimateItemHeight(item("`https://img.test/a.png`"))).toBe(61);
    expect(estimateItemHeight(item("[pic](https://img.test/a.png)"))).toBe(61);
    expect(estimateItemHeight(item("<https://img.test/a.png>"))).toBe(61);
    expect(estimateItemHeight(item("||https://img.test/a.png||"))).toBe(61);
  });

  it("shrinks a cached inline box to a narrow row, keeping its ratio", () => {
    setImageBox("https://img.test/wide.png", { w: 400, h: 200 });
    // 300 px list: 180 px of row after padding, so 0.45 of the box.
    expect(estimateItemHeight(item("https://img.test/wide.png"), 300)).toBe(
      61 + LINE + 90 + 4, // the 25-character URL wraps to two lines at 24 a line
    );
    // A wide row never enlarges it.
    expect(estimateItemHeight(item("https://img.test/wide.png"), 2000)).toBe(61 + 200 + 4);
  });

  it("caps a server attachment's box at 300 px tall", () => {
    const tall = attachment({ width: 1000, height: 1000 });
    expect(estimateItemHeight(item("", { attachments: [tall] }))).toBe(61 + 300 + 4);
  });

  it("sums one box per image URL in the message", () => {
    setImageBox("https://img.test/a.png", { w: 400, h: 100 });
    expect(estimateItemHeight(item("https://img.test/a.png\nhttps://img.test/b.gif"))).toBe(
      61 + LINE + (100 + 4) + 220,
    );
  });

  it("uses an attachment's server dimensions, scaled under the ceiling", () => {
    const att = attachment({ width: 1200, height: 800 });
    expect(estimateItemHeight(item("", { attachments: [att] }))).toBe(61 + 267 + 4);
  });

  it("uses the size remembered for an attachment without dimensions", () => {
    setImageBox("https://img.test/files/p.png", { w: 300, h: 150 });
    expect(estimateItemHeight(item("", { attachments: [attachment()] }))).toBe(61 + 150 + 4);
  });

  it("estimates two or more image attachments as the mosaic, not the sum of their tiles", () => {
    const tile = (n: number) =>
      attachment({ id: `a${n}`, url: `https://img.test/f${n}.png`, width: 1200, height: 800 });
    const grid = (n: number) =>
      estimateItemHeight(item("", { attachments: Array.from({ length: n }, (_, i) => tile(i)) }));
    expect(grid(2)).toBe(61 + 200 + 4); // one 200px row
    expect(grid(3)).toBe(61 + 2 * 140 + 4 + 4); // two 140px rows, 4px gap
    expect(grid(4)).toBe(grid(3));
    expect(grid(6)).toBe(61 + 2 * 140 + 4 + 4);
    expect(grid(5)).toBe(61 + 2 * 140 + 4 + 4);
    expect(grid(7)).toBe(61 + 3 * 140 + 2 * 4 + 4);
    expect(grid(9)).toBe(61 + 3 * 140 + 2 * 4 + 4);
    // A lone image is still its own box.
    expect(grid(1)).toBe(61 + 267 + 4);
  });

  it("adds a file chip or audio row beside the mosaic", () => {
    const tile = (n: number) => attachment({ id: `a${n}`, url: `https://img.test/g${n}.png` });
    const audio = attachment({ id: "au", mime: "audio/mpeg", url: "https://img.test/s.mp3" });
    expect(estimateItemHeight(item("", { attachments: [tile(0), tile(1), audio] }))).toBe(
      61 + 200 + 4 + 96,
    );
  });

  it("counts a repeated inline image URL once", () => {
    setImageBox("https://img.test/a.png", { w: 400, h: 100 });
    expect(estimateItemHeight(item("https://img.test/a.png\nhttps://img.test/a.png"))).toBe(
      61 + LINE + (100 + 4),
    );
  });

  it("still reserves the YouTube and audio rows", () => {
    expect(estimateItemHeight(item("https://youtu.be/abc"))).toBe(61 + 320);
    expect(
      estimateItemHeight(item("", { attachments: [attachment({ mime: "audio/mpeg" })] })),
    ).toBe(61 + 96);
  });
});
