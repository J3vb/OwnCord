/**
 * The call view's avatar tiles: everyone in the voice channel, drawn by the
 * video grid while they have no camera tile up.
 */

import type { VoiceUser } from "@stores/voice.store";
import { membersStore, memberDisplayName } from "@stores/members.store";
import { createAvatarElement, pickAvatarColor } from "../../features/profiles/avatar";
import type { GridPerson } from "@components/VideoGrid";
import { shellText } from "../../i18n/shell";

/** Avatar elements by user, kept while their name and picture stay the same:
 *  the grid redraws a tile whose content element changes, which would fetch
 *  the picture again on every roster update. */
export type CallAvatarCache = Map<number, { readonly key: string; readonly el: HTMLElement }>;

export function buildCallPeople(users: Iterable<VoiceUser>, cache: CallAvatarCache): GridPerson[] {
  const members = membersStore.getState().members;
  const seen = new Set<number>();
  const people: GridPerson[] = [];
  for (const user of users) {
    seen.add(user.userId);
    const member = members.get(user.userId);
    const name = (member !== undefined ? memberDisplayName(member) : "") || user.username;
    const avatar = member?.avatar ?? null;
    const key = `${name}|${avatar ?? ""}`;
    let entry = cache.get(user.userId);
    if (entry?.key !== key) {
      entry = {
        key,
        el: createAvatarElement(
          { username: user.username, displayName: name, avatar },
          {
            // The DM call panel's large avatar, which the avatar tile sizes.
            className: "dcp-avatar dcp-avatar--lg",
            background: pickAvatarColor(user.username),
          },
        ),
      };
      cache.set(user.userId, entry);
    }
    people.push({
      userId: user.userId,
      label: name || shellText("common.unknown"),
      content: entry.el,
    });
  }
  for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
  return people;
}
