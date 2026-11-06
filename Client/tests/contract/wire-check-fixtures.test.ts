// CONTRACT TEST. Every server to client frame recorded in
// protocol/fixtures/epoch-1/ must pass the client's payload check, so a server
// the client already talks to is not told its frames are malformed. The same
// frames then serve as the base for mutations: a missing required field or a
// wrongly typed one must fail, and a newer server's extras must not.

import { describe, expect, it } from "vitest";
import { FIXTURES, substitute } from "../helpers/protocolFixtures";
import { checkFrame } from "../../src/lib/net/wireCheck";
import { FRAME_SHAPES, SHAPES } from "../../src/lib/net/wireShapes";

interface RecordedFrame {
  readonly label: string;
  readonly type: string;
  readonly payload: unknown;
}

function recordedFrames(): RecordedFrame[] {
  const out: RecordedFrame[] = [];
  for (const [journey, transcript] of FIXTURES) {
    const counter = { n: 0 };
    for (const [conn, frames] of Object.entries(transcript.connections)) {
      frames.forEach((f, i) => {
        if (f.dir !== "s2c") return;
        out.push({
          label: `${journey}/${conn}#${i}`,
          type: f.frame.type,
          payload: substitute(f.frame.payload, {}, counter),
        });
      });
    }
  }
  return out;
}

const FRAMES = recordedFrames();

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** The required top-level fields of a frame's payload, with their shape numbers. */
function requiredFields(type: string): { name: string; ref: number }[] {
  const shape = SHAPES[FRAME_SHAPES[type] ?? -1];
  if (shape === undefined || typeof shape === "number" || shape[0] !== 2) return [];
  return shape[1].map((name, i) => ({ name, ref: shape[2][i] as number }));
}

describe("contract: epoch-1 fixtures through the payload check", () => {
  it("records server frames to check", () => {
    expect(FRAMES.length).toBeGreaterThan(50);
  });

  it("every recorded server frame passes", () => {
    const faults = FRAMES.flatMap((f) => {
      const fault = checkFrame(f.type, f.payload);
      return fault === null ? [] : [`${f.label} ${f.type}: ${fault.path} (${fault.expected})`];
    });
    expect(faults).toEqual([]);
  });

  it("every recorded frame type has a shape, apart from the heartbeat reply", () => {
    // pong is not in the ServerMessage union: the socket answers it itself.
    const unchecked = new Set(FRAMES.map((f) => f.type).filter((t) => !(t in FRAME_SHAPES)));
    expect([...unchecked]).toEqual(["pong"]);
  });

  it("removing any required top-level field fails, naming that field", () => {
    for (const f of FRAMES) {
      for (const { name } of requiredFields(f.type)) {
        const payload = clone(f.payload) as Record<string, unknown>;
        delete payload[name];
        const fault = checkFrame(f.type, payload);
        expect(fault, `${f.label} without ${name}`).not.toBeNull();
        expect(fault?.path, `${f.label} without ${name}`).toBe(name);
      }
    }
  });

  it("a string field that becomes a number fails", () => {
    for (const f of FRAMES) {
      for (const { name, ref } of requiredFields(f.type)) {
        if (ref !== 0) continue;
        const payload = clone(f.payload) as Record<string, unknown>;
        payload[name] = 42;
        const fault = checkFrame(f.type, payload);
        expect(fault, `${f.label}: ${name} as a number`).not.toBeNull();
        expect(fault?.path).toBe(name);
        expect(fault?.expected).toBe("string");
      }
    }
  });

  it("an unknown extra field passes, at the top and inside nested objects", () => {
    for (const f of FRAMES) {
      const extra = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(extra);
        if (value !== null && typeof value === "object") {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(value)) out[k] = extra(v);
          out["added_by_a_newer_server"] = { nested: [1, 2] };
          return out;
        }
        return value;
      };
      expect(checkFrame(f.type, extra(f.payload)), f.label).toBeNull();
    }
  });

  it("a channel type this client does not know still passes", () => {
    const ready = FRAMES.find((f) => f.type === "ready");
    expect(ready).toBeDefined();
    const payload = clone(ready!.payload) as { channels: { type: string }[] };
    expect(payload.channels.length).toBeGreaterThan(0);
    for (const ch of payload.channels) ch.type = "stage";
    expect(checkFrame("ready", payload)).toBeNull();

    const created = FRAMES.find((f) => f.type === "channel_create");
    expect(created).toBeDefined();
    const one = clone(created!.payload) as { type: string };
    one.type = "stage";
    expect(checkFrame("channel_create", one)).toBeNull();
  });
});
