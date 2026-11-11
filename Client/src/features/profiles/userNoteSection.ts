/**
 * The viewer's private note section of the user profile popup: a textarea that
 * loads (or reads) the saved note, saves as the viewer types, and shows a line
 * when a save failed.
 */
import { createElement, appendChildren, setText } from "@lib/dom";
import { requestsText } from "../../i18n/requests";
import { NOTE_MAX_LENGTH, type NoteBinding } from "./userNotes";

export interface NoteSectionDeps {
  /** Aborts when the popup closes: ends the listeners and drops a late load. */
  readonly signal: AbortSignal;
  /** The error line changed the card's height; keep it on screen. */
  readonly onLayoutChange: () => void;
}

/** Private to the viewer, saved as they type. Empty without a binding. */
export function buildNoteSection(
  note: NoteBinding | undefined,
  deps: NoteSectionDeps,
): HTMLDivElement {
  const noteSection = createElement("div", {
    class: "upp-note",
    "data-testid": "upp-note-section",
  });
  if (note === undefined) return noteSection;
  const { signal } = deps;
  const noteTitle = createElement(
    "div",
    { class: "upp-section-title" },
    requestsText("profile.note"),
  );
  const noteInput = createElement("textarea", {
    class: "upp-note-input",
    placeholder: requestsText("profile.notePlaceholder"),
    "aria-label": requestsText("profile.note"),
    "data-testid": "upp-note",
    maxlength: String(NOTE_MAX_LENGTH),
    rows: "2",
  });
  const noteError = createElement("div", {
    class: "upp-note-error",
    role: "status",
    "data-testid": "upp-note-error",
  });
  let noteDirty = false;
  if (note.remote) {
    void note.load(signal).then(
      (text) => {
        if (!noteDirty && !signal.aborted) noteInput.value = text;
      },
      () => undefined,
    );
  } else {
    noteInput.value = note.readLocal();
  }
  note.onFailedChange((failed) => {
    setText(noteError, failed ? requestsText("profile.noteNotSaved") : "");
    deps.onLayoutChange();
  });
  noteInput.addEventListener(
    "input",
    () => {
      noteDirty = true;
      note.change(noteInput.value);
    },
    { signal },
  );
  noteInput.addEventListener("blur", () => note.flush(), { signal });
  appendChildren(noteSection, noteTitle, noteInput, noteError);
  return noteSection;
}
