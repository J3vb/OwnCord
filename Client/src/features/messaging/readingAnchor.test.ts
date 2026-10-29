import { describe, it, expect, afterEach, vi } from "vitest";
import { readingAnchor, registerReadingAnchor } from "./readingAnchor";

const unregisters: Array<() => void> = [];

function register(fn: (channelId: number) => number | null): () => void {
  const off = registerReadingAnchor(fn);
  unregisters.push(off);
  return off;
}

afterEach(() => {
  for (const off of unregisters.splice(0)) off();
});

describe("readingAnchor", () => {
  it("is null while no list is mounted", () => {
    expect(readingAnchor(1)).toBeNull();
  });

  it("asks the registered lookup about the given channel", () => {
    const lookup = vi.fn((channelId: number) => channelId * 10);
    register(lookup);
    expect(readingAnchor(7)).toBe(70);
    expect(lookup).toHaveBeenCalledExactlyOnceWith(7);
  });

  it("is null when the lookup finds no visible message", () => {
    register(() => null);
    expect(readingAnchor(1)).toBeNull();
  });

  it("keeps an anchor of 0 rather than treating it as absent", () => {
    register(() => 0);
    expect(readingAnchor(1)).toBe(0);
  });

  it("is null again once the list unregisters", () => {
    const off = register(() => 5);
    off();
    expect(readingAnchor(1)).toBeNull();
  });

  it("keeps a newer list's lookup when the older list unregisters late", () => {
    const offOld = register(() => 1);
    register(() => 2);
    offOld();
    expect(readingAnchor(1)).toBe(2);
  });

  it("answers from the newest list while two are registered", () => {
    register(() => 1);
    register(() => 2);
    expect(readingAnchor(1)).toBe(2);
  });
});
