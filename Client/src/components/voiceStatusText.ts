/**
 * Pure voice-status helpers shared by always-loaded code (MainPage,
 * DmCallPanel) and the lazily loaded VoiceWidget. Kept apart so a
 * caller does not pull the widget into the main-page chunk.
 */

import type { VoiceStatus } from "@stores/voice.store";
import { voiceText as t } from "../i18n/voice";

/** Header status text per voice-session lifecycle state
 *  (docs/architecture/ux/voice-and-e2ee.md §2). */
export function headerStatusText(status: VoiceStatus): string {
  // i18n-exempt: catalog key assembled from the VoiceStatus wire value
  return t(`status.${status}`);
}

/** The join has not reached the room yet: camera and share have nothing to attach to. */
export function isConnecting(status: VoiceStatus): boolean {
  return status === "joining" || status === "securing";
}

/** Format milliseconds elapsed into HH:MM:SS or MM:SS. */
export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${String(h).padStart(2, "0")}:${mm}:${ss}` : `${mm}:${ss}`;
}
