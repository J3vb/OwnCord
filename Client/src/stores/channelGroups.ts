/**
 * How the channel list is grouped for the sidebar and the category pickers:
 * pure functions over a channel map, with no store access. channels.store.ts
 * re-exports these names and supplies the live map.
 */

import { connectText } from "../i18n/connect";
import { isTextLikeChannel } from "@lib/types";
import type { ChannelCategory } from "@lib/types";
import type { Channel } from "./channelModel";

/**
 * The group key (and name) of the synthetic group an uncategorized VOICE
 * channel falls back to.
 *
 * A voice channel groups under whatever category it has — there is no magic
 * name that makes a category "the voice one". Only a voice channel with no
 * category at all needs somewhere to go, and mixing it into the unnamed group
 * next to uncategorized text channels reads as a bug, so it gets this group.
 */
// i18n-exempt: stable group key, not rendered directly; groupLabel() maps it to the channel.voiceCategory catalog entry
export const UNCATEGORIZED_VOICE_CATEGORY = "Voice";

/**
 * A category as a menu or dialog names it. `id` is 0 for "no category" and for
 * a name-only category from a server that sends no ids; `name` is "" for none.
 */
export interface CategoryRef {
  readonly id: number;
  readonly name: string;
}

/** Filed under no category. */
export const NO_CATEGORY: CategoryRef = { id: 0, name: "" };

/** The group key of a real category. Collapse state is keyed by it. */
export function categoryKey(categoryId: number): string {
  return `cat:${categoryId}`;
}

/**
 * One group of the channel list. `key` is stable across a rename: `cat:<id>`
 * for a real category, the category name for a channel from a server that
 * sends no ids (the older-server fallback), `UNCATEGORIZED_VOICE_CATEGORY` for
 * the synthetic voice group and null for uncategorized text.
 */
export interface CategoryGroup {
  readonly key: string | null;
  /** The raw header name; null for uncategorized text. */
  readonly name: string | null;
  /** The category's id; 0 for every group that is not a real category. */
  readonly categoryId: number;
  readonly channels: readonly Channel[];
}

/** The header text for a group; the synthetic voice group reads through the catalog. */
export function groupLabel(group: Pick<CategoryGroup, "key" | "name">): string {
  return group.key === UNCATEGORIZED_VOICE_CATEGORY && group.name === UNCATEGORIZED_VOICE_CATEGORY
    ? connectText("channel.voiceCategory")
    : (group.name ?? "");
}

/** The group key a channel is displayed under. */
export function keyOfChannel(channel: Channel): string | null {
  if ((channel.categoryId ?? 0) > 0) return categoryKey(channel.categoryId ?? 0);
  if (channel.category !== null && channel.category !== "") return channel.category;
  return channel.type === "voice" ? UNCATEGORIZED_VOICE_CATEGORY : null;
}

/** The category header a channel is displayed under (its group key). */
export function displayCategoryOf(channel: Channel): string | null {
  return keyOfChannel(channel);
}

/** The group a channel of this type falls back to when it has no category. */
export function voiceFallback(type: Channel["type"]): string | null {
  return type === "voice" ? UNCATEGORIZED_VOICE_CATEGORY : null;
}

/**
 * The categories a channel can be filed under, in sidebar order, for the
 * create/edit pickers: the real ones (from the manager's list and from the
 * channels) plus, on a server that sends no ids, the free-text names in use.
 */
export interface KnownCategory {
  /** 0 for a legacy name-only category. */
  readonly id: number;
  readonly name: string;
}

/**
 * Group channels by category in sidebar order: uncategorized text first,
 * then the synthetic Voice group, then categories by (category position, id),
 * then any name-only categories from a server that sends no ids, in the order
 * of their first channel. Channels inside a group are sorted by (position, id)
 * — the server's `ORDER BY position, id` — with text-type channels before
 * voice.
 *
 * `categories` is the manager's list (callers pass `visibleCategories()`, which is
 * empty once the viewer has lost MANAGE_CHANNELS): it adds the categories with no channel
 * and is authoritative for the name and position of the ones that have some.
 * A non-manager passes none, and a channel whose category the list never named
 * still draws its group from the channel's own category fields.
 */
export function categoryGroups(
  channels: ReadonlyMap<number, Channel>,
  categories: readonly ChannelCategory[] = [],
): CategoryGroup[] {
  type Draft = {
    key: string | null;
    name: string | null;
    categoryId: number;
    rank: number;
    sortPosition: number;
    order: number;
    channels: Channel[];
  };
  const sorted = [...channels.values()]
    // DM channels are shown in the DM sidebar, not the channel list
    .filter((channel) => channel.type !== "dm")
    .toSorted((a, b) => a.position - b.position || a.id - b.id);
  const drafts = new Map<string | null, Draft>();
  const draftFor = (key: string | null, make: () => Omit<Draft, "order" | "channels">): Draft => {
    const found = drafts.get(key);
    if (found !== undefined) return found;
    const draft: Draft = { ...make(), order: drafts.size, channels: [] };
    drafts.set(key, draft);
    return draft;
  };
  for (const channel of sorted) {
    const key = keyOfChannel(channel);
    const id = channel.categoryId ?? 0;
    const draft = draftFor(key, () => {
      if (key === null) return { key, name: null, categoryId: 0, rank: 0, sortPosition: 0 };
      if (key === UNCATEGORIZED_VOICE_CATEGORY && id <= 0 && (channel.category ?? "") === "") {
        return { key, name: key, categoryId: 0, rank: 1, sortPosition: 0 };
      }
      if (id > 0) {
        return {
          key,
          name: channel.category ?? "",
          categoryId: id,
          rank: 2,
          sortPosition: channel.categoryPosition ?? 0,
        };
      }
      return { key, name: key, categoryId: 0, rank: 3, sortPosition: 0 };
    });
    draft.channels.push(channel);
  }
  for (const category of categories) {
    const draft = draftFor(categoryKey(category.id), () => ({
      key: categoryKey(category.id),
      name: category.name,
      categoryId: category.id,
      rank: 2,
      sortPosition: category.position,
    }));
    draft.name = category.name;
    draft.sortPosition = category.position;
  }
  return [...drafts.values()]
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        (a.rank === 2 ? a.sortPosition - b.sortPosition || a.categoryId - b.categoryId : 0) ||
        a.order - b.order,
    )
    .map((draft) => ({
      key: draft.key,
      name: draft.name,
      categoryId: draft.categoryId,
      // Text-type channels (text, announcement) come before voice inside each
      // group, each kind keeping its position order (a stable partition).
      channels: draft.channels.toSorted(
        (a, b) => Number(a.type === "voice") - Number(b.type === "voice"),
      ),
    }));
}

/**
 * The first text-like channel the channel list draws, walking the groups in
 * sidebar order. Where the app lands when it has to pick a channel itself:
 * after sign-in, after the open channel is deleted, after the open DM closes.
 */
export function firstTextInSidebarOrder(
  channels: ReadonlyMap<number, Channel>,
): Channel | undefined {
  for (const group of categoryGroups(channels)) {
    const first = group.channels.find((ch) => isTextLikeChannel(ch));
    if (first !== undefined) return first;
  }
  return undefined;
}

/** `getChannelsByCategory` over a channel map the caller already holds. */
export function groupChannelsByCategory(
  channels: ReadonlyMap<number, Channel>,
  categories: readonly ChannelCategory[],
): Map<string | null, readonly Channel[]> {
  return new Map(categoryGroups(channels, categories).map((g) => [g.key, g.channels]));
}
