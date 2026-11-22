// The one mutator for whose music you listen to. Kept beside voice.store so
// the store file stays under its size limit; the session is its only writer.
import { voiceStore } from "./voice.store";
import { withListeningTo } from "./voicePeers";

/** The remote sharer whose music you listen to, or null. */
export function setListeningTo(userId: number | null): void {
  voiceStore.setState((prev) => withListeningTo(prev, userId));
}
