// Compact mode shows the short clock time (.msg-compact-time) ahead of the
// author and hides the full header time; normal mode hides the short one.
// jsdom never applies app.css, so this asserts the parsed stylesheet
// (tests/helpers/app-css.ts).
import { cascadedDeclaration, keyword } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe("compact mode header time CSS", () => {
  it("hides the short time outside compact mode", () => {
    expect(keyword(cascadedDeclaration(".message .msg-compact-time", "display"))).toBe("none");
  });

  it("shows the short time in compact mode, muted and small", () => {
    const sel = ".compact-mode .message .msg-compact-time";
    const decl = cascadedDeclaration(sel, "display");
    expect(decl).toBeDefined();
    expect(keyword(decl)).not.toBe("none");
    expect(cascadedDeclaration(sel, "color")).toBeDefined();
    expect(cascadedDeclaration(sel, "font-size")).toBeDefined();
  });

  it("still hides the full header time in compact mode", () => {
    expect(keyword(cascadedDeclaration(".compact-mode .message .msg-time", "display"))).toBe(
      "none",
    );
  });

  it("still hides the header on grouped lines", () => {
    expect(
      keyword(cascadedDeclaration(".compact-mode .message.grouped .msg-header", "display")),
    ).toBe("none");
  });
});
