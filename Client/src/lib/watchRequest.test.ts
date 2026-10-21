import { describe, it, expect, beforeEach } from "vitest";
import { noteWatchSent, takeWatchRefusal, resetWatchRequest } from "./watchRequest";

describe("watchRequest", () => {
  beforeEach(resetWatchRequest);

  it("consumes the id of a voice_watch it sent", () => {
    noteWatchSent("a");
    expect(takeWatchRefusal("a")).toBe(true);
    expect(takeWatchRefusal("a")).toBe(false);
  });

  it("does not claim an unknown or missing id", () => {
    noteWatchSent("a");
    expect(takeWatchRefusal("b")).toBe(false);
    expect(takeWatchRefusal(undefined)).toBe(false);
    noteWatchSent(undefined);
    expect(takeWatchRefusal("a")).toBe(true);
  });

  it("keeps only the most recent ids", () => {
    for (let i = 0; i < 20; i++) noteWatchSent(`id${String(i)}`);
    expect(takeWatchRefusal("id0")).toBe(false);
    expect(takeWatchRefusal("id19")).toBe(true);
  });
});
