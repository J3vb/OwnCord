/**
 * The forum settings editor's model: a draft of a forum's tags and
 * settings, the server's limits mirrored for early feedback, the merge of a
 * live `channel_update` into an unsaved draft, and the PUT body. Pure data,
 * no DOM and no store.
 *
 * The write is a full replace (`PUT .../channels/{id}/forum`): a tag listed
 * with its id is renamed in place, a tag without one is created, a tag of the
 * forum that the list leaves out is deleted along with its links to posts, and
 * the list order is the display order. So a draft row keeps the tag's server id
 * through every rename and move, and a live change by another admin is merged
 * into the draft by id rather than overwritten when this admin saves.
 */

import type { ForumSettings, ForumSettingsBody, ThreadAutoArchiveMinutes } from "@lib/types";

/** Server limits (Server/service/forum_settings.go, validateEmoji). */
export const MAX_FORUM_TAGS = 20;
export const MAX_FORUM_TAG_NAME = 20;
/** A reaction emoji: a shortcode of at most 32 characters plus two colons. */
export const MAX_FORUM_TAG_EMOJI = 34;

export interface DraftTag {
  /** The server's tag id; 0 for a tag not saved yet. */
  readonly id: number;
  /** A client-only key, stable across edits, so rows keep identity in the DOM. */
  readonly key: number;
  readonly name: string;
  readonly emoji: string;
}

export interface ForumDraft {
  readonly tags: readonly DraftTag[];
  readonly requireTag: boolean;
  readonly autoArchive: ThreadAutoArchiveMinutes;
}

let nextKey = 1;
export const newRowKey = (): number => nextKey++;

const runes = (s: string): number => Array.from(s).length;

/** The server refuses control characters in an emoji. */
const hasControl = (s: string): boolean =>
  Array.from(s).some((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });

/** A draft that states exactly what the server states. */
export function draftFromForum(forum: ForumSettings): ForumDraft {
  return {
    tags: forum.tags
      .toSorted((a, b) => a.position - b.position)
      .map((t) => ({ id: t.id, key: newRowKey(), name: t.name, emoji: t.emoji ?? "" })),
    requireTag: forum.require_tag,
    autoArchive: forum.default_auto_archive_minutes,
  };
}

/** Structural equality ignoring row keys, for dirty checks and echo detection. */
export function sameDraft(a: ForumDraft, b: ForumDraft): boolean {
  return (
    a.requireTag === b.requireTag &&
    a.autoArchive === b.autoArchive &&
    a.tags.length === b.tags.length &&
    a.tags.every((t, i) => {
      const o = b.tags[i];
      return o !== undefined && t.id === o.id && t.name === o.name && t.emoji === o.emoji;
    })
  );
}

/** A tag row that went out in a save without an id: its row key and its place in the list. */
export interface SentNewTag {
  readonly key: number;
  readonly index: number;
}

/** The new rows of a draft, as the save sends them (for matching the echo by place, not by name). */
export function sentNewTags(draft: ForumDraft): SentNewTag[] {
  return draft.tags.flatMap((t, index) => (t.id === 0 ? [{ key: t.key, index }] : []));
}

/**
 * Fold a new server state into a draft the admin has edited. `base` is the
 * state the draft started from and `next` the state that just arrived.
 *
 * - A tag the admin did not touch takes the server's name and emoji, so another
 *   admin's rename is not reverted by this admin's next full-replace save.
 * - A tag the admin edited keeps the admin's name and emoji.
 * - If the admin did not reorder, the server's order is adopted (unsaved rows
 *   stay at the end); otherwise the admin's order wins and a tag another admin
 *   added is appended.
 * - A tag another admin removed leaves the draft unless this admin edited it
 *   (then it is kept and recreated on save).
 * - `sent` names the rows of this admin's own save that had no id: the server's
 *   new tags at those places are the echo and give those rows their ids, whatever
 *   the rows are called now. An echoed tag whose row was removed meanwhile is dropped.
 * - Toggle and period follow the server unless the admin changed them.
 */
export function mergeRemote(
  draft: ForumDraft,
  base: ForumDraft,
  next: ForumDraft,
  sent: readonly SentNewTag[] = [],
): ForumDraft {
  const baseById = new Map(base.tags.filter((t) => t.id !== 0).map((t) => [t.id, t]));
  const nextById = new Map(next.tags.map((t) => [t.id, t]));
  const kept: DraftTag[] = [];
  for (const t of draft.tags) {
    const was = baseById.get(t.id);
    const gone = t.id !== 0 && was !== undefined && !nextById.has(t.id);
    const edited = was !== undefined && (was.name !== t.name || was.emoji !== t.emoji);
    if (gone && !edited) continue;
    const theirs = nextById.get(t.id);
    if (gone) kept.push({ ...t, id: 0 });
    else if (theirs !== undefined && !edited) {
      kept.push({ ...t, name: theirs.name, emoji: theirs.emoji });
    } else kept.push(t);
  }
  const byKey = new Map(kept.map((t) => [t.key, t]));
  const known = new Set(kept.map((t) => t.id));
  const added: DraftTag[] = [];
  next.tags.forEach((t, index) => {
    if (known.has(t.id) || baseById.has(t.id)) return;
    const echo = sent.find((n) => n.index === index);
    const row = echo === undefined ? undefined : byKey.get(echo.key);
    if (row !== undefined && row.id === 0) byKey.set(row.key, { ...row, id: t.id });
    else if (echo === undefined) added.push(t);
  });
  const rows = kept.map((t) => byKey.get(t.key) ?? t);
  // Untouched order: the draft's saved tags are the base's, in the base's order.
  const savedIds = draft.tags.filter((t) => baseById.has(t.id)).map((t) => t.id);
  const baseIds = base.tags.map((t) => t.id).filter((id) => savedIds.includes(id));
  const reordered = savedIds.some((id, i) => id !== baseIds[i]);
  let tags: DraftTag[];
  if (reordered) {
    tags = [...rows, ...added];
  } else {
    const byId = new Map(rows.filter((t) => t.id !== 0).map((t) => [t.id, t]));
    const fromServer = next.tags.flatMap((t) => {
      const row = byId.get(t.id);
      if (row !== undefined) return [row];
      const mine = added.find((a) => a.id === t.id);
      return mine === undefined ? [] : [mine];
    });
    tags = [...fromServer, ...rows.filter((t) => t.id === 0)];
  }
  return {
    tags,
    requireTag: draft.requireTag !== base.requireTag ? draft.requireTag : next.requireTag,
    autoArchive: draft.autoArchive !== base.autoArchive ? draft.autoArchive : next.autoArchive,
  };
}

export type DraftProblem =
  | { readonly kind: "name"; readonly key: number }
  | { readonly kind: "duplicate"; readonly key: number }
  | { readonly kind: "emoji"; readonly key: number }
  | { readonly kind: "count" };

/** The first thing the server would refuse, so the form can say it without a round trip. */
export function validateDraft(draft: ForumDraft): DraftProblem | null {
  if (draft.tags.length > MAX_FORUM_TAGS) return { kind: "count" };
  const seen = new Set<string>();
  for (const t of draft.tags) {
    const name = t.name.trim();
    if (name === "" || runes(name) > MAX_FORUM_TAG_NAME) return { kind: "name", key: t.key };
    const lower = name.toLowerCase();
    if (seen.has(lower)) return { kind: "duplicate", key: t.key };
    seen.add(lower);
    const emoji = t.emoji.trim();
    if (emoji !== "" && (runes(emoji) > MAX_FORUM_TAG_EMOJI || hasControl(emoji))) {
      return { kind: "emoji", key: t.key };
    }
  }
  return null;
}

/** The PUT body: the whole settings, tag order as the list order, ids kept. */
export function toBody(draft: ForumDraft): ForumSettingsBody {
  return {
    tags: draft.tags.map((t) => {
      const emoji = t.emoji.trim();
      return {
        ...(t.id !== 0 ? { id: t.id } : {}),
        name: t.name.trim(),
        ...(emoji !== "" ? { emoji } : {}),
      };
    }),
    require_tag: draft.requireTag,
    default_auto_archive_minutes: draft.autoArchive,
  };
}
