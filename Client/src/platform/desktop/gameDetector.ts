// The running game (`src-tauri/src/game_activity.rs`), polled by the game
// activity loop while the sharing setting is on.
import { invoke } from "@tauri-apps/api/core";
import type { DetectedGame, GameDetector } from "../contracts/gameDetector";

const SOURCES: ReadonlySet<string> = new Set(["steam", "epic", "list"]);

/** The host's answer, or null for anything that is not a well-formed game. */
function parseDetected(raw: unknown): DetectedGame | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { name, source, startedAtMs } = raw as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (typeof source !== "string" || !SOURCES.has(source)) return null;
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return null;
  return { name, source: source as DetectedGame["source"], startedAtMs };
}

export const gameDetector: GameDetector = {
  available: true,
  async detect(): Promise<DetectedGame | null> {
    try {
      return parseDetected(await invoke<unknown>("detect_game"));
    } catch {
      // A failed scan is "no game": the webview keeps working without it.
      return null;
    }
  },
};
