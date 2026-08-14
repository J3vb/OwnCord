/**
 * DeleteChannelModal — confirmation dialog for deleting a channel.
 * Shows channel name and requires explicit confirmation.
 */

import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/a11y";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";

export interface DeleteChannelModalOptions {
  readonly channelId: number;
  readonly channelName: string;
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}

export function createDeleteChannelModal(options: DeleteChannelModalOptions): MountableComponent {
  const { channelName, onConfirm, onClose } = options;
  const ac = new AbortController();
  let overlay: HTMLDivElement | null = null;
  let restoreFocus: (() => void) | null = null;

  function mount(container: Element): void {
    overlay = createElement("div", {
      class: "modal-overlay visible",
      "data-testid": "delete-channel-modal",
    });

    const modal = createElement("div", { class: "modal" });
    applyDialogSemantics(modal, { labelledBy: "delete-channel-title" });
    trapFocus(modal, ac.signal);

    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", { id: "delete-channel-title" }, "Delete Channel");
    // Icon-only button: without a label a screen reader announces just "button".
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
      "aria-label": "Close",
    });
    closeBtn.textContent = "";
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", onClose, { signal: ac.signal });
    appendChildren(header, title, closeBtn);

    // Body
    const body = createElement("div", { class: "modal-body" });
    const warning = createElement("div", { class: "modal-danger-text" });
    appendChildren(
      warning,
      "Are you sure you want to delete ",
      createElement("strong", {}, `#${channelName}`),
      "? This action cannot be undone and all messages in this channel will be lost.",
    );
    body.appendChild(warning);

    // Error display
    const errorEl = createElement("div", {
      style: "color: var(--red); font-size: 13px; display: none; margin-top: 8px;",
      "data-testid": "delete-channel-error",
    });
    body.appendChild(errorEl);

    // Footer
    const footer = createElement("div", { class: "modal-footer" });
    const cancelBtn = createElement(
      "button",
      { class: "btn-modal-cancel", type: "button" },
      "Cancel",
    );
    cancelBtn.addEventListener("click", onClose, { signal: ac.signal });

    const deleteBtn = createElement(
      "button",
      {
        class: "btn-danger",
        type: "button",
        "data-testid": "delete-channel-confirm",
      },
      "Delete Channel",
    );

    deleteBtn.addEventListener(
      "click",
      async () => {
        deleteBtn.setAttribute("disabled", "true");
        setText(deleteBtn, "Deleting...");

        try {
          await onConfirm();
        } catch (err) {
          errorEl.style.display = "block";
          setText(errorEl, err instanceof Error ? err.message : "Failed to delete channel");
        } finally {
          // Re-arm the button whether the caller rejected or handled the
          // failure itself and resolved. A successful delete destroys the
          // modal inside onConfirm, so the overlay is gone and this no-ops.
          if (overlay?.isConnected === true) {
            deleteBtn.removeAttribute("disabled");
            setText(deleteBtn, "Delete Channel");
          }
        }
      },
      { signal: ac.signal },
    );

    appendChildren(footer, cancelBtn, deleteBtn);
    appendChildren(modal, header, body, footer);
    overlay.appendChild(modal);

    // Close on backdrop click
    overlay.addEventListener(
      "click",
      (e) => {
        if (e.target === overlay) {
          onClose();
        }
      },
      { signal: ac.signal },
    );

    // Escape cancels — it must never stand in for the destructive confirm.
    // Document-level so it works wherever focus sits; guarded on the overlay
    // still being attached because the listener lives until destroy() aborts it.
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && overlay?.isConnected === true) {
          onClose();
        }
      },
      { signal: ac.signal },
    );

    container.appendChild(overlay);

    // Move focus in (lands on the header's close button, safely away from the
    // destructive confirm) and remember the opener for destroy() to restore.
    restoreFocus = focusDialog(modal);
  }

  function destroy(): void {
    ac.abort();
    if (overlay !== null) {
      overlay.remove();
      overlay = null;
    }
    // Every close path (X, Cancel, backdrop, Escape) funnels through the
    // caller's onClose, which calls destroy() — the single place focus
    // returns to the opener.
    restoreFocus?.();
    restoreFocus = null;
  }

  return { mount, destroy };
}
