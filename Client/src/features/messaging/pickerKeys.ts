import { isImeCommit } from "@lib/text/ime";
import { isPhoneLayout } from "@lib/ui/bottomSheet";

/** The emoji, GIF and sticker pickers' shared keys: Escape closes the picker,
 *  and the search box takes focus once it is on screen. */
export function wirePickerKeys(
  root: HTMLElement,
  searchInput: HTMLInputElement,
  onClose: () => void,
  signal: AbortSignal,
): void {
  root.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !isImeCommit(e)) {
        e.preventDefault();
        onClose();
      }
    },
    { signal },
  );
  // On a phone the keyboard would cover half the sheet before anyone asked to search.
  requestAnimationFrame(() => {
    if (!signal.aborted && !isPhoneLayout()) searchInput.focus();
  });
}
