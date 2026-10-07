// The jump-to-bottom count badge must follow the app text scale like the other
// unread badges, so its size comes from a --font-size-* token. jsdom never
// applies app.css, so this asserts the parsed stylesheet (tests/helpers/app-css.ts).
import { cascadedDeclaration, varToken } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe(".scroll-to-bottom-count", () => {
  it("sizes its text from the scalable type token", () => {
    expect(varToken(cascadedDeclaration(".scroll-to-bottom-count", "font-size"))).toBe(
      "--font-size-xxs",
    );
  });
});
