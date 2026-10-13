/** Offset added to userId to produce a unique tile ID for screenshare tiles in the video grid. */
export const SCREENSHARE_TILE_ID_OFFSET = 1_000_000;

/**
 * Total participants a group DM holds, creator included. Mirrors
 * `db.MaxGroupDMParticipants` on the server, which is the authority — this
 * copy exists so the picker can refuse a 12th selection without a round trip.
 */
export const MAX_GROUP_DM_PARTICIPANTS = 10;

/** Window event fired after a voice user's local Mute (or a volume of 0)
 *  changes, so the sidebar row and the video tile that show it redraw
 *  (mirrors CHANNEL_MUTE_CHANGED). Detail: `{ userId }`. */
export const USER_LOCAL_MUTE_CHANGED = "owncord:user-local-mute-changed";
