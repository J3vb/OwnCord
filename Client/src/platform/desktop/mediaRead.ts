// The host call behind `mediaDetector`: `detect_media` and the check
// of its answer. Loaded on the first read, not at startup.
import { invoke } from "@tauri-apps/api/core";
import type { MediaPrefs, MediaReading } from "../contracts/mediaDetector";

const UNKNOWN: MediaReading = { state: "unknown" };

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** The host's answer, or `unknown` for anything that is not a well-formed reading. */
function parseReading(raw: unknown): MediaReading {
  if (typeof raw !== "object" || raw === null) return UNKNOWN;
  const r = raw as Record<string, unknown>;
  if (r["state"] === "none") return { state: "none" };
  if (r["state"] !== "playing") return UNKNOWN;
  const { title, artist, player, playerId } = r;
  const positionMs = finiteNonNegative(r["positionMs"]);
  const durationMs = finiteNonNegative(r["durationMs"]);
  if (typeof title !== "string" || title.trim() === "") return UNKNOWN;
  if (typeof player !== "string" || player.trim() === "") return UNKNOWN;
  if (typeof artist !== "string" || typeof playerId !== "string") return UNKNOWN;
  if (positionMs === null || durationMs === null) return UNKNOWN;
  return { state: "playing", title, artist, player, playerId, positionMs, durationMs };
}

/** Ask the host for the song. Never rejects: a failure reads as `unknown`. */
export async function readMedia(prefs: MediaPrefs): Promise<MediaReading> {
  try {
    return parseReading(await invoke<unknown>("detect_media", { prefs }));
  } catch {
    return UNKNOWN;
  }
}
