/**
 * What a person's camera and screen share may each send under the server's
 * video upload cap. Pure, and free of livekit-client, so the Linux native path
 * can use it too.
 */

/** The camera's share of a server cap that also carries a screen share, never
 *  below this: under it a 360p picture turns to mush. */
export const CAMERA_BUDGET_FLOOR = 300_000;

/** A share's budget must hold its 720p lower layer plus this much for the top
 *  layer before it goes out as simulcast; under that the lower layer would eat
 *  the top one's bitrate, so the share goes out as one layer. */
const SHARE_TOP_LAYER_MIN = 1_000_000;

/** The share's 720p lower layer's rate (`SCREENSHARE_SIMULCAST_LAYERS`). */
const SHARE_LOWER_LAYER = 1_200_000;

/** What each live stream may send, in bits per second, under the server's cap
 *  on a person's video upload (`cap`, 0 = no limit). A budget of 0 means no
 *  limit for that stream. A stream alone gets the whole cap. With both live the
 *  share gets 75% and the camera 25%, the camera never under
 *  CAMERA_BUDGET_FLOOR (taken from the share) and never over half the cap, so
 *  a tiny cap still leaves the share something. */
export function videoBudget(
  cap: number,
  live: { camera: boolean; screen: boolean },
): { camera: number; screen: number } {
  if (!(cap > 0)) return { camera: 0, screen: 0 };
  if (!(live.camera && live.screen)) return { camera: cap, screen: cap };
  const camera = Math.min(
    Math.max(Math.round(cap * 0.25), CAMERA_BUDGET_FLOOR),
    Math.ceil(cap / 2),
  );
  return { camera, screen: Math.max(cap - camera, 1) };
}

/** `rate` held under `budget` (0 = no budget). */
export function budgetedRate(rate: number, budget: number): number {
  return budget > 0 ? Math.min(rate, budget) : rate;
}

/** Whether a share with `budget` has room for its lower layer and a top layer
 *  worth sending (no budget always does). */
export function shareBudgetFitsLayers(budget: number): boolean {
  if (budget <= 0) return true;
  return budget >= SHARE_LOWER_LAYER + SHARE_TOP_LAYER_MIN;
}
