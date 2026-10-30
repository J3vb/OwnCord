/**
 * The shared yes/no confirm dialog: a title, a body, and Cancel + a confirm
 * button, built on `createModal`. Every confirm in the app goes through it
 * (src/features/confirmDialogDoor.test.ts), so they all behave the same:
 *
 *  - Cancel is focused on open, so a stray Enter cancels; Escape and the
 *    backdrop cancel too, and focus returns to the opener.
 *  - The confirm action runs at most once: a double click, a click after the
 *    dialog closed or a held Enter (auto-repeat is swallowed) cannot run it twice.
 *  - Its listeners belong to a Disposable that dies with the dialog.
 *  - A dialog closed from outside (the owner's `signal`, `destroy()`) while an
 *    async action is pending is never touched by that action afterwards, and
 *    `onClose` runs exactly once.
 *
 * Kept out of modalFactory.ts on purpose: that module is on the startup path.
 */

import { Disposable } from "../../lib/disposable";
import { createElement, setText } from "../../lib/dom";
import { createIcon } from "../../lib/icons";
import { createModal, type ModalInstance } from "../../lib/ui/modalFactory";
import { connectText } from "../../i18n/connect";

export interface ConfirmModalOptions {
  readonly title: string;
  /** A string becomes a `<p>` (class `modal-danger-text` for the danger tone); nodes are used as-is. */
  readonly body: string | Node | readonly Node[];
  readonly confirmLabel: string;
  /** Default: the shared "Cancel". */
  readonly cancelLabel?: string;
  /** `danger` (default) styles the confirm as destructive, `primary` as the ordinary action. */
  readonly tone?: "danger" | "primary";
  /** `data-testid` of the overlay. */
  readonly testId?: string;
  readonly confirmTestId?: string;
  readonly cancelTestId?: string;
  /** `data-testid` of the inline failure line (only with `failureText`). */
  readonly errorTestId?: string;
  /** Id of the title, which names the dialog (aria-labelledby). */
  readonly titleId?: string;
  /** Id of the element that describes the dialog (aria-describedby). */
  readonly describedBy?: string;
  /** A header X that cancels. */
  readonly closeButton?: boolean;
  /**
   * What confirming does. By default the dialog closes first, then this runs
   * (at most once). With `staysOpen` the action is awaited instead: the dialog
   * stays open with the confirm button disabled (showing `busyLabel`), a
   * rejection is shown inline through `failureText` and re-arms the button, and
   * a resolve closes the dialog if it is still open.
   */
  readonly onConfirm: () => void | Promise<void>;
  readonly staysOpen?: boolean;
  /** With `staysOpen`: close when the action resolves. Default true; false when the caller closes the dialog itself. */
  readonly closeOnResolve?: boolean;
  readonly busyLabel?: string;
  readonly failureText?: (err: unknown) => string;
  /** However the dialog ended: confirm, cancel, Escape, the backdrop, `signal`, `destroy()`. */
  readonly onClose?: () => void;
  readonly signal?: AbortSignal;
  readonly fallbackFocus?: () => HTMLElement | null;
}

export interface ConfirmModalInstance extends ModalInstance {
  readonly title: HTMLElement;
  readonly body: HTMLElement;
  readonly confirm: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
}

let titleSeq = 0;

export function createConfirmModal(
  options: ConfirmModalOptions,
  container: Element = document.body,
): ConfirmModalInstance {
  const tone = options.tone ?? "danger";
  const titleId = options.titleId ?? `confirm-modal-title-${++titleSeq}`;
  const owner = new Disposable();
  let closed = false;
  // The action currently in flight (staysOpen), or already fired (default).
  let busy = false;

  const header = createElement("div", { class: "modal-header" });
  const title = createElement("h3", { id: titleId }, options.title);
  header.appendChild(title);

  const body = createElement("div", { class: "modal-body" });
  if (typeof options.body === "string") {
    const attrs: Record<string, string> = tone === "danger" ? { class: "modal-danger-text" } : {};
    body.appendChild(createElement("p", attrs, options.body));
  } else if (options.body instanceof Node) {
    body.appendChild(options.body);
  } else {
    body.append(...options.body);
  }
  const errorEl =
    options.failureText === undefined
      ? null
      : createElement("div", {
          style: "color: var(--text-danger); font-size: 13px; display: none; margin-top: 8px;",
          ...(options.errorTestId === undefined ? {} : { "data-testid": options.errorTestId }),
        });
  if (errorEl !== null) body.appendChild(errorEl);

  const cancel = createElement(
    "button",
    {
      class: "btn-modal-cancel",
      type: "button",
      ...(options.cancelTestId === undefined ? {} : { "data-testid": options.cancelTestId }),
    },
    options.cancelLabel ?? connectText("common.cancel"),
  );
  const confirm = createElement(
    "button",
    {
      class: tone === "danger" ? "btn-danger" : "btn-modal-save",
      type: "button",
      ...(options.confirmTestId === undefined ? {} : { "data-testid": options.confirmTestId }),
    },
    options.confirmLabel,
  );
  const footer = createElement("div", { class: "modal-footer" });
  footer.append(cancel, confirm);

  const content = createElement("div");
  content.append(header, body, footer);

  const modal = createModal(
    {
      content,
      ariaLabelledBy: titleId,
      ...(options.testId === undefined ? {} : { overlayAttrs: { "data-testid": options.testId } }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fallbackFocus === undefined ? {} : { fallbackFocus: options.fallbackFocus }),
      onClose: () => {
        closed = true;
        owner.destroy();
        options.onClose?.();
      },
    },
    container,
  );
  if (options.describedBy !== undefined) {
    modal.modal.setAttribute("aria-describedby", options.describedBy);
  }

  if (options.closeButton === true) {
    // Icon-only button: without a label a screen reader announces just "button".
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
      "aria-label": connectText("common.close"),
    });
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", () => modal.close(), { signal: owner.signal });
    header.appendChild(closeBtn);
  }

  cancel.addEventListener("click", () => modal.close(), { signal: owner.signal });
  // A held Enter would auto-repeat into the focused button.
  modal.modal.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat) e.preventDefault();
    },
    { signal: owner.signal },
  );

  const runAsync = async (): Promise<void> => {
    busy = true;
    confirm.disabled = true;
    if (options.busyLabel !== undefined) setText(confirm, options.busyLabel);
    if (errorEl !== null) errorEl.style.display = "none";
    try {
      await options.onConfirm();
      if (closed) return;
      if (options.closeOnResolve === false) {
        busy = false;
        confirm.disabled = false;
        setText(confirm, options.confirmLabel);
      } else {
        modal.close();
      }
    } catch (err) {
      // Closed while the request was out: nobody is looking at the dialog.
      if (closed) return;
      if (errorEl !== null && options.failureText !== undefined) {
        errorEl.style.display = "block";
        setText(errorEl, options.failureText(err));
      }
      busy = false;
      confirm.disabled = false;
      setText(confirm, options.confirmLabel);
    }
  };

  confirm.addEventListener(
    "click",
    () => {
      if (closed || busy) return;
      if (options.staysOpen === true) {
        void runAsync();
        return;
      }
      busy = true;
      modal.close();
      void options.onConfirm();
    },
    { signal: owner.signal },
  );

  cancel.focus();

  return Object.assign(modal, { title, body, confirm, cancel });
}
