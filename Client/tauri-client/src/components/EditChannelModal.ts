/**
 * EditChannelModal — modal for editing an existing channel's name and topic.
 * Only visible to admin/owner users.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";

export interface EditChannelModalOptions {
  /** Current channel ID. */
  readonly channelId: number;
  /** Current channel name. */
  readonly channelName: string;
  /** Current channel type (displayed, not editable). */
  readonly channelType: string;
  /** Called when the user saves changes. */
  readonly onSave: (data: { name: string }) => Promise<void>;
  /** Called when the modal is closed. */
  readonly onClose: () => void;
}

export function createEditChannelModal(
  options: EditChannelModalOptions,
): MountableComponent {
  const { channelName, channelType, onSave, onClose } = options;
  const ac = new AbortController();
  let overlay: HTMLDivElement | null = null;

  function mount(container: Element): void {
    overlay = createElement("div", {
      class: "modal-overlay visible",
      "data-testid": "edit-channel-modal",
    });

    const modal = createElement("div", { class: "modal" });

    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", {}, "Edit Channel");
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
    });
    setText(closeBtn, "\u2715");
    closeBtn.addEventListener("click", onClose, { signal: ac.signal });
    appendChildren(header, title, closeBtn);

    // Body
    const body = createElement("div", { class: "modal-body" });

    // Channel type (read-only)
    const typeGroup = createElement("div", { class: "form-group" });
    const typeLabel = createElement("label", { class: "form-label" }, "Type");
    const typeDisplay = createElement("div", {
      class: "form-input",
      style: "opacity: 0.7; cursor: default;",
    });
    setText(typeDisplay, channelType.charAt(0).toUpperCase() + channelType.slice(1));
    appendChildren(typeGroup, typeLabel, typeDisplay);

    // Channel name
    const nameGroup = createElement("div", { class: "form-group" });
    const nameLabel = createElement("label", { class: "form-label" }, "Name");
    const nameInput = createElement("input", {
      class: "form-input",
      type: "text",
      value: channelName,
      "data-testid": "edit-channel-name-input",
    }) as HTMLInputElement;
    nameInput.value = channelName;
    appendChildren(nameGroup, nameLabel, nameInput);

    // Error display
    const errorEl = createElement("div", {
      class: "form-group",
      style: "color: var(--red); font-size: 13px; display: none;",
      "data-testid": "edit-channel-error",
    });

    appendChildren(body, typeGroup, nameGroup, errorEl);

    // Footer
    const footer = createElement("div", { class: "modal-footer" });
    const cancelBtn = createElement(
      "button",
      { class: "btn-modal-cancel", type: "button" },
      "Cancel",
    );
    cancelBtn.addEventListener("click", onClose, { signal: ac.signal });

    const saveBtn = createElement(
      "button",
      {
        class: "btn-modal-save",
        type: "button",
        "data-testid": "edit-channel-submit",
      },
      "Save Changes",
    );

    saveBtn.addEventListener(
      "click",
      async () => {
        const name = nameInput.value.trim();
        if (name === "") {
          errorEl.style.display = "block";
          setText(errorEl, "Channel name is required");
          nameInput.classList.add("error");
          return;
        }

        errorEl.style.display = "none";
        nameInput.classList.remove("error");
        saveBtn.setAttribute("disabled", "true");
        setText(saveBtn, "Saving...");

        try {
          await onSave({ name });
        } catch (err) {
          errorEl.style.display = "block";
          setText(
            errorEl,
            err instanceof Error ? err.message : "Failed to update channel",
          );
          saveBtn.removeAttribute("disabled");
          setText(saveBtn, "Save Changes");
        }
      },
      { signal: ac.signal },
    );

    appendChildren(footer, cancelBtn, saveBtn);
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
    nameInput.focus();
    nameInput.select();
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
