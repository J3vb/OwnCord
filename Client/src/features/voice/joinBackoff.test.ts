import { describe, it, expect, beforeEach } from "vitest";
import { joinRetryInMs, noteJoinFailed, noteJoinSucceeded } from "./joinBackoff";
import { joinBackoffText } from "./joinBackoffText";

beforeEach(() => noteJoinSucceeded());

describe("joinBackoff", () => {
  it("lets the first join through", () => {
    expect(joinRetryInMs(1_000)).toBe(0);
  });

  it("backs off 2 s after a failed join, doubling per consecutive failure up to 30 s", () => {
    const waits = [1, 2, 3, 4, 5, 6].map(() => {
      noteJoinFailed(0);
      return joinRetryInMs(0);
    });
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it("counts the wait down and frees the join once it has passed", () => {
    noteJoinFailed(10_000);
    expect(joinRetryInMs(11_500)).toBe(500);
    expect(joinRetryInMs(12_000)).toBe(0);
  });

  it("forgets earlier failures once a join succeeds", () => {
    noteJoinFailed(0);
    noteJoinFailed(0);
    noteJoinSucceeded();
    expect(joinRetryInMs(0)).toBe(0);
    noteJoinFailed(0);
    expect(joinRetryInMs(0)).toBe(2_000);
  });

  it("words the refusal by what armed the wait", () => {
    expect(joinBackoffText(0)).toBeNull();
    noteJoinFailed(0);
    expect(joinBackoffText(0)).toBe("Voice join failed — try again in 2 s");
    noteJoinFailed(0, true);
    expect(joinBackoffText(0)).toBe("Please wait 4 s before switching voice channels");
    noteJoinFailed(0);
    expect(joinBackoffText(0)).toBe("Voice join failed — try again in 8 s");
    expect(joinBackoffText(8_000)).toBeNull();
  });
});
