/**
 * The eager half of the inline message editor: one cached dynamic
 * import, so the editor and its copy stay out of the main-page chunk until the
 * first edit (or the idle preload after the list mounts).
 */

import { createLogger } from "@lib/logger";

const log = createLogger("inline-edit");

type InlineEditModule = typeof import("./inlineEdit");

let loading: Promise<InlineEditModule> | null = null;

function load(): Promise<InlineEditModule> {
  // A failed load is forgotten, so the next edit tries the import again.
  loading ??= import("./inlineEdit").catch((err: unknown) => {
    loading = null;
    throw err;
  });
  return loading;
}

/** Start fetching the editor so the first ArrowUp opens without a delay. */
export function preloadInlineEdit(): void {
  load().catch((err: unknown) => log.warn("Inline editor preload failed", { error: String(err) }));
}

/** Run `use` with the loaded editor module; a failed load is logged and
 *  reported to `onError`, so the caller can drop what it set up for the edit. */
export function withInlineEdit(use: (edit: InlineEditModule) => void, onError?: () => void): void {
  load()
    .then(use)
    .catch((err: unknown) => {
      log.warn("Inline editor failed to open", { error: String(err) });
      onError?.();
    });
}
