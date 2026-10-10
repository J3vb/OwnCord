import { voiceText } from "../../i18n/voice";
import { joinBackoffFromSwitch, joinRetryInMs } from "./joinBackoff";

// Kept apart from joinBackoff so voice.store (startup closure) can reset the
// backoff without pulling the voice catalog into the startup bundle.

/** Refusal toast text for a join inside the wait, null when it may start. */
export function joinBackoffText(now = Date.now()): string | null {
  const waitMs = joinRetryInMs(now);
  if (waitMs === 0) return null;
  const seconds = Math.ceil(waitMs / 1000);
  return voiceText(joinBackoffFromSwitch() ? "join.switchBackoff" : "join.backoff", { seconds });
}
