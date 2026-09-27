// CONTRACT TEST. The artifact under test is owned by Server/admin; the runner
// lives here because placement follows capability, not ownership — the Go
// module carries no JavaScript engine, so nothing under Server/ can type-check
// this panel. See docs/contributing.md#testing for the membership rule.
//
// ARCH-10 stage 1: the admin panel (Server/admin/static/js) is checked with a
// non-strict checkJs program and a shrink-only baseline, enforced by
// `npm run check:admin-types`. This drives the ratchet's own logic so a broken
// comparator cannot silently pass every PR, and pins the property the check
// exists for: 0 TS2304 (undefined global).
import { describe, expect, it } from "vitest";
import {
  compare,
  identity,
  shrink,
  type Baseline,
  type Scan,
} from "../../scripts/check-admin-types.mjs";

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

  it("keeps an identity when a printed object type or its elaboration changes", () => {
    const before = {
      file: "f.js",
      code: 2339,
      message: "Property 'value' does not exist on type '{ a: () => void; b(): void; }'.",
    };
    const after = {
      ...before,
      message:
        "Property 'value' does not exist on type '{ a: () => void; b(): void; c(): void; }'.\n" +
        "  Property 'value' does not exist on type 'Other'.",
    };
    expect(identity(before)).toBe("2339:Property 'value' does not exist on type '{…}'.");
    expect(identity(after)).toBe(identity(before));
    expect(
      identity({ ...before, message: "Property 'value' does not exist on type 'A | {}'." }),
    ).toBe("2339:Property 'value' does not exist on type 'A | {}'.");
  });

  it("fails an undefined name (TS2304) even when the baseline lists it", () => {
    const id = "2304:Cannot find name 'toast'.";
    const { added } = compare(
      scanOf({ file: "admin/static/js/a.js", code: 2304, message: "Cannot find name 'toast'." }),
      { files: { "admin/static/js/a.js": { [id]: 1 } } },
    );
    expect(added).toEqual([{ file: "admin/static/js/a.js", identity: id, actual: 1, baseline: 0 }]);
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
