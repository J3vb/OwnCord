// Settings UX clarity pass: the stylesheet rules behind the button hierarchy.
// jsdom never applies app.css, so these assert the parsed rules
// (tests/helpers/app-css.ts); settings-tabs-extra.spec.ts measures the contrast.
import { describe, it, expect } from "vitest";
import { cascadedDeclaration, varToken } from "../helpers/app-css";

describe("settings button hierarchy", () => {
  it("gives .ac-btn.secondary a neutral fill with normal text, not the accent", () => {
    expect(varToken(cascadedDeclaration(".ac-btn.secondary", "background"))).toBe("--bg-active");
    expect(varToken(cascadedDeclaration(".ac-btn.secondary", "color"))).toBe("--text-normal");
  });

  it("marks a resting destructive action with danger text, and fills it once armed", () => {
    expect(varToken(cascadedDeclaration(".ac-btn.destructive", "color"))).toBe("--text-danger");
    expect(varToken(cascadedDeclaration(".ac-btn.ac-btn-danger", "background"))).toBe(
      "--danger-fill",
    );
    expect(varToken(cascadedDeclaration(".ac-btn.ac-btn-danger", "color"))).toBe("--on-fill");
    expect(varToken(cascadedDeclaration(".ac-btn.ac-btn-danger:hover", "background"))).toBe(
      "--danger-fill-hover",
    );
  });
});

describe("settings status icons", () => {
  it.each([
    [".st-ic.st-ok", "--text-positive"],
    [".st-ic.st-warn", "--text-warning"],
    [".st-ic.st-crit", "--text-danger"],
    [".st-ic.st-pending", "--text-muted"],
  ])("colours %s with the qualified text token %s", (selector, token) => {
    expect(varToken(cascadedDeclaration(selector, "color"))).toBe(token);
  });

  it("titles a settings card in a contrast-qualified colour, not --text-faint", () => {
    expect(varToken(cascadedDeclaration(".settings-card-head h3", "color"))).toBe(
      "--header-primary",
    );
  });
});

describe("settings pane section headings", () => {
  it.each([".settings-content h3.setting-group-title", ".settings-content h3.safety-heading"])(
    "colours %s with the qualified --text-muted, not the generic --text-faint",
    (selector) => {
      expect(varToken(cascadedDeclaration(selector, "color"))).toBe("--text-muted");
    },
  );
});
