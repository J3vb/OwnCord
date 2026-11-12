/**
 * In-place refresh of a message row whose only change is what the live parts
 * draw: its reactions and its pin state. The row keeps its DOM node, so a
 * playing voice message or video, a YouTube player and a revealed spoiler in it
 * survive a reaction or a pin.
 */
import { Disposable } from "@lib/disposable";
import type { Message } from "@stores/messages.store";
import { isServerRowKind } from "@lib/text/messageKind";
import type { MessageRenderOptions } from "./messageRenderOptions";
import { renderReactions } from "./reactions";
import { ensureActionsBar, hasShellBar, renderActionsBar } from "./messageActionBar";

/** The fields a row draws from its reactions and pin state; every other field
 *  is drawn into the row's body and rebuilds it when it differs. */
const LIVE_FIELDS: ReadonlySet<keyof Message> = new Set<keyof Message>(["reactions", "pinned"]);

/**
 * Whether `was` and `now` differ only in reactions and/or pin state (and are an
 * ordinary message, not a server-written row). Compares the fields instead of
 * the object identity, which a reaction reducer always replaces.
 */
export function differsOnlyInLiveFields(was: Message, now: Message): boolean {
  if (isServerRowKind(now.kind) || (now.user.id === 0 && now.user.username === "System")) {
    return false;
  }
  const keys = new Set([...Object.keys(was), ...Object.keys(now)] as (keyof Message)[]);
  for (const key of keys) {
    if (!LIVE_FIELDS.has(key) && was[key] !== now[key]) return false;
  }
  return true;
}

/** Listeners of the live parts drawn by the last refresh of a row. */
const scopes = new WeakMap<HTMLElement, Disposable>();

function openScope(row: HTMLElement, rowSignal: AbortSignal): Disposable {
  scopes.get(row)?.destroy();
  const scope = new Disposable();
  rowSignal.addEventListener("abort", () => scope.destroy(), { once: true, signal: scope.signal });
  scopes.set(row, scope);
  return scope;
}

function refreshReactions(
  row: HTMLElement,
  now: Message,
  opts: MessageRenderOptions,
  signal: AbortSignal,
): void {
  const old = row.querySelector<HTMLElement>(":scope > .msg-reactions");
  const fresh = now.reactions.length > 0 ? renderReactions(now, opts, signal) : null;
  if (old !== null) {
    if (fresh === null) old.remove();
    else old.replaceWith(fresh);
  } else if (fresh !== null) {
    // Reactions end the body, ahead of the hover bar.
    row.insertBefore(fresh, row.querySelector(":scope > .msg-actions-bar"));
  }
}

/** The bar's pin button and its quick reactions (a message at the reaction cap
 *  leaves the unused ones out) are drawn from the message, so redraw the bar. */
function refreshActionsBar(
  row: HTMLElement,
  now: Message,
  opts: MessageRenderOptions,
  signal: AbortSignal,
): void {
  const old = row.querySelector<HTMLElement>(":scope > .msg-actions-bar");
  if (old === null) return;
  const wasFilled = !hasShellBar(row);
  const fresh = renderActionsBar(row, now, opts, signal);
  old.replaceWith(fresh);
  if (wasFilled) ensureActionsBar(row);
}

/** Redraw `row`'s reactions and hover bar from `now`, keeping the rest of it. */
export function refreshLiveParts(
  row: HTMLElement,
  was: Message,
  now: Message,
  opts: MessageRenderOptions,
  rowSignal: AbortSignal,
): void {
  const scope = openScope(row, rowSignal);
  if (was.reactions !== now.reactions) refreshReactions(row, now, opts, scope.signal);
  refreshActionsBar(row, now, opts, scope.signal);
}
