/**
 * CreateChannelModal — modal for creating a new channel.
 *
 * The category is an editable text field pre-filled with the group the "+" was
 * clicked on, backed by a <datalist> of the categories already in use. It used
 * to be read-only, and the channel TYPE was inferred from the category name
 * ("voice" anywhere in it meant voice-only), which made every other category
 * name second-class: a voice channel could not live under "Gaming", and
 * renaming a category silently changed what could be created there. Categories
 * are free text and grouping is a display concern, so every type is offered
 * under every category — the server agrees (it validates the type alone).
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import type { ChannelType } from "@lib/types";
import { getKnownCategories, UNCATEGORIZED_VOICE_CATEGORY } from "@stores/channels.store";

export interface CreateChannelModalOptions {
  /** The category the create affordance was invoked from ("" = uncategorized). */
  readonly category: string;
  /** Called when the user submits the form. */
  readonly onCreate: (data: { name: string; type: ChannelType; category: string }) => Promise<void>;
  /** Called when the modal is closed without creating. */
  readonly onClose: () => void;
}

/** Every channel type is creatable under every category. */
export const CHANNEL_TYPES: readonly ChannelType[] = ["text", "voice", "announcement"] as const;

/**
 * The type pre-selected for a category. Only a hint for the dropdown's initial
 * value — every type stays selectable. The one case worth guessing is the
 * synthetic "Voice" fallback group the sidebar puts uncategorized voice
 * channels in: creating from its "+" almost certainly means another voice
 * channel.
 */
export function defaultTypeForCategory(category: string): ChannelType {
  return category === UNCATEGORIZED_VOICE_CATEGORY ? "voice" : "text";
}

export function createCreateChannelModal(options: CreateChannelModalOptions): MountableComponent {
  const { category, onCreate, onClose } = options;
  const ac = new AbortController();
  let overlay: HTMLDivElement | null = null;

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

    // Category — free text, with the categories already in use as suggestions.
    const categoryGroup = createElement("div", { class: "form-group" });
    const categoryLabel = createElement("label", { class: "form-label" }, "Category");
    const categoryInput = createElement("input", {
      class: "form-input",
      type: "text",
      list: "create-channel-categories",
      autocomplete: "off",
      placeholder: "Leave blank for no category",
      "data-testid": "channel-category-input",
    });
    categoryInput.value = category;
    const categoryList = createElement("datalist", { id: "create-channel-categories" });
    for (const known of getKnownCategories()) {
      categoryList.appendChild(createElement("option", { value: known }));
    }
    appendChildren(categoryGroup, categoryLabel, categoryInput, categoryList);

    // Channel name
    const nameGroup = createElement("div", { class: "form-group" });
    const nameLabel = createElement("label", { class: "form-label" }, "Name");
    const nameInput = createElement("input", {
      class: "form-input",
      type: "text",
      placeholder: defaultTypeForCategory(category) === "voice" ? "lounge" : "general",
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

    for (const t of CHANNEL_TYPES) {
      const opt = createElement("option", { value: t }, t.charAt(0).toUpperCase() + t.slice(1));
      typeSelect.appendChild(opt);
    }
    typeSelect.value = defaultTypeForCategory(category);
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
            category: categoryInput.value.trim(),
          });
        } catch (err) {
          errorEl.style.display = "block";
          setText(errorEl, err instanceof Error ? err.message : "Failed to create channel");
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
