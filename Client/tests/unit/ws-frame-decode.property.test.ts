/**
 * Property tests for the WebSocket frame handler in ws.ts: whatever text the
 * socket delivers, the handler never throws, a frame that is not a JSON object
 * with an object payload never reaches a listener, and a well-formed frame
 * reaches its own type's listeners exactly once.
 */
import { describe, it, expect, vi } from "vitest";
import fc from "fast-check";
import * as logMock from "../helpers/loggerMock";
import * as wsMocks from "./helpers/ws-mocks";

vi.mock("@tauri-apps/api/core", () => wsMocks.tauriCoreMock());
vi.mock("@tauri-apps/api/event", () => wsMocks.tauriEventMock());
vi.mock("@lib/logger", () => logMock.loggerMock());

import { emitTauriEvent } from "./helpers/ws-mocks";
import { createWsClient } from "../../src/lib/ws";
import { ServerMessageType } from "../../src/lib/protocolTypes";
import { useWsClientFixture } from "../helpers/wsClientFixture";
import { openSocket } from "../helpers/wsSuiteHarness";

type WsClient = ReturnType<typeof createWsClient>;
type ServerType = Parameters<WsClient["on"]>[0];

const SERVER_TYPES = Object.values(ServerMessageType) as ServerType[];
// Frames that change the connection itself, and the heartbeat the handler eats.
const CONTROL_TYPES = new Set<string>(["auth_ok", "auth_error", "error", "server_restart", "pong"]);
const PLAIN_TYPES = SERVER_TYPES.filter((t) => !CONTROL_TYPES.has(t));
const PROPERTY_TIMEOUT_MS = 20_000;

function isObjectFrame(raw: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const frame = value as { type?: unknown; payload?: unknown };
  return (
    typeof frame.type === "string" &&
    frame.type !== "" &&
    typeof frame.payload === "object" &&
    frame.payload !== null
  );
}

/** Counts every dispatch, of any server type. */
function countAll(client: WsClient): { count: number } {
  const seen = { count: 0 };
  for (const type of SERVER_TYPES) client.on(type, () => seen.count++);
  return seen;
}

function deliver(raw: string): void {
  emitTauriEvent("ws-message", raw);
}

const jsonFrame = fc.record(
  {
    type: fc.oneof(fc.constantFrom(...SERVER_TYPES), fc.string(), fc.jsonValue()),
    payload: fc.oneof(fc.constant(null), fc.jsonValue()),
    seq: fc.oneof(fc.integer(), fc.jsonValue()),
    cseq: fc.oneof(fc.integer(), fc.jsonValue()),
    id: fc.jsonValue(),
  },
  { requiredKeys: [] },
);

const anyText = fc.oneof(
  fc.string(),
  fc.string({ unit: "grapheme" }),
  fc.jsonValue().map((v) => JSON.stringify(v)),
  jsonFrame.map((f) => JSON.stringify(f)),
);

describe("WebSocket frame decode properties", () => {
  let client: WsClient;
  useWsClientFixture((created) => {
    client = created;
  });

  it(
    "never throws and dispatches only object frames with an object payload",
    async () => {
      await openSocket(client);
      const seen = countAll(client);
      fc.assert(
        fc.property(anyText, (raw) => {
          const before = seen.count;
          expect(() => deliver(raw)).not.toThrow();
          if (!isObjectFrame(raw)) expect(seen.count).toBe(before);
        }),
        { numRuns: 400 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it("drops valid JSON that is not a frame, and frames with a null payload", async () => {
    await openSocket(client);
    const seen = countAll(client);
    for (const raw of [
      "null",
      "7",
      '"text"',
      "[]",
      '[{"type":"chat_message","payload":{}}]',
      '{"type":"auth_error","payload":null}',
      '{"type":"error","payload":null}',
      '{"type":"server_restart","payload":null}',
      '{"type":"auth_ok","payload":null}',
      '{"type":"chat_message","payload":5}',
    ]) {
      expect(() => deliver(raw), raw).not.toThrow();
    }
    expect(seen.count).toBe(0);
    expect(client.getState()).toBe("authenticating");
  });

  it(
    "delivers a well-formed frame to its own listeners once, even after garbage",
    async () => {
      await openSocket(client);
      const received = new Map<string, unknown[]>();
      for (const type of PLAIN_TYPES) {
        const list: unknown[] = [];
        received.set(type, list);
        client.on(type, (payload) => list.push(payload));
      }
      fc.assert(
        fc.property(
          fc.array(
            anyText.filter((raw) => !isObjectFrame(raw)),
            { maxLength: 4 },
          ),
          fc.constantFrom(...PLAIN_TYPES),
          fc.dictionary(fc.string(), fc.jsonValue()),
          (garbage, type, payload) => {
            for (const list of received.values()) list.length = 0;
            for (const raw of garbage) deliver(raw);
            deliver(JSON.stringify({ type, payload }));
            const delivered = [...received.entries()].filter(([, list]) => list.length > 0);
            expect(delivered.map(([t]) => t)).toEqual([type]);
            expect(received.get(type)).toEqual([JSON.parse(JSON.stringify(payload)) as unknown]);
          },
        ),
        { numRuns: 200 },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
