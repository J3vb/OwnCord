/**
 * The modal shell the member-menu moderation dialogs share (Nickname, Warn,
 * Ban): a backdrop click never closes it, so typed text or a pending Retry
 * survives a stray click; it remembers that it closed, so a request that
 * answers afterwards reports through a toast instead; and it owns the red
 * status line under the fields.
 */

import { createElement, setText } from "@lib/dom";
import { createModal, type ModalInstance } from "@lib/ui/modalFactory";

export interface FormModalOptions {
  readonly content: HTMLElement;
  readonly titleId: string;
  /** `data-testid` of the overlay. */
  readonly testId: string;
  /** Runs after the shell has recorded the close. */
  readonly onClose?: () => void;
  readonly signal?: AbortSignal;
  readonly fallbackFocus?: () => HTMLElement | null;
}

export interface FormModal {
  readonly modal: ModalInstance;
  isClosed(): boolean;
  showStatus(text: string): void;
  hideStatus(): void;
}

/** The status line, hidden until a failure; place it in the dialog body. */
export function createFormStatus(testId: string): HTMLDivElement {
  return createElement("div", {
    class: "form-group",
    role: "alert",
    style: "color: var(--text-danger); font-size: 13px; display: none;",
    "data-testid": testId,
  });
}

export function openFormModal(options: FormModalOptions, status: HTMLElement): FormModal {
  let closed = false;
  const modal = createModal({
    content: options.content,
    ariaLabelledBy: options.titleId,
    overlayAttrs: { "data-testid": options.testId },
    closeOnBackdrop: false,
    onClose: () => {
      closed = true;
      options.onClose?.();
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fallbackFocus === undefined ? {} : { fallbackFocus: options.fallbackFocus }),
  });
  return {
    modal,
    isClosed: () => closed,
    showStatus(text) {
      status.style.display = "block";
      setText(status, text);
    },
    hideStatus() {
      status.style.display = "none";
    },
  };
}
