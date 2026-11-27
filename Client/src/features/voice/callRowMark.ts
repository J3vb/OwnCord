/**
 * On `<html>` while the voice widget shows a call. Phone Command Deck hides the
 * other Mute and Leave buttons only then, so a widget that never loads leaves
 * them up.
 */
export const CALL_ROW_CLASS = "voice-widget-up";

export function setCallRow(up: boolean): void {
  document.documentElement.classList.toggle(CALL_ROW_CLASS, up);
}
