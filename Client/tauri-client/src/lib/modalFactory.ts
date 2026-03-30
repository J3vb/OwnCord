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
  const modalClass = className !== undefined
    ? `modal ${className}`
    : "modal";
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
    signal.addEventListener("abort", () => {
      if (!closed) {
        closed = true;
        overlay.remove();
        onClose?.();
        if (!ac.signal.aborted) {
          ac.abort();
        }
      }
    }, { signal: ac.signal });
  }

  container.appendChild(overlay);

  return {
    overlay,
    modal,
    close: handleClose,
    destroy: handleClose,
  };
}
