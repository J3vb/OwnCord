/** The call controls' note while a phone call holds the call (the Android app). */
import { createElement } from "@lib/dom";
import { voiceText } from "../../../i18n/voice";

const NOTE_CLASS = "video-fs-paused";

/** The note for a control bar, hidden until a phone call holds the call. */
export function createPausedNote(): HTMLElement {
  const note = createElement("div", { class: NOTE_CLASS, role: "status" });
  note.hidden = true;
  return note;
}

/** Show `bar`'s note while the call is held. Its text arrives as it shows, so
 *  a screen reader says it. */
export function drawPausedNote(bar: Element, held: boolean): void {
  const note = bar.querySelector<HTMLElement>(`.${NOTE_CLASS}`);
  if (note === null || note.hidden === !held) return;
  note.hidden = !held;
  note.textContent = held ? voiceText("call.pausedForPhoneCall") : "";
  bar.classList.toggle("video-fs-calls--paused", held);
}
