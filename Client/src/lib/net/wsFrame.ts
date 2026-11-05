// The shape check on a WebSocket frame before ws.ts reads any field of it.

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
