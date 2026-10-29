// Browser log files: a bounded memory ring in place of files. A page
// has no log directory, so `getDir` is null, `openFolder` is the existing
// unavailable answer, and `readAll` is what the ring holds, as one entry, for
// the support bundle. Nothing survives a reload.
import type { LogEntry } from "@lib/logger";
import type { LogFiles } from "../contracts/logFiles";

/** The most lines the ring keeps; the oldest go first. */
export const RING_CAPACITY = 2000;
const RING_FILE_NAME = "owncord-client-memory.jsonl";

let ring: string[] = [];
let stop: (() => void) | null = null;

function push(line: string): void {
  ring.push(line);
  if (ring.length > RING_CAPACITY) ring.splice(0, ring.length - RING_CAPACITY);
}

function onEntry(entry: LogEntry): void {
  push(JSON.stringify(entry));
}

export const logFiles: LogFiles = {
  async init(): Promise<() => void> {
    if (stop !== null) return () => undefined;
    // Loaded here, not at import: the logger registers a page listener when it
    // loads, and the registry imports this file on every page.
    const { addLogListener, getLogBuffer } = await import("@lib/logger");
    if (stop !== null) return () => undefined;
    // Entries logged before this listener attached, as the desktop writer does.
    ring = [];
    for (const entry of getLogBuffer()) onEntry(entry);
    const removeListener = addLogListener(onEntry);
    const release = (): void => {
      removeListener();
      if (stop === release) stop = null;
    };
    stop = release;
    return release;
  },
  flush: async () => undefined,
  clearPending: async () => undefined,
  getDir: () => null,
  async clearAll(): Promise<void> {
    ring = [];
  },
  async readAll() {
    return ring.length === 0 ? [] : [{ name: RING_FILE_NAME, text: `${ring.join("\n")}\n` }];
  },
  readNative: async () => [],
  openFolder: async () => ({ ok: false, error: "log files are unavailable in the browser" }), // i18n-exempt: diagnostic
};
