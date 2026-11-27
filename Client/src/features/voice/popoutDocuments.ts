/**
 * What else draws into a pop-out window's document (popout.ts): the app's
 * shortcuts reach a focused pop-out this way. A leaf with no imports, so the
 * startup code that registers here does not load the pop-out itself.
 */

type PopoutDocumentHook = (doc: Document, signal: AbortSignal) => void;
const documentHooks = new Set<PopoutDocumentHook>();

/** Run `hook` on every pop-out window's document each time it is drawn, with
 *  the window's lifetime `signal`, until `owner` aborts. */
export function onPopoutDocument(hook: PopoutDocumentHook, owner: AbortSignal): void {
  if (owner.aborted) return;
  documentHooks.add(hook);
  owner.addEventListener("abort", () => documentHooks.delete(hook), { once: true });
}

/** A pop-out window drew into `doc`, which lives until `signal` aborts. */
export function runPopoutDocumentHooks(doc: Document, signal: AbortSignal): void {
  for (const hook of documentHooks) hook(doc, signal);
}
