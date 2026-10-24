// The call view's chat column (WP 6.1b). jsdom never applies app.css, so these
// assert the parsed stylesheet (tests/helpers/app-css.ts).
import { describe, it, expect } from "vitest";
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

  it("stacks the grid over the chat when the chat column is narrow", () => {
    expect(
      cascadedDeclaration(".chat-area--call-chat-stacked", "grid-template-columns"),
    ).toBeDefined();
    for (const slot of ["video-grid-slot", "messages-slot", "typing-slot", "input-slot"]) {
      const row = cascadedDeclaration(`.chat-area--call-chat-stacked > .${slot}`, "grid-row");
      expect(row, slot).toBeDefined();
    }
  });

  it("sizes the chat track from the resize handle's width property", () => {
    const cols = cascadedDeclaration(".chat-area--call-chat", "grid-template-columns");
    expect(JSON.stringify(cols)).toContain("call-chat-width");
    expect(hasRule(".chat-area--call-chat > .call-chat-resize")).toBe(true);
    expect(hasRule(".chat-area--call-chat-stacked > .call-chat-resize")).toBe(true);
  });
});
