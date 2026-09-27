// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can type-check
// this panel. See docs/contributing.md#testing for the membership rule.
//
// ARCH-10 stage 1: the admin panel (Server/admin/static/js) is checked with a
// non-strict checkJs program and a shrink-only baseline. This drives the
// ratchet's own logic so a broken comparator cannot silently pass every PR, and
// pins the property the check exists for: 0 TS2304 (undefined global).
import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compare,
  identity,
  loadBaseline,
  scanTree,
  shrink,
  type Baseline,
  type Scan,
} from "../../scripts/check-admin-types.mjs";

const SERVER_ROOT = path.resolve(__dirname, "../../../Server");

describe("admin panel type check", () => {
  const scan = scanTree();
  const baseline = loadBaseline();

  it("builds the checkJs program without a config error", () => {
    expect(scan.configErrors).toEqual([]);
    expect(scan.diagnostics.length).toBeGreaterThan(0);
  });

  it("has no new type error and no stale baseline entry", () => {
    const { added, stale } = compare(scan, baseline);
    expect(
      added.map((a) => `${a.file} ${a.identity} ×${a.actual} (baseline ${a.baseline})`),
      "fix the error, or run `node scripts/check-admin-types.mjs --update` only to shrink",
    ).toEqual([]);
    expect(
      stale.map((s) => `${s.file} ${s.identity} ×${s.baseline}, source has ${s.actual}`),
      "run `node scripts/check-admin-types.mjs --update` to shrink the baseline",
    ).toEqual([]);
  });

  it("keeps the panel free of undefined names (TS2304)", () => {
    // The one class worth keeping at zero: a typo'd global renders a dead
    // control that raises no pageerror, so only the compiler sees it.
    expect(scan.diagnostics.filter((d) => d.code === 2304)).toEqual([]);
  });

  it("names an existing server file for every baseline entry", () => {
    for (const file of Object.keys(baseline?.files ?? {})) {
      expect(existsSync(path.join(SERVER_ROOT, file)), file).toBe(true);
    }
  });
});

describe("the type-check ratchet", () => {
  const scanOf = (...diagnostics: { file: string; code: number; message: string }[]): Scan => ({
    diagnostics,
    configErrors: [],
  });
  const baseline: Baseline = {
    files: {
      "admin/static/js/a.js": { "2339:Property 'value' does not exist on type 'HTMLElement'.": 2 },
    },
  };

  it("fails an identity above its baseline count", () => {
    const id = "2339:Property 'value' does not exist on type 'HTMLElement'.";
    const { added, stale } = compare(
      scanOf(
        { file: "admin/static/js/a.js", code: 2339, message: id.slice(5) },
        { file: "admin/static/js/a.js", code: 2339, message: id.slice(5) },
        { file: "admin/static/js/a.js", code: 2339, message: id.slice(5) },
      ),
      baseline,
    );
    expect(added).toEqual([{ file: "admin/static/js/a.js", identity: id, actual: 3, baseline: 2 }]);
    expect(stale).toEqual([]);
  });

  it("fails a baseline identity the source no longer produces", () => {
    const { added, stale } = compare(scanOf(), baseline);
    expect(added).toEqual([]);
    expect(stale).toEqual([
      {
        file: "admin/static/js/a.js",
        identity: "2339:Property 'value' does not exist on type 'HTMLElement'.",
        baseline: 2,
        actual: 0,
      },
    ]);
  });

  it("keys an identity by code and message, never by line", () => {
    const a = { file: "f.js", code: 2339, message: "Property 'x' does not exist on type 'Y'." };
    expect(identity(a)).toBe("2339:Property 'x' does not exist on type 'Y'.");
  });

  it("only shrinks an existing baseline", () => {
    const { added } = compare(
      scanOf({
        file: "admin/static/js/a.js",
        code: 2339,
        message: "Property 'value' does not exist on type 'HTMLElement'.",
      }),
      baseline,
    );
    expect(added).toEqual([]);
    expect(shrink(scanOf(), baseline).files).toEqual({});
  });

  it("seeds the whole scan only when there is no baseline file", () => {
    const one = scanOf({
      file: "admin/static/js/a.js",
      code: 2339,
      message: "Property 'value' does not exist on type 'HTMLElement'.",
    });
    expect(shrink(one, baseline).files).toEqual({
      "admin/static/js/a.js": {
        "2339:Property 'value' does not exist on type 'HTMLElement'.": 1,
      },
    });
    expect(shrink(one, null).files).toEqual({
      "admin/static/js/a.js": {
        "2339:Property 'value' does not exist on type 'HTMLElement'.": 1,
      },
    });
  });
});
