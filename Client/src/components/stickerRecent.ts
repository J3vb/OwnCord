// stickerRecent — the persisted "recently used" sticker ids. A leaf module, like
// emojiRecent.ts, so the picker (which loads on first use) owns the only reader.
//
// Sticker ids are per-server autoincrement integers and one client talks to
// several servers through one localStorage, so the key carries the server and
// the signed-in user: another server's id 3 must never show up as this one's
// recent sticker.

import { authStore } from "@stores/auth.store";
import { resolveServerUrl } from "@components/message-list/attachments";

const MAX_RECENT = 8;
const RECENT_PREFIX = "owncord:recent-stickers";

function recentKey(): string {
  const userId = authStore.getState().user?.id ?? 0;
  return `${RECENT_PREFIX}:${userId}:${resolveServerUrl("/")}`;
}

function readStored(): number[] {
  try {
    const raw = localStorage.getItem(recentKey());
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is number => typeof e === "number" && Number.isInteger(e));
  } catch {
    return [];
  }
}

/** The recently used sticker ids, newest first. Display only: the caller drops ids the server no longer has. */
export function getRecentStickerIds(): number[] {
  return readStored().slice(0, MAX_RECENT);
}

export function addRecentSticker(id: number): void {
  const recent = readStored().filter((e) => e !== id);
  recent.unshift(id);
  try {
    localStorage.setItem(recentKey(), JSON.stringify(recent.slice(0, MAX_RECENT)));
  } catch {
    // localStorage full or unavailable: the Recent row is a convenience only.
  }
}
