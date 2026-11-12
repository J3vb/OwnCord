// Reads the epoch-1 wire fixtures under protocol/fixtures/epoch-1/ and turns
// their typed placeholders ("<id:number>") into concrete values of the same
// type. Shared by the contract tests that replay or check the recorded frames.
// The fixtures are Server-owned, so only tests/contract may import this.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { expect } from "vitest";
import { repoRoot } from "./repoRoot";

// ─── fixture loading ─────────────────────────────────────────────────────────

export interface WireFrame {
  readonly dir: "c2s" | "s2c";
  readonly frame: { readonly type: string; readonly payload?: unknown; readonly id?: string };
}
export interface WireTranscript {
  readonly journey: string;
  readonly connections: Record<string, readonly WireFrame[]>;
}

const FIXTURE_DIR = path.join(repoRoot, "protocol/fixtures/epoch-1");
export const FIXTURES = new Map<string, WireTranscript>(
  readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => [
      f.replace(/\.json$/, ""),
      JSON.parse(readFileSync(path.join(FIXTURE_DIR, f), "utf8")) as WireTranscript,
    ]),
);

export function fixture(journey: string): WireTranscript {
  const tr = FIXTURES.get(journey);
  expect(tr, `fixture ${journey}.json`).toBeDefined();
  return tr!;
}

/** The server->client frames of one connection, in order. */
export function s2c(journey: string, conn: string): WireFrame[] {
  const frames = fixture(journey).connections[conn];
  expect(frames, `${journey}: connection ${conn}`).toBeDefined();
  return frames!.filter((f) => f.dir === "s2c");
}

/** The first server->client frame of `type` in `journey`, across connections. */
export function s2cFrame(journey: string, type: string): WireFrame["frame"] {
  for (const frames of Object.values(fixture(journey).connections)) {
    const found = frames.find((f) => f.dir === "s2c" && f.frame.type === type);
    if (found !== undefined) return found.frame;
  }
  throw new Error(`${journey}: no s2c ${type} frame`);
}

/** Every server->client frame of `type` in `journey`, across connections. */
export function s2cFrames(journey: string, type: string): WireFrame["frame"][] {
  const out: WireFrame["frame"][] = [];
  for (const frames of Object.values(fixture(journey).connections)) {
    for (const f of frames) {
      if (f.dir === "s2c" && f.frame.type === type) out.push(f.frame);
    }
  }
  if (out.length === 0) throw new Error(`${journey}: no s2c ${type} frame`);
  return out;
}

// ─── placeholder substitution ─────────────────────────────────────────────────

const PLACEHOLDER = /^<(\w+):(\w+)>$/;

/**
 * Replace every typed placeholder in `value`, recursively. `overrides` keys
 * win, so a test can pin an id to a value it seeded (e.g. message_id). Any
 * other placeholder gets a fresh value of its declared type from a shared
 * counter, so two placeholders never collide.
 */
export function substitute(
  value: unknown,
  overrides: Record<string, unknown>,
  counter: { n: number },
): unknown {
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string") {
      const m = PLACEHOLDER.exec(v);
      if (m === null) return v;
      const [klass, type] = [m[1]!, m[2]!];
      if (key !== null && Object.prototype.hasOwnProperty.call(overrides, key)) {
        const pinned = overrides[key];
        const pinnedType =
          pinned === null ? "null" : typeof pinned === "boolean" ? "bool" : typeof pinned;
        if (pinnedType !== type) {
          throw new Error(`override ${key}=${String(pinned)} is ${pinnedType}, wire has ${v}`);
        }
        return pinned;
      }
      counter.n += 1;
      const n = counter.n;
      switch (type) {
        case "null":
          return null;
        case "number":
          return klass === "id" ? 1000 + n : n;
        case "bool":
          return true;
        case "string":
          switch (klass) {
            case "id":
              return `req-${n}`;
            case "token":
              return `tok-${n}`;
            case "ts":
              // The real wire form: SQLite datetime('now'), naive UTC, which
              // parseTimestamp parses by appending the Z.
              return "2026-09-05 12:00:00";
            default:
              return `${klass}-${n}`;
          }
        default:
          throw new Error(`unsupported placeholder type: ${v}`);
      }
    }
    if (Array.isArray(v)) return v.map((item) => walk(item, key));
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val, k);
      return out;
    }
    return v;
  };
  return walk(value, null);
}
