// The song playing (`src-tauri/src/media_activity.rs`), polled by the music
// activity loop while the sharing setting is on. The registry reaches this file
// from the entry, so the host call and its parsing load on the first read.
import type { MediaDetector, MediaPrefs, MediaReading } from "../contracts/mediaDetector";

export const mediaDetector: MediaDetector = {
  available: true,
  async detect(prefs: MediaPrefs): Promise<MediaReading> {
    try {
      const { readMedia } = await import("./mediaRead");
      return await readMedia(prefs);
    } catch {
      // A failed read (or a chunk that did not load) is "unknown": the caller
      // keeps what it showed, and the webview keeps working without it.
      return { state: "unknown" };
    }
  },
};
