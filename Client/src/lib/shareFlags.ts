/**
 * Local screen-share test switches (screen-sharing pipeline plan, PR 2b).
 *
 * A typed allowlist of two local settings. A stored value that is missing,
 * of the wrong type or not on the list reads as the default, so a stale or
 * hand-edited preference can never put a share into an unknown mode.
 */

import { loadPref } from "./preferences";

/** Bumped whenever the meaning of a recorded policy changes. */
export const SHARE_POLICY_VERSION = "2b-1";

export const SHARE_DIAGNOSTICS_KEY = "shareDiagnosticsV2";
export const SHARE_MOTION_POLICY_KEY = "shareMotionPolicy";

/** The plan's E3 arms: content hint (detail/motion) x degradation preference. */
export const SHARE_MOTION_POLICIES = [
  "legacy",
  "detail-balanced",
  "detail-framerate",
  "motion-resolution",
  "motion-balanced",
  "motion-framerate",
] as const;

export type ShareMotionPolicy = (typeof SHARE_MOTION_POLICIES)[number];

/** Record the screen-share timeline locally. Off by default. */
export function getShareDiagnosticsEnabled(): boolean {
  return loadPref<boolean>(SHARE_DIAGNOSTICS_KEY, false) === true;
}

export function isShareMotionPolicy(value: unknown): value is ShareMotionPolicy {
  return typeof value === "string" && (SHARE_MOTION_POLICIES as readonly string[]).includes(value);
}

export function getShareMotionPolicy(): ShareMotionPolicy {
  const stored = loadPref<string>(SHARE_MOTION_POLICY_KEY, "legacy");
  return isShareMotionPolicy(stored) ? stored : "legacy";
}

export interface ShareMotionArm {
  readonly contentHint?: "detail" | "motion";
  readonly degradation?: RTCDegradationPreference;
}

const ARMS: Readonly<Record<ShareMotionPolicy, ShareMotionArm>> = {
  legacy: {},
  "detail-balanced": { contentHint: "detail", degradation: "balanced" },
  "detail-framerate": { contentHint: "detail", degradation: "maintain-framerate" },
  "motion-resolution": { contentHint: "motion", degradation: "maintain-resolution" },
  "motion-balanced": { contentHint: "motion", degradation: "balanced" },
  "motion-framerate": { contentHint: "motion", degradation: "maintain-framerate" },
};

/** What a policy changes about a share. Legacy changes nothing (`{}`). */
export function shareMotionArm(policy: ShareMotionPolicy): ShareMotionArm {
  return ARMS[policy];
}
