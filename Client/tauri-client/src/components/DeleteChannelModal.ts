/**
 * DeleteChannelModal — confirmation dialog for deleting a channel.
 * Shows channel name and requires explicit confirmation.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";

export interface DeleteChannelModalOptions {
  readonly channelId: number;
  readonly channelName: string;
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}

export function createDeleteChannelModal(
  options: DeleteChannelModalOptions,
): MountableComponent {
  const { channelName, onConfirm, onClose } = options;
  const ac = new AbortController();
  let overlay: HTMLDivElement | null = null;

  function mount(container: Element): void {
    overlay = createElement("div", {
      class: "modal-overlay visible",
      "data-testid": "delete-channel-modal",
    });

    const modal = createElement("div", { class: "modal" });

    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", {}, "Delete Channel");
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
    });
    setText(closeBtn, "\u2715");
    closeBtn.addEventListener("click", onClose, { signal: ac.signal });
    appendChildren(header, title, closeBtn);

    // Body
    const body = createElement("div", { class: "modal-body" });
    const warning = createElement("div", { class: "modal-danger-text" });
    warning.innerHTML = `Are you sure you want to delete <strong>#${channelName}</strong>? This action cannot be undone and all messages in this channel will be lost.`;
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
          setText(
            errorEl,
            err instanceof Error ? err.message : "Failed to delete channel",
          );
          deleteBtn.removeAttribute("disabled");
          setText(deleteBtn, "Delete Channel");
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

    container.appendChild(overlay);
  }

  function destroy(): void {
    ac.abort();
    if (overlay !== null) {
      overlay.remove();
      overlay = null;
    }
  }

  return { mount, destroy };
}
