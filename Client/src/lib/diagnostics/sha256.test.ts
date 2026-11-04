import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

describe("sha256Hex", () => {
  it("matches node:crypto at and around the block edges", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 70_000]) {
      const data = Uint8Array.from({ length }, (_, i) => (i * 7919 + 13) & 0xff);
      expect(sha256Hex(data), `length ${length}`).toBe(
        createHash("sha256").update(data).digest("hex"),
      );
    }
  });
});
