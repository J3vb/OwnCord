// DP-15: the typing strip keeps its 24 px row reserved whether or not anyone
// is typing, the way Discord reserves it, so starting/stopping typing no longer
// shifts the message list. jsdom never applies app.css, so this asserts the
// parsed stylesheet (tests/helpers/app-css.ts).
import { cascadedDeclaration, hasRule } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe("DP-15 typing bar keeps its height when empty", () => {
  it("reserves the 24px row on .typing-bar", () => {
    const height = cascadedDeclaration(".typing-bar", "height")?.value.value;
    expect(height).toMatchObject({
      type: "length-percentage",
      value: { value: { unit: "px", value: 24 } },
    });
  });

  it("does not collapse .typing-bar:empty to a smaller height", () => {
    expect(hasRule(".typing-bar:empty")).toBe(false);
  });
});
