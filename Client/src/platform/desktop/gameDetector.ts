// The running game (`src-tauri/src/game_activity.rs`), polled by the game
// activity loop while the sharing setting is on.
import { invoke } from "@tauri-apps/api/core";
import type {
  DetectedGame,
  DetectPrefs,
  GameDetector,
  RunningProgram,
} from "../contracts/gameDetector";

const SOURCES: ReadonlySet<string> = new Set([
  "steam",
  "epic",
  "gog",
  "battlenet",
  "lutris",
  "list",
  "manual",
]);

/** The host's answer, or null for anything that is not a well-formed game. */
function parseDetected(raw: unknown): DetectedGame | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { name, source, startedAtMs } = raw as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") return null;
  if (typeof source !== "string" || !SOURCES.has(source)) return null;
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return null;
  return { name, source: source as DetectedGame["source"], startedAtMs };
}

/** Programs kept from a host answer: both fields non-empty strings. */
function parsePrograms(raw: unknown): RunningProgram[] {
  if (!Array.isArray(raw)) return [];
  const out: RunningProgram[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { name, path } = item as Record<string, unknown>;
    if (typeof name !== "string" || typeof path !== "string") continue;
    if (name.trim() === "" || path.trim() === "") continue;
    out.push({ name, path });
  }
  return out;
}

export const gameDetector: GameDetector = {
  available: true,
  async detect(prefs?: DetectPrefs): Promise<DetectedGame | null> {
    try {
      const raw =
        prefs === undefined
          ? await invoke<unknown>("detect_game")
          : await invoke<unknown>("detect_game", { prefs });
      return parseDetected(raw);
    } catch {
      // A failed scan is "no game": the webview keeps working without it.
      return null;
    }
  },
  async listRunningPrograms(): Promise<readonly RunningProgram[]> {
    try {
      return parsePrograms(await invoke<unknown>("list_running_programs"));
    } catch {
      // No list is an empty picker: the webview keeps working without it.
      return [];
    }
  },
};
