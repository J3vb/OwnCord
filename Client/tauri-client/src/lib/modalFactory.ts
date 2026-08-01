/**
 * Shared modal overlay factory.
 * Creates a modal with backdrop, optional click-outside and Escape key
 * dismissal, and clean lifecycle management via AbortController.
 *
 * CSS classes match the existing project convention:
 *   - div.modal-overlay.visible  (backdrop)
 *   - div.modal                  (content container)
 */

import { createElement } from "./dom";

export interface ModalOptions {
  /** The content element to place inside the modal container. */
  readonly content: HTMLElement;
  /** Called when the modal is closed (backdrop click, Escape, or programmatic). */
  readonly onClose?: () => void;
  /** Close when the backdrop is clicked. Default: true. */
  readonly closeOnBackdrop?: boolean;
  /** Close when the Escape key is pressed. Default: true. */
  readonly closeOnEscape?: boolean;
  /** Additional CSS class on the .modal container (e.g. "dm-member-picker-modal"). */
  readonly className?: string;
  /** Additional attributes on the overlay element (e.g. data-testid). */
  readonly overlayAttrs?: Readonly<Record<string, string>>;
  /** AbortSignal for automatic cleanup when the parent component is destroyed. */
  readonly signal?: AbortSignal;
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
    className,
    overlayAttrs,
    signal,
  } = options;

  const ac = new AbortController();

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
  modal.appendChild(content);
  overlay.appendChild(modal);

  let closed = false;

  function handleClose(): void {
    if (closed) return;
    closed = true;
    overlay.remove();
    ac.abort();
    if (onClose !== undefined) {
      onClose();
    }
  }

  // Backdrop click
  if (closeOnBackdrop) {
    overlay.addEventListener(
      "click",
      (e) => {
        if (e.target === overlay) {
          handleClose();
        }
      },
      { signal: ac.signal },
    );
  }

  // Escape key
  if (closeOnEscape) {
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          handleClose();
        }
      },
      { signal: ac.signal },
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
          onClose?.();
          if (!ac.signal.aborted) {
            ac.abort();
          }
        }
      },
      { signal: ac.signal },
    );
  }

  container.appendChild(overlay);

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
  /** Called with the trimmed value. Not called when the user cancels. */
  readonly onSubmit: (value: string) => void;
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

  const row = createElement("div", {
    style: "display:flex;gap:8px;margin-top:12px;",
  });
  const confirm = createElement(
    "button",
    { class: "btn btn-primary", style: "flex:1;", "data-testid": "prompt-confirm" },
    options.confirmLabel ?? "Save",
  );
  const cancel = createElement(
    "button",
    { class: "btn btn-secondary", style: "flex:1;", "data-testid": "prompt-cancel" },
    "Cancel",
  );
  row.appendChild(confirm);
  row.appendChild(cancel);
  content.appendChild(row);

  const instance = createModal(
    { content, onClose: options.onClose, className: "modal-prompt" },
    container,
  );

  const submit = (): void => {
    const value = input.value.trim();
    instance.close();
    options.onSubmit(value);
  };
  confirm.addEventListener("click", submit);
  cancel.addEventListener("click", () => instance.close());
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    }
  });
  input.focus();

  return instance;
}
