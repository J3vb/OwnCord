/**
 * Stickers store — the server's custom-sticker set.
 *
 * Loaded once from GET /api/v1/stickers when the session goes ready (only on a
 * server that advertises the `stickers` capability), then replaced wholesale on
 * every `sticker_update` broadcast, for the same reason emoji are: a dropped
 * intermediate event can never leave a deleted sticker in the picker.
 *
 * Session-scoped: `clearStickers` is registered with the session registry, so a
 * logout or a switch to another server never shows the previous server's set.
 */

import { createStore } from "@lib/store";
import { registerSessionReset } from "@lib/net/sessionRegistry";

/** One custom sticker as the server describes it. */
export interface Sticker {
  readonly id: number;
  readonly name: string;
  /** The related emoji search also matches, or null. */
  readonly emoji: string | null;
  /** Server-relative image path, e.g. "/api/v1/stickers/3/image". */
  readonly url: string;
}

export interface StickersState {
  /** The set in server order. */
  readonly stickers: readonly Sticker[];
  /**
   * Bumped by every write (including a clear), so a GET answering a question
   * that is no longer current can be dropped: see `setStickers`.
   */
  readonly rev: number;
  /** Whether the server's set has arrived since the last clear. */
  readonly loaded: boolean;
}

const INITIAL: StickersState = { stickers: [], rev: 0, loaded: false };

export const stickersStore = createStore<StickersState>(INITIAL);

/**
 * Replace the whole set (from the REST list or a `sticker_update`).
 *
 * `rev`, when given, must match the store's current `rev`: the revision the
 * caller saw right before starting the fetch this reply answers. A mismatch
 * means a `sticker_update` (or a session reset) landed while the GET was in
 * flight, so the reply is stale and is skipped. Omit `rev` to always apply:
 * the broadcast handler's unconditional call is what bumps the revision.
 */
export function setStickers(list: readonly Sticker[], rev?: number): void {
  const next: Sticker[] = [];
  const seen = new Set<number>();
  for (const s of list) {
    // A malformed entry must not break the picker for everyone.
    if (typeof s?.id !== "number" || typeof s.name !== "string" || typeof s.url !== "string") {
      continue;
    }
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    next.push({
      id: s.id,
      name: s.name,
      emoji: typeof s.emoji === "string" && s.emoji !== "" ? s.emoji : null,
      url: s.url,
    });
  }
  stickersStore.setState((prev) => {
    if (rev !== undefined && rev !== prev.rev) return prev;
    return { stickers: next, rev: prev.rev + 1, loaded: true };
  });
}

/**
 * Drop every sticker (logout, or a switch to another server). Bumps `rev`
 * rather than resetting it, so a GET still in flight from the old session
 * cannot match the next session's snapshot and bring the old set back.
 */
export function clearStickers(): void {
  stickersStore.setState((prev) => ({ ...INITIAL, rev: prev.rev + 1 }));
}
void registerSessionReset("stickers:store", clearStickers); // app-lifetime

/** The whole set, for the picker. */
export function listStickers(): readonly Sticker[] {
  return stickersStore.getState().stickers;
}

/** The sticker with this id, or null (deleted, or another server's). */
export function findSticker(id: number): Sticker | null {
  return stickersStore.getState().stickers.find((s) => s.id === id) ?? null;
}

/** Whether the set has arrived since the last session reset. */
export function stickersLoaded(): boolean {
  return stickersStore.getState().loaded;
}
