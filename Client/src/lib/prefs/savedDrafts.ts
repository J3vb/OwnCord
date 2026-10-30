/**
 * Composer drafts kept across a restart: the text and the reply target per
 * channel, never attachments. Channel and message ids are per server and the
 * same machine may sign in as several people, so the key carries both the
 * server host and the user id. Reads are advisory: a corrupt or foreign entry
 * is ignored rather than guessed at.
 */

import type { ReplyTarget } from "@components/MessageInput";
import { loadStoredJson, removeStored, saveStoredJson } from "./preferences";

const KEY_PREFIX = "owncord:drafts:";
/** Oldest entries go first once a scope holds this many drafts. */
const MAX_DRAFTS = 50;
/** A draft nobody came back to in this long is dropped on the next read. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Twice the message limit: a longer draft can never send, and 50 of them
 *  would crowd the storage quota every other setting shares. */
const MAX_SAVED_LENGTH = 8000;

export interface SavedDraft {
  readonly content: string;
  readonly replyTo: ReplyTarget | null;
}

interface StoredDraft {
  readonly content: string;
  readonly replyTo?: ReplyTarget;
  readonly savedAt: number;
}

function keyFor(host: string, userId: number): string {
  return `${KEY_PREFIX}${host}:${userId}`;
}

function isReplyTarget(v: unknown): v is ReplyTarget {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    Number.isSafeInteger(r.messageId) &&
    typeof r.username === "string" &&
    (r.ping === undefined || typeof r.ping === "boolean") &&
    (r.self === undefined || typeof r.self === "boolean")
  );
}

function isStoredDraft(v: unknown): v is StoredDraft {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.content === "string" &&
    typeof d.savedAt === "number" &&
    (d.replyTo === undefined || isReplyTarget(d.replyTo))
  );
}

/** Unavailable or corrupt storage reads as no drafts. */
function readAll(key: string, now: number): Map<string, StoredDraft> {
  return loadStoredJson(
    key,
    (parsed) => {
      const out = new Map<string, StoredDraft>();
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
      // Object keys that look like numbers come back in numeric order, so the
      // save order is rebuilt from savedAt: oldest first, for the trim in saveDraft.
      const live = Object.entries(parsed).filter(
        (e): e is [string, StoredDraft] => isStoredDraft(e[1]) && now - e[1].savedAt < MAX_AGE_MS,
      );
      live.sort((a, b) => a[1].savedAt - b[1].savedAt);
      for (const [channel, draft] of live) out.set(channel, draft);
      return out;
    },
    new Map<string, StoredDraft>(),
  );
}

/** Full or disabled storage: the in-memory draft still covers a switch. */
function writeAll(key: string, drafts: Map<string, StoredDraft>): void {
  if (drafts.size === 0) removeStored(key);
  else saveStoredJson(key, Object.fromEntries(drafts));
}

/** The saved draft for a channel, or null when there is none. */
export function loadSavedDraft(host: string, userId: number, channelId: number): SavedDraft | null {
  const draft = readAll(keyFor(host, userId), Date.now()).get(String(channelId));
  if (draft === undefined) return null;
  return { content: draft.content, replyTo: draft.replyTo ?? null };
}

/** Save a channel's draft; an empty or oversized one removes it. */
export function saveDraft(
  host: string,
  userId: number,
  channelId: number,
  draft: SavedDraft,
): void {
  const key = keyFor(host, userId);
  const now = Date.now();
  const drafts = readAll(key, now);
  const channel = String(channelId);
  // Re-inserted, so the map's order stays oldest first for the trim below.
  drafts.delete(channel);
  const keep =
    (draft.content !== "" || draft.replyTo !== null) && draft.content.length <= MAX_SAVED_LENGTH;
  if (keep) {
    drafts.set(channel, {
      content: draft.content,
      ...(draft.replyTo === null ? {} : { replyTo: draft.replyTo }),
      savedAt: now,
    });
  }
  for (const oldest of drafts.keys()) {
    if (drafts.size <= MAX_DRAFTS) break;
    drafts.delete(oldest);
  }
  writeAll(key, drafts);
}
