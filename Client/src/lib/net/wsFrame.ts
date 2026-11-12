// The shape check on a WebSocket frame before ws.ts reads any field of it.

import type { ServerMessage } from "../types";
import { recordEvent } from "../diagnostics/eventSink";
import { createLogger } from "../logger";
import { checkFrame, type WireFault } from "./wireCheck";

const log = createLogger("ws");

export interface RawFrame {
  type?: string;
  payload?: unknown;
  id?: string;
  seq?: number;
  cseq?: number;
}

/** The frame as an object, or null when it is not JSON or not a JSON object. */
export function parseFrame(raw: string): RawFrame | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

/** Every server payload is an object; null or a bare value is never dispatched. */
export function hasObjectPayload(frame: RawFrame): boolean {
  return (
    typeof frame.payload === "object" && frame.payload !== null && !Array.isArray(frame.payload)
  );
}

/**
 * The frames that settle the connect: nothing re-requests them, and redialling
 * with the same token would only meet them again, so an unreadable one ends it.
 */
const HANDSHAKE_TYPES: ReadonlySet<string> = new Set(["ready", "auth_ok", "auth_error"]);

/** Calls each listener; one that throws is reported and must not stop the rest. */
export function callAll(listeners: ReadonlySet<() => void>, onError: (err: unknown) => void): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      onError(err);
    }
  }
}

/** What to do about a frame that was not dispatched. */
export type RejectVerdict = "fatal" | "resync" | "drop";

/** What a frame turned out to be. */
export type FrameRead =
  | { readonly kind: "message"; readonly msg: ServerMessage }
  | { readonly kind: "malformed"; readonly payloadKind: string }
  | { readonly kind: "invalid"; readonly type: string; readonly fault: WireFault };

/** The fault in a typed frame's payload. A checker that throws counts as a fault. */
function faultOf(type: string, payload: unknown): WireFault | null {
  try {
    return checkFrame(type, payload);
  } catch {
    return { path: "", expected: "checkable" };
  }
}

/** True when the frame has the shape its type promises; an unknown type passes. */
function conforms(frame: RawFrame): frame is RawFrame & ServerMessage {
  return faultOf(frame.type ?? "", frame.payload) === null;
}

/** Sorts a parsed frame into a typed message, a malformed envelope or a shape fault. */
export function readServerFrame(frame: RawFrame): FrameRead {
  if (!frame.type || !hasObjectPayload(frame)) {
    return { kind: "malformed", payloadKind: Object.prototype.toString.call(frame.payload) };
  }
  if (conforms(frame)) return { kind: "message", msg: frame };
  const fault = faultOf(frame.type, frame.payload) ?? { path: "", expected: "valid" };
  return { kind: "invalid", type: frame.type, fault };
}

/**
 * Logs and records a frame that is not dispatched. Only the type and the field
 * name go out: frames hold chat text and the log is persisted. "fatal" is a
 * handshake frame; "resync" is a sequenced frame whose event is now lost, so
 * the caller asks the server for a fresh state; "drop" needs nothing more.
 */
export function reportRejectedFrame(
  read: Exclude<FrameRead, { kind: "message" }>,
  bytes: number,
  sequenced: boolean,
): RejectVerdict {
  if (read.kind === "malformed") {
    log.warn("Invalid WS message: missing type or payload", {
      bytes,
      payloadKind: read.payloadKind,
    });
    return "drop";
  }
  log.warn("Invalid WS frame, dropping", {
    type: read.type,
    path: read.fault.path,
    expected: read.fault.expected,
  });
  // The recorder keeps tokens only: brackets in a path are shape marks, not names.
  const field = read.fault.path.replace(/[[\]{}]/g, "").slice(0, 48) || "payload";
  recordEvent("ws.frame_invalid", { type: read.type, field });
  if (HANDSHAKE_TYPES.has(read.type)) return "fatal";
  return sequenced ? "resync" : "drop";
}
