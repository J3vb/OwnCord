/**
 * The way startup code reaches threadsStore. Most sessions never see
 * a thread, so the store loads on first need (a thread frame, or a history row
 * carrying one) instead of weighing on the startup chunk. Work handed to
 * `withThreadsStore` runs in call order: queued while the chunk loads, then
 * immediately once it has.
 */

import { registerSessionReset } from "@lib/net/sessionRegistry";
import type { ApiClient } from "@lib/api";
import type { ThreadInfo } from "@lib/types";
import type { WsClient } from "@lib/ws";

type ThreadsModule = typeof import("./threads.store");

let loaded: ThreadsModule | null = null;
let queue: ((m: ThreadsModule) => void)[] = [];
let importing = false;

// Work queued for the previous server must not run against the next one.
void registerSessionReset("threads:loader", () => {
  queue = [];
}); // app-lifetime

/** Run `run` with the threads store, loading it first if need be. */
export function withThreadsStore(run: (m: ThreadsModule) => void): void {
  if (loaded !== null) {
    run(loaded);
    return;
  }
  queue.push(run);
  if (importing) return;
  importing = true;
  import("./threads.store").then(
    (m) => {
      loaded = m;
      const pending = queue;
      queue = [];
      for (const job of pending) job(m);
    },
    () => {
      // Keep the queue (a queued delete must still run before a later change);
      // the next need tries the import again.
      importing = false;
    },
  );
}

/**
 * Whether the store is loaded or loading. A frame for an id no other store
 * knows (a followed thread's activity hint) only needs the store when one has
 * been asked for: a session that has met no thread never imports it for them.
 */
export function threadsStoreInUse(): boolean {
  return loaded !== null || importing || queue.length > 0;
}

/** The store if it has loaded; null while no thread has been seen this run. */
export function loadedThreadsStore(): ThreadsModule | null {
  return loaded;
}

/** The `thread` on each fetched starter row: a REST snapshot (see adoptThreadSnapshots). */
export function adoptStarterThreads(rows: readonly { readonly thread?: ThreadInfo }[]): void {
  const found = rows.flatMap((row) => (row.thread === undefined ? [] : [row.thread]));
  if (found.length > 0) withThreadsStore((m) => m.adoptThreadSnapshots(found));
}

type ResumeHook = (
  ws: Pick<WsClient, "send">,
  api: Pick<Partial<ApiClient>, "getMessages"> | undefined,
) => void;

let resumeHook: ResumeHook | null = null;

/** The thread panel's host sets this while it is mounted, and clears it (with
 *  the hook it set) when it goes. */
export function setThreadResume(hook: ResumeHook | null): void {
  resumeHook = hook;
}

/** After every authenticated (re)connect: re-focus the open thread, if any. */
export function resumeThreadFocus(
  ws: Pick<WsClient, "send">,
  api: Pick<Partial<ApiClient>, "getMessages"> | undefined,
): void {
  resumeHook?.(ws, api);
}
