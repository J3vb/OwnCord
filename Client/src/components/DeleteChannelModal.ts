/**
 * DeleteChannelModal — confirmation dialog for deleting a channel.
 * Shows channel name and requires explicit confirmation.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createModal, type ModalInstance } from "@lib/modalFactory";
import type { MountableComponent } from "@lib/safe-render";
import { shellText } from "../i18n/shell";

export interface DeleteChannelModalOptions {
  readonly channelId: number;
  readonly channelName: string;
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}

export function createDeleteChannelModal(options: DeleteChannelModalOptions): MountableComponent {
  const { channelName, onConfirm, onClose } = options;
  const disposable = new Disposable();
  let instance: ModalInstance | null = null;

  function mount(container: Element): void {
    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", { id: "delete-channel-title" }, shellText("channel.delete"));
    // Icon-only button: without a label a screen reader announces just "button".
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
      "aria-label": shellText("common.close"),
    });
    closeBtn.textContent = "";
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", onClose, { signal: disposable.signal });
    appendChildren(header, title, closeBtn);

    // Body
    const body = createElement("div", { class: "modal-body" });
    const warning = createElement("div", { class: "modal-danger-text" });
    // One message around the emphasised channel name: split at a marker the
    // parameter can never contain, so the name stays data and the sentence
    // stays whole for translation.
    const [before = "", after = ""] = shellText("channel.deleteWarning", {
      channel: "\u0000",
    }).split("\u0000");
    appendChildren(warning, before, createElement("strong", {}, `#${channelName}`), after);
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
      shellText("common.cancel"),
    );
    cancelBtn.addEventListener("click", onClose, { signal: disposable.signal });

    const deleteBtn = createElement(
      "button",
      {
        class: "btn-danger",
        type: "button",
        "data-testid": "delete-channel-confirm",
      },
      shellText("channel.delete"),
    );

    deleteBtn.addEventListener(
      "click",
      async () => {
        deleteBtn.setAttribute("disabled", "true");
        setText(deleteBtn, shellText("common.deleting"));

        try {
          await onConfirm();
        } catch (err) {
          errorEl.style.display = "block";
          setText(errorEl, err instanceof Error ? err.message : shellText("channel.deleteFailed"));
        } finally {
          // Re-arm the button whether the caller rejected or handled the
          // failure itself and resolved. A successful delete destroys the
          // modal inside onConfirm, so the overlay is gone and this no-ops.
          if (instance?.overlay.isConnected === true) {
            deleteBtn.removeAttribute("disabled");
            setText(deleteBtn, shellText("channel.delete"));
          }
        }
      },
      { signal: disposable.signal },
    );

    appendChildren(footer, cancelBtn, deleteBtn);

    // Overlay/modal shell, dialog semantics, focus trap and focus
    // save/restore all come from the shared factory; only the backdrop and
    // Escape wiring stay here, since this component's onClose is decoupled
    // from destroy() (see the caller's onClose, which calls destroy()).
    instance = createModal(
      {
        content: header,
        closeOnBackdrop: false,
        closeOnEscape: false,
        overlayAttrs: { "data-testid": "delete-channel-modal" },
        ariaLabelledBy: "delete-channel-title",
      },
      container,
    );
    appendChildren(instance.modal, body, footer);

    // Close on backdrop click
    instance.overlay.addEventListener(
      "click",
      (e) => {
        if (e.target === instance?.overlay) {
          onClose();
        }
      },
      { signal: disposable.signal },
    );

    // Escape cancels — it must never stand in for the destructive confirm.
    // Document-level so it works wherever focus sits; guarded on the overlay
    // still being attached because the listener lives until destroy() aborts it.
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && instance?.overlay.isConnected === true) {
          onClose();
        }
      },
      { signal: disposable.signal },
    );
  }

  function destroy(): void {
    disposable.destroy();
    instance?.destroy();
    instance = null;
  }

  return { mount, destroy };
}
