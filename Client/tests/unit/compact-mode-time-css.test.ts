// Compact mode keeps the time on a message's header line, before the name.
// jsdom never applies app.css, so this asserts the parsed stylesheet
// (tests/helpers/app-css.ts).
import { cascadedDeclaration, keyword } from "../helpers/app-css";
import { describe, it, expect } from "vitest";

describe("compact mode header time CSS", () => {
  it("shows the time on a header line", () => {
    // Lightning CSS types `inline` as a structured value, so only the
    // keyword form (none) reads back through keyword().
    const decl = cascadedDeclaration(".compact-mode .message .msg-time", "display");
    expect(decl).toBeDefined();
    expect(keyword(decl)).not.toBe("none");
  });

  it("puts the time ahead of the name", () => {
    expect(keyword(cascadedDeclaration(".compact-mode .message .msg-time", "order"))).toBe("-1");
  });

  it("still hides the header on grouped lines", () => {
    expect(
      keyword(cascadedDeclaration(".compact-mode .message.grouped .msg-header", "display")),
    ).toBe("none");
  });
});
