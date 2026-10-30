/**
 * Send while uploading, the lazy half. A message sent with files
 * still uploading becomes a queued send: the controller keeps one entry per
 * message, this module waits for its uploads and hands the settled ids back
 * through `deps.dispatch`, which posts it as one ordinary `chat_send`. It writes
 * no store and never touches the socket; the controller's deps do both, so a
 * channel switch changes nothing here. Loaded through sendQueue-loader.ts.
 */

import { Disposable } from "../../lib/disposable";
import { createElement } from "../../lib/dom";
import type { DraftUpload, SentAttachment } from "../../components/MessageInput";
import { sendQueueText } from "../../i18n/sendQueue";
import { ATTACHMENT_TTL_MS } from "./attachmentTtl";

/** One file of a queued send, in chip order. */
export interface QueuedItem {
  filename: string;
  /** The picked file, so a lost or old upload can be sent again. Absent on a restored chip. */
  readonly file?: File;
  /** The server's id once the upload settled. */
  id?: string;
  /** Date.now() when it settled; ages the id against the server's sweep. */
  uploadedAt?: number;
  /** The running upload; cleared once it settles or is destroyed. */
  upload?: DraftUpload;
}

export type QueueFailure = "UPLOAD_FAILED" | "UPLOAD_CANCELLED";

/** A message waiting for its uploads. The controller creates it and owns the map it lives in. */
export interface QueuedSend {
  /** The row's correlation id; Retry moves the entry to a new one. */
  cid: string;
  readonly channelId: number;
  readonly userId: number;
  readonly content: string;
  readonly replyTo: number | null;
  readonly replyPing: boolean;
  readonly items: QueuedItem[];
  /** Set by Cancel, so the run reports UPLOAD_CANCELLED rather than UPLOAD_FAILED. */
  cancelled?: boolean;
  /** Set once the row shows Retry; absent while it waits for uploads. */
  failed?: boolean;
  /** Progress observers (one per rendered strip), made by the first strip: item index and fraction. */
  listeners?: Set<(index: number, fraction: number) => void>;
}

export interface QueueDeps {
  /** Upload one file; the controller's own upload, so a failure is logged once. */
  readonly upload: (
    file: File,
    signal: AbortSignal,
    onProgress: (fraction: number) => void,
  ) => Promise<{ readonly id: string; readonly filename: string }>;
  /** Files that can no longer be sent go back to the composer of the entry's channel. */
  readonly putBack: (files: readonly SentAttachment[]) => void;
  /** Every file has a fresh id: post the message with these, in chip order. */
  readonly dispatch: (files: readonly SentAttachment[]) => void;
  /** The channel's last send and its slow-mode window in seconds, once one was charged. */
  readonly slowWindow: () => { readonly sentAt: number; readonly window: number } | undefined;
  /** An upload failed or was cancelled; the row becomes a failed one. */
  readonly fail: (code: QueueFailure) => void;
}

// i18n-exempt: an internal rejection reason, never shown (the row says "Upload cancelled")
const CANCELLED = "upload cancelled";

const isFresh = (item: QueuedItem, now: number): boolean =>
  item.id !== undefined &&
  item.uploadedAt !== undefined &&
  now - item.uploadedAt < ATTACHMENT_TTL_MS;

function notify(entry: QueuedSend, item: QueuedItem, fraction: number): void {
  const index = entry.items.indexOf(item);
  for (const listener of entry.listeners ?? []) listener(index, fraction);
}

/** Route the item's progress to the strips watching the entry. */
function watch(entry: QueuedSend, item: QueuedItem): void {
  if (item.upload !== undefined) item.upload.onProgress = (f) => notify(entry, item, f);
}

/** Upload `file` again for `item`, with an owner of its own. */
function startUpload(entry: QueuedSend, item: QueuedItem, file: File, deps: QueueDeps): void {
  const owner = new Disposable();
  let settledAt: number | undefined;
  let fraction: number | null = null;
  const result = deps.upload(file, owner.signal, (f) => {
    fraction = f;
    handle.onProgress?.(f);
  });
  // A rejection nobody awaits (a cancelled retry) must not surface as unhandled.
  result.then(
    () => (settledAt = Date.now()),
    () => {},
  );
  const handle: DraftUpload = {
    filename: item.filename,
    file,
    owner,
    result,
    get settledAt() {
      return settledAt;
    },
    get fraction() {
      return fraction;
    },
    onProgress: null,
    refreshing: null,
  };
  item.id = undefined;
  item.uploadedAt = undefined;
  item.upload = handle;
  watch(entry, item);
}

/** Rejects once `signal` aborts, so a Cancel ends the wait even on a transport that ignores it. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = (): void => reject(new Error(CANCELLED));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/** Wait for the item's running upload and record its id. */
async function settle(entry: QueuedSend, item: QueuedItem): Promise<void> {
  const upload = item.upload;
  if (upload === undefined) return;
  const result = await Promise.race([upload.result, aborted(upload.owner.signal)]);
  item.id = result.id;
  item.filename = result.filename;
  item.uploadedAt = upload.settledAt ?? Date.now();
  item.upload = undefined;
  notify(entry, item, 1);
}

function destroyRunning(entry: QueuedSend): void {
  for (const item of entry.items) {
    item.upload?.owner.destroy();
    item.upload = undefined;
  }
}

const asFile = (item: QueuedItem): SentAttachment => ({
  id: item.id ?? "",
  filename: item.filename,
  ...(item.file === undefined ? {} : { file: item.file }),
});

/**
 * Wait for every upload, then dispatch with the ids in chip order. An id older
 * than the server's sweep margin is uploaded again from its file once; one with
 * no file goes back to the composer. The first failure destroys the rest and
 * fails the send, keeping the ids that settled for Retry. Never rejects.
 */
export async function runQueuedSend(entry: QueuedSend, deps: QueueDeps): Promise<void> {
  entry.failed = false;
  try {
    for (const item of entry.items) watch(entry, item);
    await Promise.all(entry.items.map((item) => settle(entry, item)));
    // A text sent meanwhile may have opened the channel's slow-mode window.
    await holdForSlowMode(entry, deps);
    if (entry.cancelled) throw new Error(CANCELLED);
    // An upload can outlast the age margin of an id that settled long before.
    const old = entry.items.filter((item) => !isFresh(item, Date.now()));
    for (const item of old) {
      if (item.file !== undefined) startUpload(entry, item, item.file, deps);
    }
    await Promise.all(old.map((item) => settle(entry, item)));
    if (entry.cancelled) throw new Error(CANCELLED);
    const lost = entry.items.filter((item) => item.id === undefined || !isFresh(item, Date.now()));
    for (const item of lost) entry.items.splice(entry.items.indexOf(item), 1);
    if (lost.length > 0) deps.putBack(lost.filter((i) => i.id !== undefined).map(asFile));
    deps.dispatch(entry.items.map(asFile));
  } catch {
    destroyRunning(entry);
    // Cancel was pressed from the keyboard: its button is about to be replaced.
    const cancel = document.querySelector(`[data-testid="msg-upload-cancel-${entry.cid}"]`);
    const hadFocus = cancel !== null && cancel === document.activeElement;
    entry.failed = true;
    deps.fail(entry.cancelled ? "UPLOAD_CANCELLED" : "UPLOAD_FAILED");
    if (hadFocus) focusRetry(entry.cid, true);
  }
}

/** Poll until the slow-mode window is over; Cancel, Delete and teardown set `cancelled`. */
function holdForSlowMode(entry: QueuedSend, deps: QueueDeps): Promise<void> {
  const sent = deps.slowWindow();
  const ms = sent === undefined ? 0 : sent.sentAt + sent.window * 1000 - Date.now();
  if (ms <= 0 || entry.cancelled) return Promise.resolve();
  return new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 250))).then(() =>
    holdForSlowMode(entry, deps),
  );
}

/** Focus the failed row's Retry; the row may render a frame after the store changes. */
function focusRetry(cid: string, again: boolean): void {
  const retry = document.querySelector<HTMLElement>(`[data-testid="msg-retry-${cid}"]`);
  if (retry !== null) retry.focus();
  else if (again) requestAnimationFrame(() => focusRetry(cid, false));
}

/** Stop a queued send's uploads; the run in progress then fails it UPLOAD_CANCELLED. */
export function cancelQueuedSend(entry: QueuedSend): void {
  entry.cancelled = true;
  for (const item of entry.items) item.upload?.owner.destroy();
}

/**
 * Run a failed or cancelled send again. Every file with neither a fresh id nor
 * a running upload is uploaded again from its file, and one with no file goes
 * back to the composer; ids that are still fresh are kept.
 */
export async function retryQueuedSend(entry: QueuedSend, deps: QueueDeps): Promise<void> {
  entry.cancelled = false;
  const now = Date.now();
  const lost: QueuedItem[] = [];
  for (const item of entry.items) {
    if (item.upload !== undefined || isFresh(item, now)) continue;
    if (item.file !== undefined) startUpload(entry, item, item.file, deps);
    else lost.push(item);
  }
  for (const item of lost) entry.items.splice(entry.items.indexOf(item), 1);
  const unsendable = lost.filter((item) => item.id !== undefined).map(asFile);
  if (unsendable.length > 0) deps.putBack(unsendable);
  await runQueuedSend(entry, deps);
}

/**
 * The strip under a queued row: a chip per file, with its progress and one
 * Cancel while it runs, the bare chips once it failed. Progress ticks write the
 * bars and never the store; `signal` (the row's render) drops the observer.
 */
export function renderUploadStrip(entry: QueuedSend, signal: AbortSignal): HTMLElement {
  const running = entry.failed !== true;
  const strip = createElement("div", {
    class: "msg-upload-strip",
    id: `msg-upload-strip-${entry.cid}`,
    ...(running
      ? {
          role: "group",
          "aria-label": sendQueueText("strip.label", { count: entry.items.length }),
        }
      : {}),
  });
  const bars: HTMLProgressElement[] = [];
  for (const item of entry.items) {
    const chip = createElement("div", { class: "msg-upload-chip" });
    chip.appendChild(createElement("span", {}, item.filename));
    if (running) {
      const bar = createElement("progress", { "aria-label": item.filename });
      // Indeterminate until the first tick; a settled file is full.
      const fraction = item.upload === undefined ? 1 : item.upload.fraction;
      if (fraction !== null) bar.value = fraction;
      bars.push(bar);
      chip.appendChild(bar);
    }
    strip.appendChild(chip);
  }
  if (!running) return strip;
  if (!signal.aborted) {
    const onTick = (index: number, fraction: number): void => {
      const bar = bars[index];
      if (bar !== undefined) bar.value = fraction;
    };
    const listeners = (entry.listeners ??= new Set());
    listeners.add(onTick);
    signal.addEventListener("abort", () => listeners.delete(onTick), { once: true });
  }
  const cancel = createElement(
    "button",
    {
      class: "msg-upload-cancel",
      type: "button",
      "data-testid": `msg-upload-cancel-${entry.cid}`,
      // Several rows can show "Cancel upload": the row's text tells them apart.
      "aria-describedby": `msg-body-${entry.cid}`,
    },
    sendQueueText("strip.cancel"),
  );
  cancel.addEventListener("click", () => cancelQueuedSend(entry), { signal });
  strip.appendChild(cancel);
  return strip;
}
