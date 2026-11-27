import { describe, expect, it } from "vitest";
import { serverAvatar } from "../../../src/features/server-rail/serverRailParts";

describe("serverAvatar initials colour", () => {
  it("uses the accent's text colour on the accent fallback fill", () => {
    const el = serverAvatar("Test Server", "var(--accent)", false, undefined);
    expect(el.style.color).toBe("var(--on-accent)");
  });

  it("leaves a saved colour's initials to the stylesheet's white", () => {
    const el = serverAvatar("Test Server", "#3ba55d", false, undefined);
    expect(el.style.color).toBe("");
  });
});
