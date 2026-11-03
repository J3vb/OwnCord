// The door every diagnostic event goes through. Kept tiny because ws.ts and
// main.ts sit on the startup path: it only queues events until the recorder
// (eventLog.ts, loaded lazily with the catalogue) attaches, then forwards them.
// Owners call recordEvent(); nothing here reads app state.
import type { EventCode, EVENT_CODES } from "./eventCodes";

export type EventFieldValue = string | number | boolean;

type ValueOf<S> = S extends { readonly type: "enum"; readonly values: readonly (infer V)[] }
  ? V
  : S extends { readonly type: "int" | "ms" }
    ? number
    : S extends { readonly type: "bool" }
      ? boolean
      : string;

type Spec<C extends EventCode> = (typeof EVENT_CODES)[C]["fields"];

/** The fields a code may carry, typed from the catalogue. null or a missing
 *  field is left out of the stored event. */
export type EventFieldsFor<C extends EventCode> = {
  readonly [K in keyof Spec<C>]?: ValueOf<Spec<C>[K]> | null;
};

export type Recorder = (
  code: EventCode,
  fields: Readonly<Record<string, EventFieldValue | null | undefined>>,
  at: number,
) => void;

/** The Logs tab switch "Keep a diagnostic event log"; on unless turned off. */
export const EVENT_LOG_PREF_KEY = "diagnosticEventLog";

/** Events recorded before the recorder attached; the oldest go first. */
const MAX_PENDING = 200;

let pending: {
  code: EventCode;
  fields: Record<string, EventFieldValue | null | undefined>;
  at: number;
}[] = [];
let recorder: Recorder | null = null;
let enabled = true;

export function recordEvent<C extends EventCode>(code: C, fields?: EventFieldsFor<C>): void {
  if (!enabled) return;
  const at = Date.now();
  const copy = { ...(fields as Record<string, EventFieldValue | null | undefined> | undefined) };
  if (recorder !== null) {
    recorder(code, copy, at);
    return;
  }
  pending.push({ code, fields: copy, at });
  if (pending.length > MAX_PENDING) pending.shift();
}

/** Hand events to the recorder, starting with the ones queued so far. */
export function attachRecorder(next: Recorder): () => void {
  recorder = next;
  const queued = pending;
  pending = [];
  for (const event of queued) next(event.code, event.fields, event.at);
  return () => {
    if (recorder === next) recorder = null;
  };
}

/** Turning the log off drops what is queued and ignores new events. */
export function setEventSinkEnabled(on: boolean): void {
  enabled = on;
  if (!on) pending = [];
}
