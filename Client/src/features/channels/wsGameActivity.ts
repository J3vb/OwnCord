// Game activity and presence handlers, split out of wsHandlers.ts. Plain
// functions; wsHandlers.ts re-exports them for lib/dispatcher.ts.
import {
  updatePresence,
  applyPresenceBatch,
  applyReadyActivities,
  applyReadyListening,
  membersStore,
  toMemberActivity,
  toMemberListening,
} from "../../stores/members.store";
import {
  dmStore,
  setDmActivityLookup,
  setDmListeningLookup,
  updateDmParticipant,
  type DmUser,
} from "../../stores/dm.store";
import { type ReadyActivity, type ReadyListening } from "../../lib/types";
import { applyGameActivityPolicy, gameActivityPolicyIsOff } from "../../lib/net/serverCapabilities";
import type { Payload } from "../connection/dispatchContext";

/**
 * `ready.activities` and `ready.listening`: who plays what
 * and who listens to what right now. Applied after the roster and the DM list
 * are in, so it reaches both copies; a server without the key sends none, and
 * the members then play and listen to nothing.
 */
export function applyReadyGameActivities(payload: Payload<"ready">): void {
  applyGameActivityList(payload.activities ?? [], payload.listening ?? []);
}

/**
 * `game_activity_policy`: an admin turned game activity on or off.
 * The capability follows at once. Off also clears every shown game, so none
 * lingers if a clearing `presence` frame is dropped; on restates nothing,
 * since the games return with presence.
 */
export function handleGameActivityPolicy(payload: Payload<"game_activity_policy">): void {
  if (applyGameActivityPolicy(payload.enabled) && !payload.enabled) applyGameActivityList([], []);
}

/**
 * `auth_ok.game_activity_policy`: the same switch on every connect and resume.
 * A resume gets no `ready` and may have missed the frame while offline. An
 * older server states none, and the `ready` capability decides.
 */
export function applyAuthOkGameActivityPolicy(payload: Payload<"auth_ok">): void {
  if (payload.game_activity_policy !== undefined) {
    handleGameActivityPolicy(payload.game_activity_policy);
  }
}

/**
 * Who plays what, restated from `list`: the roster and the DM copies of it
 * both follow, and a DM opened from now on takes its people's games from the
 * members store.
 */
function applyGameActivityList(
  list: readonly ReadyActivity[],
  songs: readonly ReadyListening[],
): void {
  applyReadyActivities(list);
  applyReadyListening(songs);
  setDmActivityLookup((userId) => membersStore.getState().members.get(userId)?.activity);
  setDmListeningLookup((userId) => membersStore.getState().members.get(userId)?.listening);
  const byUser = new Map(list.map((a) => [a.user_id, toMemberActivity(a)]));
  const songByUser = new Map(songs.map((l) => [l.user_id, toMemberListening(l)]));
  const partners = new Set<number>();
  for (const c of dmStore.getState().channels) {
    partners.add(c.recipient.id);
    for (const p of c.participants) partners.add(p.id);
  }
  for (const id of partners) {
    updateDmParticipant(id, {
      activity: byUser.get(id) ?? null,
      listening: songByUser.get(id) ?? null,
    });
  }
}

export function handlePresence(payload: Payload<"presence">): void {
  // custom_status is passed through verbatim, undefined included: the
  // store treats "field absent" as "leave the text alone", which is what
  // an older server's presence event means.
  // activity follows the same rule: absent leaves the shown game alone.
  // While the server states game activity is off, a game on a frame that
  // outran the off frame is not shown.
  const off = gameActivityPolicyIsOff();
  const activity = off ? null : payload.activity;
  // The same switch covers the song.
  const listening = off ? null : payload.listening;
  updatePresence(
    payload.user_id,
    payload.status,
    payload.custom_status,
    undefined,
    activity,
    listening,
    payload.mobile === true,
  );
  // dmStore keeps its own frozen copy of a DM partner's status for the
  // sidebar row (see buildDmConversations) — membersStore alone does not
  // reach it.
  updateDmParticipant(payload.user_id, {
    status: payload.status,
    mobile: payload.mobile === true,
    ...(activity === undefined ? {} : { activity: toMemberActivity(activity) }),
    ...(listening === undefined ? {} : { listening: toMemberListening(listening) }),
  });
}

export function handlePresenceBatch(payload: Payload<"presence_batch">): void {
  const full = payload.full === true;
  // As in handlePresence: no game is shown while the server states it is off.
  const off = gameActivityPolicyIsOff();
  const updates = off
    ? payload.updates.map((u) => ({ ...u, activity: null, listening: null }))
    : payload.updates;
  applyPresenceBatch(updates, full);
  // Only DM partners need the dmStore copy (see handlePresence); a full
  // snapshot takes a partner it leaves out offline.
  const statuses = new Map(updates.map((u) => [u.user_id, u.status]));
  const activities = new Map(updates.map((u) => [u.user_id, u.activity]));
  const songs = new Map(updates.map((u) => [u.user_id, u.listening]));
  const phones = new Set(updates.filter((u) => u.mobile === true).map((u) => u.user_id));
  const partners = new Set<number>();
  for (const c of dmStore.getState().channels) {
    partners.add(c.recipient.id);
    for (const p of c.participants) partners.add(p.id);
  }
  for (const id of partners) {
    const listed = statuses.has(id);
    const status = statuses.get(id) ?? (full ? "offline" : undefined);
    if (status === undefined) continue;
    const activity = activities.get(id);
    const song = songs.get(id);
    // A partner the snapshot leaves out plays and listens to nothing; an entry
    // without the field (an older server) leaves what is shown alone.
    const patch: Partial<DmUser> = { status, mobile: phones.has(id) };
    if (!listed) {
      updateDmParticipant(id, { ...patch, activity: null, listening: null });
      continue;
    }
    updateDmParticipant(id, {
      ...patch,
      ...(activity === undefined ? {} : { activity: toMemberActivity(activity) }),
      ...(song === undefined ? {} : { listening: toMemberListening(song) }),
    });
  }
}
