// Shares from other apps on the Android app, loaded on the first subscription.
// `ShareInPlugin.kt` copies a share's files into the app's cache as it
// arrives; `take_shared` (share_in.rs) hands the share over once, its files
// staged for `read_staged_file` like a Linux drop. A share brings the app to
// the front, so the page asks at subscription (the app started from the share
// sheet) and on every return to the app, and again every half second while
// the host says a copy is still running.
import { Disposable } from "@lib/disposable";
import { setOwnedTimeout } from "@lib/dom";
import { createLogger } from "@lib/logger";
import { toNativeFiles } from "./nativeFilesHost";
import { tryInvoke } from "./nativeInvoke";
import type { NativeFile } from "../contracts/nativeFiles";
import type { ReceivedShare } from "../contracts/shareSheet";

const log = createLogger("share-in");

// i18n-exempt: internal error, never rendered; the composer refuses the file by size first
const TOO_LARGE = "shared file too large";

function oversizedFiles(raw: unknown): NativeFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const r = entry as Record<string, unknown>;
    const name = r["name"];
    const size = r["size"];
    if (typeof name !== "string" || name === "" || typeof size !== "number") return [];
    return [{ name, size, read: () => Promise.reject(new Error(TOO_LARGE)) }];
  });
}

/** The host's answer as a share; null when there was none or it is empty. */
export function parseShare(raw: unknown): ReceivedShare | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const text = typeof r["text"] === "string" ? r["text"] : "";
  const files = [...toNativeFiles(r["files"]), ...oversizedFiles(r["oversized"])];
  if (files.length === 0 && text === "") return null;
  return { files, text };
}

/** How often the page asks again while the host is still copying a share. */
export const COPY_POLL_MS = 500;
/** Gives up after two minutes of copying (a 1 GB video on a slow phone fits). */
const MAX_COPY_POLLS = 240;

export function listenForShares(handler: (share: ReceivedShare) => void): () => void {
  const owner = new Disposable();
  const { signal } = owner;
  let polls = 0;
  let cancelRetry: (() => void) | null = null;
  const take = async (): Promise<void> => {
    cancelRetry?.();
    cancelRetry = null;
    const result = await tryInvoke<unknown>("take_shared");
    if (signal.aborted) return;
    if (!result.ok) {
      log.warn("Shared content not taken", result.error.message);
      return;
    }
    const answer: Record<string, unknown> =
      typeof result.value === "object" && result.value !== null
        ? (result.value as Record<string, unknown>)
        : {};
    const share = parseShare(answer["share"]);
    if (share !== null) {
      polls = 0;
      handler(share);
    }
    if (answer["copying"] !== true) {
      polls = 0;
    } else if (polls < MAX_COPY_POLLS) {
      polls += 1;
      cancelRetry = setOwnedTimeout(signal, () => void take(), COPY_POLL_MS);
    }
  };
  // Sharing to the app brings it to the front: that is when a share arrives.
  const onVisible = (): void => {
    if (document.visibilityState === "visible") void take();
  };
  document.addEventListener("visibilitychange", onVisible, { signal });
  void take();
  return () => owner.destroy();
}
