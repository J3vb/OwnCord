/**
 * CreateChannelModal — modal for creating a new channel under a specific
 * category. The channel type is automatically restricted based on the
 * category: voice categories only allow voice channels, text categories
 * allow text and announcement channels.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import type { ChannelType } from "@lib/types";

export interface CreateChannelModalOptions {
  /** The category this channel will be created under. */
  readonly category: string;
  /** Called when the user submits the form. */
  readonly onCreate: (data: {
    name: string;
    type: ChannelType;
    category: string;
  }) => Promise<void>;
  /** Called when the modal is closed without creating. */
  readonly onClose: () => void;
}

/** Returns true if the category name indicates a voice section. */
export function isVoiceCategory(category: string): boolean {
  return category.toLowerCase().includes("voice");
}

/** Returns the allowed channel types for a given category. */
export function allowedTypesForCategory(
  category: string,
): readonly ChannelType[] {
  if (isVoiceCategory(category)) {
    return ["voice"] as const;
  }
  return ["text", "announcement"] as const;
}

export function createCreateChannelModal(
  options: CreateChannelModalOptions,
): MountableComponent {
  const { category, onCreate, onClose } = options;
  const ac = new AbortController();
  let overlay: HTMLDivElement | null = null;

  const allowedTypes = allowedTypesForCategory(category);

  function mount(container: Element): void {
    overlay = createElement("div", {
      class: "modal-overlay visible",
      "data-testid": "create-channel-modal",
    });

    const modal = createElement("div", { class: "modal" });

    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", {}, "Create Channel");
    const closeBtn = createElement("button", {
      class: "modal-close",
      type: "button",
    });
    closeBtn.textContent = "";
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", onClose, { signal: ac.signal });
    appendChildren(header, title, closeBtn);

    // Body
    const body = createElement("div", { class: "modal-body" });

    // Category (read-only display)
    const categoryGroup = createElement("div", { class: "form-group" });
    const categoryLabel = createElement(
      "label",
      { class: "form-label" },
      "Category",
    );
    const categoryDisplay = createElement("div", {
      class: "form-input",
      style: "opacity: 0.7; cursor: default;",
    });
    setText(categoryDisplay, category);
    appendChildren(categoryGroup, categoryLabel, categoryDisplay);

    // Channel name
    const nameGroup = createElement("div", { class: "form-group" });
    const nameLabel = createElement("label", { class: "form-label" }, "Name");
    const nameInput = createElement("input", {
      class: "form-input",
      type: "text",
      placeholder: isVoiceCategory(category) ? "lounge" : "general",
      "data-testid": "channel-name-input",
    });
    appendChildren(nameGroup, nameLabel, nameInput);

    // Channel type
    const typeGroup = createElement("div", { class: "form-group" });
    const typeLabel = createElement("label", { class: "form-label" }, "Type");
    const typeSelect = createElement("select", {
      class: "form-input",
      "data-testid": "channel-type-select",
    });

    for (const t of allowedTypes) {
      const opt = createElement(
        "option",
        { value: t },
        t.charAt(0).toUpperCase() + t.slice(1),
      );
      typeSelect.appendChild(opt);
    }
    appendChildren(typeGroup, typeLabel, typeSelect);

    // Error display
    const errorEl = createElement("div", {
      class: "form-group",
      style: "color: var(--red); font-size: 13px; display: none;",
      "data-testid": "channel-create-error",
    });

    appendChildren(body, categoryGroup, nameGroup, typeGroup, errorEl);

    // Footer
    const footer = createElement("div", { class: "modal-footer" });
    const cancelBtn = createElement(
      "button",
      { class: "btn-modal-cancel", type: "button" },
      "Cancel",
    );
    cancelBtn.addEventListener("click", onClose, { signal: ac.signal });

    const createBtn = createElement(
      "button",
      {
        class: "btn-modal-save",
        type: "button",
        "data-testid": "channel-create-submit",
      },
      "Create Channel",
    );

    createBtn.addEventListener(
      "click",
      async () => {
        const name = nameInput.value.trim();
        if (name === "") {
          errorEl.style.display = "block";
          setText(errorEl, "Channel name is required");
          nameInput.classList.add("error");
          return;
        }

        // Clear previous errors
        errorEl.style.display = "none";
        nameInput.classList.remove("error");
        createBtn.setAttribute("disabled", "true");
        setText(createBtn, "Creating...");

        try {
          await onCreate({
            name,
            type: typeSelect.value as ChannelType,
            category,
          });
        } catch (err) {
          errorEl.style.display = "block";
          setText(
            errorEl,
            err instanceof Error ? err.message : "Failed to create channel",
          );
          createBtn.removeAttribute("disabled");
          setText(createBtn, "Create Channel");
        }
      },
      { signal: ac.signal },
    );

    appendChildren(footer, cancelBtn, createBtn);
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

    // Focus the name input
    nameInput.focus();
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
