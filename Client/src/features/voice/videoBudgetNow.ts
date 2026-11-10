// What a stream may send right now: the server's video upload cap split over
// the streams this person has live. Every publish path reads it here, so the
// first publish, a codec republish and a quality change cannot disagree.
import { voiceStore } from "../../stores/voice.store";
import { budgetedRate, shareBudgetFitsLayers, videoBudget } from "../../lib/voice/videoBudget";
import { videoBitrateCap } from "./videoBitrateCap";

/** Bits per second the camera and the share may each send; 0 means no limit.
 *  A stream that is starting counts as live, so it reserves its part. */
export function liveVideoBudget(): { camera: number; screen: number } {
  const { localCamera, localScreenshare } = voiceStore.getState();
  return videoBudget(videoBitrateCap(), { camera: localCamera, screen: localScreenshare });
}

/** A native share's publish encoding held under the share's budget: the rate
 *  is the lower of the quality's and the budget, and a budget too small for a
 *  lower layer plus a worthwhile top layer goes out as one layer. */
export function budgetedShareEncoding(encoding: {
  readonly maxBitrate: number;
  readonly maxFramerate: number;
  readonly simulcast: boolean;
}): { maxBitrate: number; maxFramerate: number; simulcast: boolean } {
  const budget = liveVideoBudget().screen;
  return {
    maxBitrate: budgetedRate(encoding.maxBitrate, budget),
    maxFramerate: encoding.maxFramerate,
    simulcast: encoding.simulcast && shareBudgetFitsLayers(budget),
  };
}
