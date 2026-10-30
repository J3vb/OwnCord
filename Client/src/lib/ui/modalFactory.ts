/**
 * Shared modal overlay factory.
 * Creates a modal with backdrop, optional click-outside and Escape key
 * dismissal, and clean lifecycle management via Disposable.
 *
 * Every factory modal carries the dialog accessibility contract:
 * role="dialog" + aria-modal on the container, focus moved into the dialog on
 * open and restored on close, and a Tab-cycling focus trap (lib/ui/a11y.ts).
 *
 * CSS classes match the existing project convention:
 *   - div.modal-overlay.visible  (backdrop)
 *   - div.modal                  (content container)
 */

import { Disposable } from "../disposable";
import { isImeCommit } from "../text/ime";
import { createElement } from "../dom";
import { applyDialogSemantics, focusDialog, trapFocus } from "./a11y";
import { connectText } from "../../i18n/connect";
import { attachLimitHint } from "../text/nameLimits";
import { showToast } from "./toast";

export interface ModalOptions {
  /** The content element to place inside the modal container. */
  readonly content: HTMLElement;
  /** Called when the modal is closed (backdrop click, Escape, or programmatic). */
  readonly onClose?: () => void;
  /** Close when the backdrop is clicked. Default: true. */
  readonly closeOnBackdrop?: boolean;
  /** Close when the Escape key is pressed. Default: true. */
  readonly closeOnEscape?: boolean;
  /**
   * What Escape does instead of closing: a busy guard, an unsaved-changes
   * prompt, closing a nested picker first. Default: close. Only used when
   * `closeOnEscape` is true. Escape that cancels an input-method candidate
   * never reaches it.
   */
  readonly onEscape?: () => void;
  /** Additional CSS class on the .modal container (e.g. "dm-member-picker-modal"). */
  readonly className?: string;
  /** Additional attributes on the overlay element (e.g. data-testid). */
  readonly overlayAttrs?: Readonly<Record<string, string>>;
  /** Accessible name for the dialog (aria-label on the .modal container). */
  readonly ariaLabel?: string;
  /** Id of an element naming the dialog (aria-labelledby); wins over ariaLabel. */
  readonly ariaLabelledBy?: string;
  /** AbortSignal for automatic cleanup when the parent component is destroyed. */
  readonly signal?: AbortSignal;
  /** Focus target on close when the opener is no longer in the document. */
  readonly fallbackFocus?: () => HTMLElement | null;
}

export interface ModalInstance {
  /** The overlay element (outermost). */
  readonly overlay: HTMLElement;
  /** The modal container element (inner). */
  readonly modal: HTMLElement;
  /** Hide the modal (removes visible class). */
  close(): void;
  /** Remove the modal from the DOM and clean up all listeners. */
  destroy(): void;
}

/**
 * Close `overlay` on a click on the backdrop itself. A press that starts
 * inside the dialog and is released on the backdrop (drag-selecting an input's
 * text past its edge) also fires a click on the overlay; only a press that
 * started on the backdrop closes. Every dialog closes on its backdrop through
 * this one guard (src/features/dialogBackdropDoor.test.ts).
 */
export function closeOnBackdropClick(
  overlay: HTMLElement,
  onClose: () => void,
  signal: AbortSignal,
): void {
  let pressStartedInside = false;
  overlay.addEventListener(
    "pointerdown",
    (e) => {
      pressStartedInside = e.target !== overlay;
    },
    { capture: true, signal },
  );
  overlay.addEventListener(
    "click",
    (e) => {
      const startedInside = pressStartedInside;
      pressStartedInside = false;
      if (e.target === overlay && !startedInside) onClose();
    },
    { signal },
  );
}

/**
 * Create and append a modal overlay to the given container (default: document.body).
 * Returns a ModalInstance for lifecycle control.
 */
export function createModal(
  options: ModalOptions,
  container: Element = document.body,
): ModalInstance {
  const {
    content,
    onClose,
    closeOnBackdrop = true,
    closeOnEscape = true,
    onEscape,
    className,
    overlayAttrs,
    ariaLabel,
    ariaLabelledBy,
    signal,
    fallbackFocus,
  } = options;

  const disposable = new Disposable();

  // Build overlay
  const overlayBaseAttrs: Record<string, string> = {
    class: "modal-overlay visible",
  };
  if (overlayAttrs !== undefined) {
    Object.assign(overlayBaseAttrs, overlayAttrs);
  }
  const overlay = createElement("div", overlayBaseAttrs);

  // Build modal container
  const modalClass = className !== undefined ? `modal ${className}` : "modal";
  const modal = createElement("div", { class: modalClass });
  applyDialogSemantics(modal, { label: ariaLabel, labelledBy: ariaLabelledBy });
  trapFocus(modal, disposable.signal);
  modal.appendChild(content);
  overlay.appendChild(modal);

  let closed = false;
  let restoreFocus: (() => void) | null = null;

  function handleClose(): void {
    if (closed) return;
    closed = true;
    overlay.remove();
    disposable.destroy();
    restoreFocus?.();
    if (onClose !== undefined) {
      onClose();
    }
  }

  if (closeOnBackdrop) {
    closeOnBackdropClick(overlay, handleClose, disposable.signal);
  }

  // Escape key
  if (closeOnEscape) {
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key !== "Escape" || isImeCommit(e)) return;
        if (onEscape !== undefined) onEscape();
        else handleClose();
      },
      { signal: disposable.signal },
    );
  }

  // If an external signal is provided, clean up when it aborts
  if (signal !== undefined) {
    signal.addEventListener(
      "abort",
      () => {
        if (!closed) {
          closed = true;
          overlay.remove();
          restoreFocus?.();
          onClose?.();
          if (!disposable.signal.aborted) {
            disposable.destroy();
          }
        }
      },
      { signal: disposable.signal },
    );
  }

  container.appendChild(overlay);

  // After append: move focus into the dialog and remember where it came from.
  // Callers that focus a specific control afterwards (e.g. the prompt input)
  // simply override the initial target; the restore still works.
  restoreFocus = focusDialog(modal, fallbackFocus);

  return {
    overlay,
    modal,
    close: handleClose,
    destroy: handleClose,
  };
}

// ---------------------------------------------------------------------------
// Prompt modal
// ---------------------------------------------------------------------------

export interface PromptModalOptions {
  readonly title: string;
  readonly label?: string;
  readonly initialValue?: string;
  readonly placeholder?: string;
  readonly maxLength?: number;
  readonly confirmLabel?: string;
  /** Inline rule text under the field. Setting it also gives the field a
   *  "limit reached" state at `maxLength` and a place for a refusal. */
  readonly hint?: string;
  /** Checked before `onSubmit` on the trimmed value; a returned message is
   *  shown under the field, the value stays and nothing is submitted. */
  readonly validate?: (value: string) => string | null;
  /**
   * Called with the trimmed value. Not called when the user cancels. A
   * returned promise keeps the prompt open until it settles: a string it
   * resolves to is shown under the field (the typed value stays); null closes.
   * A plain return closes at once.
   */
  readonly onSubmit: (value: string) => void | Promise<string | null>;
  readonly onClose?: () => void;
  readonly testId?: string;
}

/**
 * A one-field prompt: title, text input, confirm/cancel.
 *
 * Exists because `window.prompt` is unavailable in the Tauri webview and
 * because a hand-rolled overlay per caller is three chances to forget Escape
 * handling. An empty value is a legitimate submission — clearing a group DM's
 * name is exactly how you say "go back to listing the members".
 */
export function createPromptModal(
  options: PromptModalOptions,
  container: Element = document.body,
): ModalInstance {
  const content = createElement("div", { style: "padding:20px;min-width:280px;" });
  const heading = createElement("h3", {}, options.title);
  content.appendChild(heading);

  if (options.label !== undefined) {
    content.appendChild(
      createElement(
        "p",
        { style: "color:var(--text-secondary);font-size:0.85rem;margin:0 0 8px;" },
        options.label,
      ),
    );
  }

  const input = createElement("input", {
    type: "text",
    class: "modal-prompt-input",
    placeholder: options.placeholder ?? "",
    maxlength: String(options.maxLength ?? 100),
    "data-testid": options.testId ?? "prompt-input",
    style: "width:100%;",
  });
  input.value = options.initialValue ?? "";
  content.appendChild(input);
  const hint =
    options.hint === undefined
      ? null
      : attachLimitHint(input, {
          max: options.maxLength ?? 100,
          countCharacters: true,
          hint: options.hint,
          id: "prompt-hint",
        });
  if (hint !== null) content.appendChild(hint.el);

  const row = createElement("div", {
    style: "display:flex;gap:8px;margin-top:12px;",
  });
  const confirm = createElement(
    "button",
    { class: "btn btn-primary", style: "flex:1;", "data-testid": "prompt-confirm" },
    options.confirmLabel ?? connectText("modal.save"),
  );
  const cancel = createElement(
    "button",
    { class: "btn btn-secondary", style: "flex:1;", "data-testid": "prompt-cancel" },
    connectText("common.cancel"),
  );
  row.appendChild(confirm);
  row.appendChild(cancel);
  content.appendChild(row);

  let closed = false;
  const instance = createModal(
    {
      content,
      onClose: () => {
        closed = true;
        options.onClose?.();
      },
      className: "modal-prompt",
      ariaLabel: options.title,
    },
    container,
  );

  let pending = false;
  // A refusal goes under the field while the prompt is open and has one; when
  // the prompt was closed mid-request, or has no hint, it is toasted so it is
  // never silent.
  const refuse = (message: string): void => {
    if (!closed && hint !== null) hint.showError(message);
    else showToast(message, "error");
  };
  const submit = (): void => {
    if (pending) return;
    const value = input.value.trim();
    const problem = options.validate?.(value) ?? null;
    if (problem !== null) {
      refuse(problem);
      return;
    }
    const result = options.onSubmit(value);
    if (!(result instanceof Promise)) {
      instance.close();
      return;
    }
    pending = true;
    confirm.disabled = true;
    void result
      .then((refusal) => {
        if (refusal === null) {
          if (!closed) instance.close();
        } else {
          refuse(refusal);
        }
      })
      .catch(() => {
        // The caller turns its own failures into a refusal string; a rejection
        // reaching here has no text to show, so leave the prompt open to retry.
      })
      .finally(() => {
        pending = false;
        confirm.disabled = false;
      });
  };
  confirm.addEventListener("click", submit);
  cancel.addEventListener("click", () => instance.close());
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && !isImeCommit(e)) {
      e.preventDefault();
      submit();
    }
  });
  input.focus();

  return instance;
}
