// How long to wait before the client asks for a fresh state after it learns
// it missed a live update. Resumes close together wait longer, so a server
// that keeps skipping frames is not hit by a tight loop of redials.

import { GAP_RESUME_QUIET_MS, GAP_RESUME_WINDOWS_MS } from "../wsConfig";

export interface GapResumePlan {
  /** Milliseconds to wait before redialling. */
  readonly delay: number;
  /** The back-to-back count to keep: reset to 0 after a quiet minute. */
  readonly streak: number;
}

/** Picks the wait from the jitter window the current streak falls in. */
export function planGapResume(
  streak: number,
  lastResumeAt: number,
  now: number,
  random: number,
): GapResumePlan {
  const kept = now - lastResumeAt > GAP_RESUME_QUIET_MS ? 0 : streak;
  const [min, max] = GAP_RESUME_WINDOWS_MS[Math.min(kept, GAP_RESUME_WINDOWS_MS.length - 1)]!;
  return { delay: min + random * (max - min), streak: kept };
}
