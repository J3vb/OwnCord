/**
 * One-time move of the saved collapsed-category set from category NAMES to
 * category id keys. Before categories had ids the sidebar saved the collapsed
 * set as category names; a rename then dropped the state. Once the channel list
 * is here, each saved name that belongs to a real category is rewritten to its
 * `cat:<id>` key and the list is saved again, so the state follows the category
 * through a rename and a reconnect.
 */

import { categoryGroups, channelsStore } from "../../stores/channels.store";
import { visibleCategories } from "../../lib/permissions";
import { migrateCollapsedCategoryNames } from "../../stores/ui.store";

/**
 * Translate now when the channel list has arrived. Returns false (and does
 * nothing) while it is still empty, so the caller can try again on the first
 * channels write.
 */
export function migrateCollapsedToCategoryIds(): boolean {
  const { channels } = channelsStore.getState();
  const categories = visibleCategories();
  if (channels.size === 0) return false;
  const keysByName = new Map<string, string>();
  for (const g of categoryGroups(channels, categories)) {
    if (g.categoryId > 0 && g.key !== null && g.name !== null) keysByName.set(g.name, g.key);
  }
  migrateCollapsedCategoryNames(keysByName);
  return true;
}
