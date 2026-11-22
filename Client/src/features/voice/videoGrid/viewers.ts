// Who is watching a screen share: the text a tile's viewer badge shows and
// reads out. Pure, so the cap and the wording are testable alone.
import { voiceText } from "../../../i18n/voice";

/** Names listed before "and N more". */
export const MAX_VIEWER_NAMES = 10;

type LabelKey = Parameters<typeof voiceText>[0];

function capped(names: readonly string[], whole: LabelKey, more: LabelKey): string {
  if (names.length <= MAX_VIEWER_NAMES) return voiceText(whole, { names: names.join(", ") });
  return voiceText(more, {
    names: names.slice(0, MAX_VIEWER_NAMES).join(", "),
    count: names.length - MAX_VIEWER_NAMES,
  });
}

/** "Watching: Ann, Bob", or "Watching: Ann, … and 3 more" past ten names. */
export function viewersLabel(names: readonly string[]): string {
  return capped(names, "tile.viewers", "tile.viewersMore");
}

/** "Listening: Ann, you", or "Listening: Ann, … and 3 more" past ten names:
 *  the line under a music tile's disc. */
export function listenersLabel(names: readonly string[]): string {
  return capped(names, "tile.listeners", "tile.listenersMore");
}
