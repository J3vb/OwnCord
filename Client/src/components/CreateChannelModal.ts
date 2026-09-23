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

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createModal, type ModalInstance } from "@lib/modalFactory";
import type { MountableComponent } from "@lib/safe-render";
import type { ChannelType } from "@lib/types";
import { getKnownCategories, UNCATEGORIZED_VOICE_CATEGORY } from "@stores/channels.store";
import { shellText } from "../i18n/shell";

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

const CHANNEL_TYPE_LABELS = {
  text: "channel.type.text",
  voice: "channel.type.voice",
  announcement: "channel.type.announcement",
  dm: "channel.type.dm",
} as const;

/** The display name of a channel type; an unrecognised wire value is shown capitalised. */
export function channelTypeLabel(type: string): string {
  return Object.hasOwn(CHANNEL_TYPE_LABELS, type)
    ? shellText(CHANNEL_TYPE_LABELS[type as ChannelType])
    : type.charAt(0).toUpperCase() + type.slice(1);
}

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
  const disposable = new Disposable();
  let instance: ModalInstance | null = null;

  function mount(container: Element): void {
    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", { id: "create-channel-title" }, shellText("channel.create"));
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

    // Category — free text, with the categories already in use as suggestions.
    const categoryGroup = createElement("div", { class: "form-group" });
    const categoryLabel = createElement(
      "label",
      { class: "form-label" },
      shellText("channelForm.category"),
    );
    const categoryInput = createElement("input", {
      class: "form-input",
      type: "text",
      list: "create-channel-categories",
      autocomplete: "off",
      placeholder: shellText("channelForm.categoryPlaceholder"),
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
    const nameLabel = createElement(
      "label",
      { class: "form-label" },
      shellText("channelForm.name"),
    );
    const nameInput = createElement("input", {
      class: "form-input",
      type: "text",
      placeholder: shellText(
        defaultTypeForCategory(category) === "voice"
          ? "channelForm.namePlaceholder.voice"
          : "channelForm.namePlaceholder.text",
      ),
      "data-testid": "channel-name-input",
    });
    appendChildren(nameGroup, nameLabel, nameInput);

    // Channel type
    const typeGroup = createElement("div", { class: "form-group" });
    const typeLabel = createElement(
      "label",
      { class: "form-label" },
      shellText("channelForm.type"),
    );
    const typeSelect = createElement("select", {
      class: "form-input",
      "data-testid": "channel-type-select",
    });

    for (const t of CHANNEL_TYPES) {
      const opt = createElement("option", { value: t }, channelTypeLabel(t));
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
      shellText("common.cancel"),
    );
    cancelBtn.addEventListener("click", onClose, { signal: disposable.signal });

    const createBtn = createElement(
      "button",
      {
        class: "btn-modal-save",
        type: "button",
        "data-testid": "channel-create-submit",
      },
      shellText("channel.create"),
    );

    createBtn.addEventListener(
      "click",
      async () => {
        const name = nameInput.value.trim();
        if (name === "") {
          errorEl.style.display = "block";
          setText(errorEl, shellText("channelForm.nameRequired"));
          nameInput.classList.add("error");
          return;
        }

        // Clear previous errors
        errorEl.style.display = "none";
        nameInput.classList.remove("error");
        createBtn.setAttribute("disabled", "true");
        setText(createBtn, shellText("channelForm.creating"));

        try {
          await onCreate({
            name,
            type: typeSelect.value as ChannelType,
            category: categoryInput.value.trim(),
          });
        } catch (err) {
          errorEl.style.display = "block";
          setText(errorEl, err instanceof Error ? err.message : shellText("channel.createFailed"));
          createBtn.removeAttribute("disabled");
          setText(createBtn, shellText("channel.create"));
        }
      },
      { signal: disposable.signal },
    );

    appendChildren(footer, cancelBtn, createBtn);

    // Overlay/modal shell, dialog semantics, focus trap and focus
    // save/restore all come from the shared factory; only the backdrop and
    // Escape wiring stay here, since this component's onClose is decoupled
    // from destroy() (see the caller's onClose, which calls destroy()).
    instance = createModal(
      {
        content: header,
        closeOnBackdrop: false,
        closeOnEscape: false,
        overlayAttrs: { "data-testid": "create-channel-modal" },
        ariaLabelledBy: "create-channel-title",
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

    // Escape cancels — never creates. Document-level so it works wherever
    // focus sits; guarded on the overlay still being attached because the
    // listener lives until destroy() aborts it.
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && instance?.overlay.isConnected === true) {
          onClose();
        }
      },
      { signal: disposable.signal },
    );

    // Focus the name input
    nameInput.focus();
  }

  function destroy(): void {
    disposable.destroy();
    instance?.destroy();
    instance = null;
  }

  return { mount, destroy };
}
