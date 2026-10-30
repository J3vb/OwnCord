import { describe, expect, it } from "vitest";
import { beginJoinAttempt, finishJoinAttempt, voiceJoinSnapshot } from "@lib/voice/voiceJoinTrace";

// A file of its own: the record starts empty here, so the first attempts show
// how it grows before it reaches its cap.
describe("recorded join attempts from an empty record", () => {
  it("grows one attempt at a time up to five and then stops growing", () => {
    expect(voiceJoinSnapshot().lastJoins).toHaveLength(0);
    for (let i = 0; i < 7; i++) {
      finishJoinAttempt(beginJoinAttempt(200 + i));
      const after = voiceJoinSnapshot().lastJoins;
      expect(after).toHaveLength(Math.min(i + 1, 5));
      expect(after.every((attempt) => attempt !== undefined)).toBe(true);
      expect(after[0]?.channelId).toBe(200 + i);
    }
  });
});
