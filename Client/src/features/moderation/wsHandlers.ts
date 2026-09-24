// Moderation Center handler bodies (B9-11), called only from lib/dispatcher.ts.
import type { Payload } from "../connection/dispatchContext";
import { noteAppealChange, noteQueueChange } from "./store";

/** A report-queue or appeal-queue change: each bumps only its own view's signal. */
export function handleModQueue(payload: Payload<"mod_queue">): void {
  if (typeof payload.report_id === "string") noteQueueChange();
  if (typeof payload.appeal_id === "string") noteAppealChange();
}
