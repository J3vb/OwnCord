// In-app dialogs share one button pair: .btn-modal-save and .btn-modal-cancel
// (styles/login.css). The connect page's large .btn-primary (and the unstyled
// .btn-secondary) made a dialog built on createModal look like a different
// app from Create Channel next to it. This test fails when a file that opens a
// createModal dialog uses either class again. The connect page keeps its own
// look, and the allowlist is shrink-only.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(__dirname, "..");

const ALLOWLIST: Readonly<Record<string, string>> = {};

const OPENS_DIALOG = /\bcreateModal\(/;
const LOGIN_BUTTON = /["'\s]btn-(?:primary|secondary)\b/;

const dialogFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
  .map((entry) => entry.split(path.sep).join("/"))
  .filter((file) => !file.startsWith("pages/connect-page/"))
  .filter((file) => OPENS_DIALOG.test(readFileSync(path.join(srcDir, file), "utf8")));

const offending = dialogFiles.filter((file) =>
  LOGIN_BUTTON.test(readFileSync(path.join(srcDir, file), "utf8")),
);

describe("the dialog buttons door", () => {
  it("recognises the login button classes", () => {
    expect(LOGIN_BUTTON.test('{ class: "btn btn-primary" }')).toBe(true);
    expect(LOGIN_BUTTON.test('{ class: "btn-secondary" }')).toBe(true);
    expect(LOGIN_BUTTON.test('{ class: "btn-modal-save" }')).toBe(false);
    expect(LOGIN_BUTTON.test('{ class: "ac-btn secondary" }')).toBe(false);
  });

  it("finds the dialogs", () => {
    expect(dialogFiles).toContain("lib/ui/modalFactory.ts");
    expect(dialogFiles).toContain("components/ServerRailJoinModal.ts");
  });

  it("no dialog outside the connect page uses the login buttons", () => {
    const offenders = offending.filter((file) => !(file in ALLOWLIST));
    expect(offenders, "use .btn-modal-save / .btn-modal-cancel in dialogs").toEqual([]);
  });

  it("every allowlist entry still matches (the list only shrinks)", () => {
    for (const file of Object.keys(ALLOWLIST)) expect(offending, file).toContain(file);
  });
});
