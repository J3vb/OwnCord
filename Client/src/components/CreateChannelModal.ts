/**
 * CreateChannelModal — modal for creating a new channel.
 *
 * The category is a <select> of the known categories and "No category",
 * pre-selected to the group the "+" was clicked on; the request
 * carries its `category_id`. The channel TYPE is never inferred from the
 * category: every type is offered under every category, and the type is
 * pre-selected only from the caller's hint (the synthetic Voice group's "+"
 * means another voice channel).
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { closeOnBackdropClick, createModal, type ModalInstance } from "@lib/modalFactory";
import { errorText } from "@lib/api";
import { forumsEnabled } from "@lib/serverCapabilities";
import type { MountableComponent } from "@lib/text/safeRender";
import type { ChannelType } from "@lib/types";
import {
  nextPositionInCategory,
  nextPositionInCategoryNamed,
  type CategoryRef,
} from "@stores/channels.store";
import { shellText } from "../i18n/shell";
import { MAX_CHANNEL_TOPIC_LENGTH, channelTypeLabel } from "./channelTypes";
import { buildCategorySelect, categoryFields, categoryOptionValue } from "./channelCategorySelect";

export interface CreateChannelModalOptions {
  /** The category the create affordance was invoked from (`NO_CATEGORY` = none). */
  readonly category: CategoryRef;
  /** The type to pre-select; defaults to text. */
  readonly type?: ChannelType | undefined;
  /** Called when the user submits the form. */
  readonly onCreate: (data: {
    name: string;
    type: ChannelType;
    /** The chosen category's id (0 = none); with `category` (its name) on a name-only server. */
    category_id?: number;
    category?: string;
    /** Optional; omitted when left blank. */
    topic?: string;
    /** One past the highest position in the category, so the channel lands last. */
    position: number;
  }) => Promise<void>;
  /** Called when the modal is closed without creating. */
  readonly onClose: () => void;
}

/** Every channel type is creatable under every category. */
export const CHANNEL_TYPES: readonly ChannelType[] = ["text", "voice", "announcement"] as const;

/** The types the form offers: Forum only where the server supports it. */
export function offeredChannelTypes(): readonly ChannelType[] {
  return forumsEnabled() ? [...CHANNEL_TYPES, "forum"] : CHANNEL_TYPES;
}

export function createCreateChannelModal(options: CreateChannelModalOptions): MountableComponent {
  const { category, onCreate, onClose } = options;
  const initialType: ChannelType = options.type ?? "text";
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

    // Category: a select of the known categories, "No category" first.
    const categoryGroup = createElement("div", { class: "form-group" });
    const categoryLabel = createElement(
      "label",
      { class: "form-label", for: "create-channel-category" },
      shellText("channelForm.category"),
    );
    const categorySelect = buildCategorySelect(
      "create-channel-category",
      "channel-category-select",
      categoryOptionValue(category.id, category.name),
    );
    appendChildren(categoryGroup, categoryLabel, categorySelect);

    // Channel name
    const nameGroup = createElement("div", { class: "form-group" });
    const nameLabel = createElement(
      "label",
      { class: "form-label", for: "create-channel-name" },
      shellText("channelForm.name"),
    );
    const nameInput = createElement("input", {
      id: "create-channel-name",
      class: "form-input",
      type: "text",
      placeholder: shellText(
        initialType === "voice"
          ? "channelForm.namePlaceholder.voice"
          : "channelForm.namePlaceholder.text",
      ),
      "data-testid": "channel-name-input",
    });
    appendChildren(nameGroup, nameLabel, nameInput);

    // Topic (optional, shown in the chat header)
    const topicGroup = createElement("div", { class: "form-group" });
    const topicLabel = createElement(
      "label",
      { class: "form-label", for: "create-channel-topic" },
      shellText("channelForm.topic"),
    );
    const topicInput = createElement("input", {
      id: "create-channel-topic",
      class: "form-input",
      type: "text",
      placeholder: shellText("channelForm.topicPlaceholder"),
      maxlength: String(MAX_CHANNEL_TOPIC_LENGTH),
      "data-testid": "channel-topic-input",
    });
    appendChildren(topicGroup, topicLabel, topicInput);

    // Channel type
    const typeGroup = createElement("div", { class: "form-group" });
    const typeLabel = createElement(
      "label",
      { class: "form-label", for: "create-channel-type" },
      shellText("channelForm.type"),
    );
    const typeSelect = createElement("select", {
      id: "create-channel-type",
      class: "form-input",
      "data-testid": "channel-type-select",
    });

    for (const t of offeredChannelTypes()) {
      const opt = createElement("option", { value: t }, channelTypeLabel(t));
      typeSelect.appendChild(opt);
    }
    typeSelect.value = initialType;
    appendChildren(typeGroup, typeLabel, typeSelect);

    // Error display
    const errorEl = createElement("div", {
      class: "form-group",
      style: "color: var(--text-danger); font-size: 13px; display: none;",
      "data-testid": "channel-create-error",
    });

    appendChildren(body, categoryGroup, nameGroup, topicGroup, typeGroup, errorEl);

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

    const submit = async (): Promise<void> => {
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
        const type = typeSelect.value as ChannelType;
        const topic = topicInput.value.trim();
        const fields = categoryFields(categorySelect.value);
        await onCreate({
          name,
          type,
          ...fields,
          ...(topic === "" ? {} : { topic }),
          position:
            "category_id" in fields && fields.category_id > 0
              ? nextPositionInCategory(fields.category_id, type)
              : nextPositionInCategoryNamed(fields.category ?? "", type),
        });
      } catch (err) {
        errorEl.style.display = "block";
        setText(errorEl, errorText(err, shellText("channel.createFailed")));
        createBtn.removeAttribute("disabled");
        setText(createBtn, shellText("channel.create"));
      }
    };
    createBtn.addEventListener("click", () => void submit(), { signal: disposable.signal });
    // Enter in the name field submits. Not while an IME is composing (Enter
    // then confirms the candidate), not on an empty name, not mid-submit.
    nameInput.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key !== "Enter" || isImeCommit(e)) return;
        if (nameInput.value.trim() === "" || createBtn.hasAttribute("disabled")) return;
        e.preventDefault();
        void submit();
      },
      { signal: disposable.signal },
    );

    appendChildren(footer, cancelBtn, createBtn);

    // Overlay/modal shell, dialog semantics, focus trap, focus save/restore and
    // the IME-safe Escape listener come from the shared factory; only the
    // backdrop wiring stays here, since this component's onClose is decoupled
    // from destroy() (see the caller's onClose, which calls destroy()).
    instance = createModal(
      {
        content: header,
        closeOnBackdrop: false,
        // Escape cancels — never creates.
        onEscape: () => onClose(),
        overlayAttrs: { "data-testid": "create-channel-modal" },
        ariaLabelledBy: "create-channel-title",
      },
      container,
    );
    appendChildren(instance.modal, body, footer);

    // Close on backdrop click
    closeOnBackdropClick(instance.overlay, () => onClose(), disposable.signal);

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
