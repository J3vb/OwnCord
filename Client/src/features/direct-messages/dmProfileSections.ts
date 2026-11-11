// The note, Report and Block sections of the DM profile panel body, drawn into
// the content element createDmProfileSidebar builds. Listeners die with the
// body's signal.
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { blocksStore } from "@stores/blocks.store";
import { shellText } from "../../i18n/shell";
import { requestsText } from "../../i18n/requests";
import { reportEntryText } from "../../i18n/reportEntry";
import { NOTE_MAX_LENGTH, createNoteBinding, type NotesContext } from "../profiles/userNotes";
import type { DmProfileSidebarOptions } from "./dmProfileTypes";

/** Divider between the sections of the panel body. */
export const makeDivider = (): HTMLDivElement => createElement("div", { class: "dps-divider" });

interface NoteSectionContext {
  readonly userId: number;
  readonly host: string;
  readonly notes: NotesContext | undefined;
  /** The panel's own lifetime: the note's server session when no context was given. */
  readonly signal: AbortSignal;
  /** The body's lifetime: ends on close or a switch to another DM. */
  readonly contentSignal: AbortSignal;
}

/** The private note: on the server when it keeps notes, else localStorage. */
export function appendNoteSection(
  content: HTMLElement,
  { userId, host, notes, signal, contentSignal }: NoteSectionContext,
): void {
  // Note section (private; on the server when it keeps notes, else localStorage)
  content.appendChild(makeDivider());
  const noteTitle = createElement(
    "div",
    { class: "dps-section-title" },
    requestsText("profile.note"),
  );

  const noteInput = createElement("textarea", {
    class: "dps-note",
    placeholder: requestsText("profile.notePlaceholder"),
    "data-testid": "dps-note",
    rows: "3",
    maxlength: String(NOTE_MAX_LENGTH),
  });
  const binding = createNoteBinding(notes ?? { api: null, host, sessionSignal: signal }, userId);
  // Flush an edit still waiting on its debounce when the body goes away: the
  // panel closing, or a switch to another DM.
  contentSignal.addEventListener("abort", () => binding.destroy(), { once: true });
  let noteDirty = false;
  if (binding.remote) {
    void binding.load(contentSignal).then(
      (text) => {
        if (!noteDirty && !contentSignal.aborted) noteInput.value = text;
      },
      () => undefined,
    );
  } else {
    noteInput.value = binding.readLocal();
  }
  const noteError = createElement("div", {
    class: "dps-note-error",
    role: "status",
    "data-testid": "dps-note-error",
  });
  binding.onFailedChange((failed) => {
    setText(noteError, failed ? requestsText("profile.noteNotSaved") : "");
  });

  noteInput.addEventListener(
    "input",
    () => {
      noteDirty = true;
      binding.change(noteInput.value);
    },
    { signal: contentSignal },
  );
  noteInput.addEventListener("blur", () => binding.flush(), { signal: contentSignal });

  appendChildren(content, noteTitle, noteInput, noteError);
}

/** Report and Block / Unblock, each only when its callback was given. */
export function appendActionButtons(
  content: HTMLElement,
  userId: number,
  options: DmProfileSidebarOptions,
  contentSignal: AbortSignal,
): void {
  const actionsDivider = makeDivider();
  let actionsShown = false;
  const showActionsDivider = (): void => {
    if (!actionsShown) content.append(actionsDivider);
    actionsShown = true;
  };

  if (options.onReport !== undefined) {
    const onReport = options.onReport;
    const reportBtn = createElement("button", {
      class: "dps-report-btn",
      type: "button",
      "aria-haspopup": "dialog",
      "data-testid": "dps-report-btn",
    });
    reportBtn.appendChild(createIcon("flag", 14));
    reportBtn.appendChild(document.createTextNode(` ${reportEntryText("report")}`));
    reportBtn.addEventListener("click", () => onReport(userId), { signal: contentSignal });
    showActionsDivider();
    content.append(reportBtn);
  }

  // Block / Unblock. The label follows blocksStore, so it flips when the
  // owner's request lands and stays put when it fails.
  if (options.onToggleBlock !== undefined) {
    const onToggleBlock = options.onToggleBlock;
    const blockBtn = createElement("button", {
      class: "dps-block-btn",
      type: "button",
      "data-testid": "dps-block-btn",
    });
    const paint = (): void => {
      setText(
        blockBtn,
        shellText(
          blocksStore.getState().blockedByMe.has(userId) ? "member.unblock" : "member.block",
        ),
      );
    };
    paint();
    blockBtn.addEventListener(
      "click",
      () => onToggleBlock(userId, !blocksStore.getState().blockedByMe.has(userId)),
      { signal: contentSignal },
    );
    const unsub = blocksStore.subscribe(paint);
    contentSignal.addEventListener("abort", unsub, { once: true });
    showActionsDivider();
    content.append(blockBtn);
  }
}
