// Moderation Center handler bodies (B9-11), called only from lib/dispatcher.ts.
import type { Payload } from "../connection/dispatchContext";
import { noteQueueChange } from "./store";

/** A report-queue change. Appeal-queue frames (appeal_id) are not this view's. */
export function handleModQueue(payload: Payload<"mod_queue">): void {
  if (typeof payload.report_id === "string") noteQueueChange();
}
