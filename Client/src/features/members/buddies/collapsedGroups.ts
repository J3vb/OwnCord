/**
 * Which Buddies groups are folded, kept on this device. Every group starts
 * open. The set lives in memory first: a toggle changes it and tells the list
 * before it is saved, so a failed save still folds the group for the session.
 * Other windows' saves arrive through the window `storage` event.
 */

import { loadPref, savePref, STORAGE_PREFIX } from "@lib/prefs/preferences";
import { membersStore } from "@stores/members.store";
import type { MemberListOptions } from "../memberListOptions";
import { ACTIVITY_GROUP_KEYS, groupKeyOf } from "./activityGroups";

export const BUDDIES_COLLAPSED_PREF = "buddiesCollapsed";

export type CollapsedGroups = NonNullable<MemberListOptions["collapse"]>;

/** The stored set, with unknown keys and duplicates dropped. */
function storedSet(): ReadonlySet<string> {
  const stored = loadPref<unknown>(BUDDIES_COLLAPSED_PREF, []);
  if (!Array.isArray(stored)) return new Set();
  const keys: readonly unknown[] = stored;
  return new Set(ACTIVITY_GROUP_KEYS.filter((key) => keys.includes(key)));
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((key) => b.has(key));
}

/** The collapse option for one Buddies list. */
export function createCollapsedGroups(): CollapsedGroups {
  let set = storedSet();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const onChange of listeners) onChange();
  };
  /** Takes the stored set; false, keeping the old object, when it is unchanged. */
  const reload = (): boolean => {
    const next = storedSet();
    if (sameSet(next, set)) return false;
    set = next;
    return true;
  };
  return {
    read: () => set,
    toggle: (key) => {
      const next = new Set(set);
      if (!next.delete(key)) next.add(key);
      set = next;
      notify();
      savePref(BUDDIES_COLLAPSED_PREF, [...next]);
    },
    subscribe: (signal, onChange) => {
      listeners.add(onChange);
      // Another list may have saved since construction; the list drew
      // before subscribing, so it is told.
      if (reload()) onChange();
      signal.addEventListener("abort", () => listeners.delete(onChange), { once: true });
      window.addEventListener(
        "storage",
        (e) => {
          // A null key is a cleared storage.
          if (e.key !== null && e.key !== STORAGE_PREFIX + BUDDIES_COLLAPSED_PREF) return;
          if (reload()) notify();
        },
        { signal },
      );
    },
    groupOf: (id) => {
      const member = membersStore.getState().members.get(id);
      return member === undefined ? null : groupKeyOf(member);
    },
  };
}
