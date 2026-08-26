/** Offset added to userId to produce a unique tile ID for screenshare tiles in the video grid. */
export const SCREENSHARE_TILE_ID_OFFSET = 1_000_000;

/**
 * Total participants a group DM holds, creator included. Mirrors
 * `db.MaxGroupDMParticipants` on the server, which is the authority — this
 * copy exists so the picker can refuse a 12th selection without a round trip.
 */
export const MAX_GROUP_DM_PARTICIPANTS = 10;
