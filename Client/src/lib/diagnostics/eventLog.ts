// The rolling diagnostic event log: a bounded ring of coded events that the
// support bundle carries. Loaded lazily (main.ts), so the catalogue stays off
// the startup path; until then eventSink.ts queues what owners record.
//
// Every field is checked against the code's allowlist in eventCodes.ts: an
// unknown field, or a value that fails its type check, is dropped. Caps bound
// the ring by count, bytes and age, and a per-code rate limit turns a burst
// into one events.dropped line so it cannot push an incident's start out.
import {
  EVENT_CODES,
  EVENT_LOG_CAPS,
  FIELD_PATTERNS,
  type EventCode,
  type FieldSpec,
} from "./eventCodes";
import { attachRecorder, type EventFieldValue } from "./eventSink";

const RATE_WINDOW_MS = 60_000;

interface StoredEvent {
  readonly t: number;
  readonly line: string;
}

interface RateWindow {
  start: number;
  count: number;
  dropped: number;
}

let events: StoredEvent[] = [];
let bytes = 0;
const windows = new Map<EventCode, RateWindow>();
const lineListeners = new Set<(line: string) => void>();
const clearListeners = new Set<() => void>();
let detach: (() => void) | null = null;

function isCode(value: unknown): value is EventCode {
  return typeof value === "string" && Object.hasOwn(EVENT_CODES, value);
}

function checkValue(spec: FieldSpec, value: EventFieldValue): EventFieldValue | undefined {
  switch (spec.type) {
    case "enum":
      return typeof value === "string" && spec.values.includes(value) ? value : undefined;
    case "int":
      return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
    case "ms":
      return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.round(value)
        : undefined;
    case "bool":
      return typeof value === "boolean" ? value : undefined;
    case "code":
      return isCode(value) ? value : undefined;
    case "host":
      // The pattern alone would pass a dotted IPv4 address.
      return typeof value === "string" && FIELD_PATTERNS.host.test(value) && !/^[\d.]+$/.test(value)
        ? value
        : undefined;
    case "version":
    case "token":
    case "hash":
    case "pseudonym":
      return typeof value === "string" && FIELD_PATTERNS[spec.type].test(value) ? value : undefined;
    default:
      return undefined;
  }
}

/** The event with only the allowlisted, well-typed fields of its code. */
export function sanitizeEvent(
  code: EventCode,
  fields: Readonly<Record<string, EventFieldValue | null | undefined>>,
  at: number,
): Record<string, EventFieldValue> {
  const spec: Readonly<Record<string, FieldSpec>> = EVENT_CODES[code].fields;
  const out: Record<string, EventFieldValue> = { t: at, code };
  for (const [name, fieldSpec] of Object.entries(spec)) {
    const raw = fields[name];
    if (raw === null || raw === undefined) continue;
    const value = checkValue(fieldSpec, raw);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

function trim(now: number): void {
  const oldest = now - EVENT_LOG_CAPS.maxAgeMs;
  let drop = 0;
  while (
    drop < events.length &&
    (events.length - drop > EVENT_LOG_CAPS.maxEvents ||
      bytes > EVENT_LOG_CAPS.maxBytes ||
      events[drop]!.t < oldest)
  ) {
    bytes -= events[drop]!.line.length;
    drop++;
  }
  if (drop > 0) events = events.slice(drop);
}

function store(
  code: EventCode,
  fields: Readonly<Record<string, EventFieldValue | null | undefined>>,
  at: number,
): void {
  const line = JSON.stringify(sanitizeEvent(code, fields, at));
  events.push({ t: at, line });
  bytes += line.length;
  trim(at);
  for (const listener of lineListeners) listener(line);
}

function flushDropped(code: EventCode, window: RateWindow, at: number): void {
  if (window.dropped === 0) return;
  const count = window.dropped;
  window.dropped = 0;
  store("events.dropped", { dropped_code: code, count }, at);
}

/** Record one event: the recorder eventSink.ts forwards to. */
export function record(
  code: EventCode,
  fields: Readonly<Record<string, EventFieldValue | null | undefined>>,
  at: number,
): void {
  if (!isCode(code)) return;
  let window = windows.get(code);
  if (window === undefined || at - window.start >= RATE_WINDOW_MS) {
    if (window !== undefined) flushDropped(code, window, at);
    window = { start: at, count: 0, dropped: 0 };
    windows.set(code, window);
  }
  if (window.count >= EVENT_LOG_CAPS.perCodePerMinute) {
    window.dropped++;
    return;
  }
  window.count++;
  store(code, fields, at);
}

/** Attach to the sink; queued events are recorded first. Idempotent. */
export function startEventLog(): void {
  if (detach !== null) return;
  detach = attachRecorder(record);
}

/** Store the drop counts still waiting for their code's next event, so a
 *  burst that ended reaches the disk writer and the bundle. */
export function flushDroppedCounts(now = Date.now()): void {
  for (const [code, window] of windows) flushDropped(code, window, now);
}

/** The ring as JSON lines, oldest first, with any pending drop counts. */
export function getEventLines(now = Date.now()): string[] {
  flushDroppedCounts(now);
  trim(now);
  return events.map((e) => e.line);
}

/** Empty the ring and tell the disk writer to delete its files. */
export function clearEventLog(): void {
  events = [];
  bytes = 0;
  windows.clear();
  for (const listener of clearListeners) listener();
}

/** Each stored line, as it is stored (the desktop disk writer). */
export function onEventLine(listener: (line: string) => void): () => void {
  lineListeners.add(listener);
  return () => {
    lineListeners.delete(listener);
  };
}

export function onEventLogCleared(listener: () => void): () => void {
  clearListeners.add(listener);
  return () => {
    clearListeners.delete(listener);
  };
}

/** Test seam: forget everything, including the sink attachment. */
export function resetEventLogForTests(): void {
  detach?.();
  detach = null;
  events = [];
  bytes = 0;
  windows.clear();
  lineListeners.clear();
  clearListeners.clear();
}
