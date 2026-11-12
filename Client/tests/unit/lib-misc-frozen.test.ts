/**
 * Pins two small pure helpers to frozen copies of the implementations they had
 * before they were split into steps, over random input. The copies are
 * deliberately verbatim and must not be edited to follow the live code.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { shallowEqual } from "../../src/lib/store";
import {
  MAX_USERNAME_LEN,
  checkNewUsername,
  type UsernameProblem,
} from "../../src/lib/text/nameLimits";

// ---- Frozen shallowEqual -----------------------------------------------------

function legacyShallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [key, val] of a) {
      if (!b.has(key) || b.get(key) !== val) return false;
    }
    return true;
  }

  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const val of a) {
      if (!b.has(val)) return false;
    }
    return true;
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  for (const key of keysA) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) return false;
  }
  return true;
}

const shared = { tag: "shared" };
const leaf = fc.oneof(
  fc.integer({ min: 0, max: 3 }),
  fc.constantFrom("a", "b", null, true, shared),
  fc.constant(Number.NaN),
);
const key = fc.constantFrom("a", "b", "c");

const container = fc.oneof(
  leaf,
  fc.array(leaf, { maxLength: 4 }),
  fc.dictionary(key, leaf, { maxKeys: 3 }),
  fc.array(fc.tuple(key, leaf), { maxLength: 4 }).map((pairs) => new Map(pairs)),
  fc.array(leaf, { maxLength: 4 }).map((items) => new Set(items)),
);

describe("shallowEqual against its frozen predecessor", () => {
  it("agrees on every pair of leaves, arrays, objects, Maps and Sets", () => {
    fc.assert(
      fc.property(container, container, (a, b) => {
        expect(shallowEqual(a, b)).toBe(legacyShallowEqual(a, b));
      }),
      { numRuns: 3000 },
    );
  }, 60_000);

  it("agrees when the second value is a perturbed copy of the first", () => {
    fc.assert(
      fc.property(fc.dictionary(key, leaf, { maxKeys: 3 }), key, leaf, (obj, k, v) => {
        const next = { ...obj, [k]: v };
        expect(shallowEqual(obj, next)).toBe(legacyShallowEqual(obj, next));
      }),
      { numRuns: 1000 },
    );
  }, 60_000);

  it("treats a Map and a Set as plain objects of no own keys, as before", () => {
    expect(shallowEqual(new Map([[1, 1]]), new Set([1]))).toBe(true);
    expect(shallowEqual(new Map([[1, 1]]), { x: 1 })).toBe(false);
  });
});

// ---- Frozen checkNewUsername -------------------------------------------------

const LEGACY_MIN = 2;
const LEGACY_MAX = MAX_USERNAME_LEN;
const LEGACY_MAX_RUN = 2;
const LEGACY_RESERVED: ReadonlySet<string> = new Set(["everyone", "here"]);

function legacyIsInvisibleFiller(cp: number): boolean {
  return (
    cp === 0x034f ||
    cp === 0x115f ||
    cp === 0x1160 ||
    cp === 0x3164 ||
    cp === 0xffa0 ||
    (cp >= 0x180b && cp <= 0x180f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  );
}

const LETTER = /^\p{L}$/u;
const DIGIT = /^\p{Nd}$/u;
const MARK = /^[\p{Mn}\p{Mc}]$/u;

function legacyCheckNewUsername(raw: string): UsernameProblem | null {
  const username = raw.trim();
  const chars = Array.from(username);
  if (chars.length < LEGACY_MIN) return "tooShort";
  if (chars.length > LEGACY_MAX) return "tooLong";
  if (LEGACY_RESERVED.has(username.toLowerCase())) return "reserved";
  let prev = "";
  let run = 0;
  for (const [i, ch] of chars.entries()) {
    const cp = ch.codePointAt(0) ?? 0;
    if (legacyIsInvisibleFiller(cp)) return "invisible";
    const isMark = MARK.test(ch);
    if (LETTER.test(ch) || DIGIT.test(ch)) {
      run = 0;
    } else if (ch === "_" || ch === "." || ch === "-") {
      if (i === 0) return "start";
      run = 0;
    } else if (isMark) {
      if (i === 0 || !(LETTER.test(prev) || MARK.test(prev))) return "markPlacement";
      run++;
      if (run > LEGACY_MAX_RUN) return "markStack";
    } else {
      return "chars";
    }
    if (i === 0 && !LETTER.test(ch) && !DIGIT.test(ch)) return "start";
    prev = ch;
  }
  return null;
}

const USERNAME_UNITS = [
  "a",
  "Z",
  "7",
  "_",
  ".",
  "-",
  " ",
  "@",
  "!",
  "é",
  "ß",
  "漢",
  "́",
  "̀",
  "ः",
  "͏",
  "ㅤ",
  "️",
  "\u{e0100}",
  "​",
  "\u0000",
];
const username = fc.string({ unit: fc.constantFrom(...USERNAME_UNITS), maxLength: 40 });

describe("checkNewUsername against its frozen predecessor", () => {
  it("agrees on strings built from letters, separators, marks and fillers", () => {
    fc.assert(
      fc.property(username, (raw) => {
        expect(checkNewUsername(raw)).toBe(legacyCheckNewUsername(raw));
      }),
      { numRuns: 4000 },
    );
  }, 60_000);

  it("agrees on arbitrary unicode strings", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 40 }), (raw) => {
        expect(checkNewUsername(raw)).toBe(legacyCheckNewUsername(raw));
      }),
      { numRuns: 1000 },
    );
  }, 60_000);

  it.each([
    ["ab", null],
    ["á̀́b", "markStack"],
    ["á̀b", null],
    ["́ab", "markPlacement"],
    ["_ab", "start"],
    ["a_", null],
    ["a b", "chars"],
    ["a͏b", "invisible"],
  ])("pins %j to %s", (raw, expected) => {
    expect(checkNewUsername(raw)).toBe(expected);
  });
});
