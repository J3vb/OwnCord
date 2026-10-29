// Every yes/no confirm dialog is built by createConfirmModal in
// features/dialogs/confirmModal.ts, which owns the behaviour they share: Cancel focused on
// open, Escape and the backdrop cancel, the action runs at most once, and its
// listeners die with the dialog. A source file that writes both a
// "btn-modal-cancel" and a "btn-danger" class literal is a hand-built confirm,
// so this test fails on a new one. The allowlist is shrink-only: an entry that
// no longer matches must be removed, and a new entry needs a reason it is not
// a yes/no confirm. It only sees destructive (btn-danger) confirms: a
// primary-tone hand build is left to review.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.resolve(__dirname, "..");

const HELPER = "features/dialogs/confirmModal.ts";

const ALLOWLIST: Readonly<Record<string, string>> = {
  "features/moderation/BanDialog.ts":
    "a form (reason, ban length, message history), not a yes/no question",
};

const CANCEL = /"btn-modal-cancel"/;
const DANGER = /"btn-danger"/;
const isHandBuilt = (source: string): boolean => CANCEL.test(source) && DANGER.test(source);

const sourceFiles = readdirSync(srcDir, { recursive: true, encoding: "utf8" })
  .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
  .map((entry) => entry.split(path.sep).join("/"));

const matching = sourceFiles.filter((file) =>
  isHandBuilt(readFileSync(path.join(srcDir, file), "utf8")),
);

describe("the confirm dialog door", () => {
  it("recognises a hand-built confirm", () => {
    const handBuilt = `createElement("button", { class: "btn-modal-cancel" }); createElement("button", { class: "btn-danger" });`;
    expect(isHandBuilt(handBuilt)).toBe(true);
    expect(isHandBuilt(`createElement("button", { class: "btn-modal-cancel" });`)).toBe(false);
    expect(isHandBuilt(`createElement("button", { class: "btn-danger" });`)).toBe(false);
  });

  it("finds the shared helper itself", () => {
    expect(matching).toContain(HELPER);
  });

  it("no file outside the allowlist hand-builds a confirm", () => {
    const offenders = matching.filter((file) => file !== HELPER && !(file in ALLOWLIST));
    expect(offenders, "use createConfirmModal from features/dialogs/confirmModal.ts").toEqual([]);
  });

  it("every allowlist entry still matches (the list only shrinks)", () => {
    for (const file of Object.keys(ALLOWLIST)) {
      expect(matching, file).toContain(file);
    }
  });
});
