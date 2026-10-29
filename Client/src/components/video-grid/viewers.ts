// Who is watching a screen share: the text a tile's viewer badge shows and
// reads out. Pure, so the cap and the wording are testable alone.
import { voiceText } from "../../i18n/voice";

/** Names listed before "and N more". */
export const MAX_VIEWER_NAMES = 10;

/** "Watching: Ann, Bob", or "Watching: Ann, … and 3 more" past ten names. */
export function viewersLabel(names: readonly string[]): string {
  if (names.length <= MAX_VIEWER_NAMES) {
    return voiceText("tile.viewers", { names: names.join(", ") });
  }
  return voiceText("tile.viewersMore", {
    names: names.slice(0, MAX_VIEWER_NAMES).join(", "),
    count: names.length - MAX_VIEWER_NAMES,
  });
}
