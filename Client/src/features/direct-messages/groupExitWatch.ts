/**
 * Notifies when a group DM leaves `dmStore`: the local user left it or was
 * removed (or a fresh `ready` no longer lists it).
 *
 * The call ring needs this edge, not mere absence. A ring can arrive before its
 * `dm_channel_open`, so "the channel is not in the store" does not mean "you
 * lost it"; only a group that was present and is now gone does. A 1:1 closing is
 * not reported (a closed 1:1 is still a participant in its calls).
 */

import { dmStore } from "../../stores/dm.store";

const groupIds = (): Set<number> =>
  new Set(
    dmStore
      .getState()
      .channels.filter((c) => c.isGroup)
      .map((c) => c.channelId),
  );

/** Subscribe `onExit` to group DMs disappearing from `dmStore`. Returns the unsubscriber. */
export function watchGroupDmExits(onExit: (channelId: number) => void): () => void {
  let known = groupIds();
  return dmStore.subscribe(() => {
    const current = groupIds();
    const gone = [...known].filter((id) => !current.has(id));
    known = current;
    for (const id of gone) onExit(id);
  });
}
