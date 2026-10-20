import { beforeEach, describe, expect, it } from "vitest";

// jsdom does not provide ResizeObserver; importing MessageList does not need it
// at load, but a sibling import may.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
}

import { estimateItemHeight, type VirtualItem } from "@components/MessageList";
import { clearImageSizes, setImageBox } from "../../src/components/message-list/image-sizes";
import type { Message } from "@stores/messages.store";

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

  it("still reserves the YouTube and audio rows", () => {
    expect(estimateItemHeight(item("https://youtu.be/abc"))).toBe(61 + 320);
    expect(
      estimateItemHeight(item("", { attachments: [attachment({ mime: "audio/mpeg" })] })),
    ).toBe(61 + 96);
  });
});
