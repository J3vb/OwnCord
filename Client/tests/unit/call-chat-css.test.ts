// The call view's chat column (WP 6.1b). jsdom never applies app.css, so these
// assert the parsed stylesheet (tests/helpers/app-css.ts).
import { describe, it, expect } from "vitest";
import { bundle } from "lightningcss";
import { join } from "node:path";
import type { Rule } from "lightningcss";
import { cascadedDeclaration, hasRule } from "../helpers/app-css";

describe("call chat CSS", () => {
  it("lays the chat area out as a grid while the chat is beside the call", () => {
    const display = cascadedDeclaration(".chat-area--call-chat", "display")?.value;
    expect(display?.property === "display" && display.value.type === "pair").toBe(true);
    expect(
      display?.property === "display" &&
        display.value.type === "pair" &&
        display.value.inside.type === "grid",
    ).toBe(true);
    expect(cascadedDeclaration(".chat-area--call-chat", "grid-template-columns")).toBeDefined();
  });

  it("places the header across the top and the slots in their columns", () => {
    for (const sel of [
      ".chat-area--call-chat > .chat-header",
      ".chat-area--call-chat > .video-grid-slot",
      ".chat-area--call-chat > .messages-slot",
      ".chat-area--call-chat > .typing-slot",
      ".chat-area--call-chat > .input-slot",
    ]) {
      expect(hasRule(sel), sel).toBe(true);
    }
  });

  it("stacks the grid over the chat at the narrow breakpoint", () => {
    let rules: Rule[] = [];
    bundle({
      filename: join(process.cwd(), "src/styles/app.css"),
      visitor: {
        StyleSheet(s) {
          rules = s.rules;
        },
      },
    });
    const narrow = rules.filter(
      (r) =>
        r.type === "media" &&
        r.value.rules.some(
          (inner) =>
            inner.type === "style" &&
            inner.value.selectors.some((sel) =>
              sel.some((c) => c.type === "class" && c.name === "chat-area--call-chat"),
            ),
        ),
    );
    expect(narrow.length).toBeGreaterThan(0);
  });
});
