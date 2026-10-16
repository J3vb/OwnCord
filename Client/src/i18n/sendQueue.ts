import { defineCatalog } from "./format";

/** The upload strip on a message waiting for its files (features/messaging/sendQueue.ts).
 *  Its own catalog so the copy loads with that lazy module, not with the main page. */
export const sendQueueText = defineCatalog("sendQueue", {
  "strip.cancel": "Cancel upload",
  "strip.label": { one: "Uploading {count} file", other: "Uploading {count} files" },
});
