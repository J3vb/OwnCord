/**
 * The composer's "+" on a phone: a sheet with Take photo, Gallery and Files,
 * each backed by its own hidden file input so the phone opens its camera,
 * its photo picker or its file manager. Every row hands the chosen files to
 * the same upload path. Off the phone layout "+" opens the file picker, as
 * it always did.
 */

import { appendChildren, createElement } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { isPhoneLayout, openBottomSheet } from "@lib/ui/bottomSheet";
import { messagingText } from "../../i18n/messaging";

export type AttachSource = "camera" | "gallery" | "files";

export interface AttachPickersOptions {
  readonly onFile: (file: File) => void;
  /** Read at tap time: false when attaching is off (gated, or uploads disabled). */
  readonly canAttach: () => boolean;
  /** The composer's lifetime: listeners go, and an open sheet closes. */
  readonly signal: AbortSignal;
}

export interface AttachPickers {
  /** Hidden inputs for the owner to mount; the Files one comes first. */
  readonly inputs: readonly HTMLInputElement[];
  /** The "+" button: the sheet on a phone, the file picker elsewhere. */
  open(): void;
  /** Straight to the file picker, whatever the layout. */
  openFiles(): void;
}

const ROWS: readonly { source: AttachSource; icon: IconName }[] = [
  { source: "camera", icon: "camera" },
  { source: "gallery", icon: "image" },
  { source: "files", icon: "file-text" },
];

const INPUT_ATTRS: Record<AttachSource, Record<string, string>> = {
  files: { multiple: "" },
  camera: { accept: "image/*", capture: "environment" },
  gallery: { accept: "image/*,video/*", multiple: "" },
};

const LABEL_KEYS = {
  camera: "attach.camera",
  gallery: "attach.gallery",
  files: "attach.files",
} as const;

export function createAttachPickers(options: AttachPickersOptions): AttachPickers {
  const { onFile, canAttach, signal } = options;

  function makeInput(source: AttachSource): HTMLInputElement {
    const input = createElement("input", {
      type: "file",
      style: "display: none;",
      "data-attach-source": source,
      ...INPUT_ATTRS[source],
    });
    input.addEventListener(
      "change",
      () => {
        // Copied first: clearing the value empties the live FileList.
        const files = [...(input.files ?? [])];
        input.value = "";
        for (const file of files) onFile(file);
      },
      { signal },
    );
    return input;
  }

  const bySource: Record<AttachSource, HTMLInputElement> = {
    files: makeInput("files"),
    camera: makeInput("camera"),
    gallery: makeInput("gallery"),
  };

  function openSheet(): void {
    const grid = createElement("div", { class: "attach-sheet" });
    const sheet = openBottomSheet({
      label: messagingText("attach.sheetLabel"),
      content: grid,
      className: "attach-sheet-panel",
      testId: "attach-sheet",
      signal,
    });
    for (const { source, icon } of ROWS) {
      const badge = createElement("span", {
        class: `attach-sheet-icon attach-sheet-icon-${source}`,
        "aria-hidden": "true",
      });
      badge.appendChild(createIcon(icon, 22));
      const btn = createElement("button", {
        type: "button",
        class: "attach-sheet-tile",
        "data-testid": `attach-sheet-${source}`,
      });
      appendChildren(btn, badge, createElement("span", {}, messagingText(LABEL_KEYS[source])));
      // The sheet's signal ends on close, so a second tap opens nothing.
      btn.addEventListener(
        "click",
        () => {
          sheet.close();
          if (canAttach()) bySource[source].click();
        },
        { signal: sheet.signal },
      );
      grid.appendChild(btn);
    }
  }

  return {
    inputs: [bySource.files, bySource.camera, bySource.gallery],
    open: () => {
      if (!canAttach()) return;
      if (isPhoneLayout()) openSheet();
      else bySource.files.click();
    },
    openFiles: () => {
      if (canAttach()) bySource.files.click();
    },
  };
}
