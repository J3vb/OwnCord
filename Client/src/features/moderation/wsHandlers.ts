// Moderation Center handler bodies, called only from lib/dispatcher.ts.
import type { Payload } from "../connection/dispatchContext";
import type { ReadyPayload } from "@lib/types";
import { noteAppealChange, noteQueueChange, setMemberTimeouts } from "./store";

/** A report-queue or appeal-queue change: each bumps only its own view's signal. */
export function handleModQueue(payload: Payload<"mod_queue">): void {
  if (typeof payload.report_id === "string") noteQueueChange();
  if (typeof payload.appeal_id === "string") noteAppealChange();
}

/** member_timeouts: the viewer's active-timeout list, replaced wholesale (3C-7c). */
export function handleMemberTimeouts(payload: Payload<"member_timeouts">): void {
  setMemberTimeouts(payload.timeouts);
}

/** Every ready replaces the map; one without the field (an old server) clears it to "unknown". */
export function applyReadyMemberTimeouts(payload: ReadyPayload): void {
  setMemberTimeouts(payload.member_timeouts);
}
