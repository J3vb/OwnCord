// stickerRecent — the persisted "recently used" sticker ids. A leaf module, like
// emojiRecent.ts, so the picker (which loads on first use) owns the only reader.
//
// Sticker ids are per-server autoincrement integers and one client talks to
// several servers through one localStorage, so the key carries the server and
// the signed-in user: another server's id 3 must never show up as this one's
// recent sticker.

import { authStore } from "@stores/auth.store";
import { resolveServerUrl } from "@components/message-list/attachments";
import { loadStoredJson, saveStoredJson } from "@lib/prefs/preferences";

const MAX_RECENT = 8;
const RECENT_PREFIX = "owncord:recent-stickers";

function recentKey(): string {
  const userId = authStore.getState().user?.id ?? 0;
  return `${RECENT_PREFIX}:${userId}:${resolveServerUrl("/")}`;
}

function readRecent(): number[] {
  return loadStoredJson(
    recentKey(),
    (v) =>
      Array.isArray(v)
        ? v.filter((e): e is number => typeof e === "number" && Number.isInteger(e))
        : [],
    [],
  );
}

/** The recently used sticker ids, newest first. Display only: the caller drops ids the server no longer has. */
export function getRecentStickerIds(): number[] {
  return readRecent().slice(0, MAX_RECENT);
}

export function addRecentSticker(id: number): void {
  const recent = readRecent().filter((e) => e !== id);
  recent.unshift(id);
  // Storage full or unavailable: the Recent row is a convenience only.
  saveStoredJson(recentKey(), recent.slice(0, MAX_RECENT));
}
