/**
 * CreateChannelModal — modal for creating a new channel.
 *
 * The type comes first, as a radio group of cards that each say what the
 * type is for; the name field then shows that type's icon. The category is
 * a <select> of the known categories and "No category", pre-selected to the
 * group the "+" was clicked on; the request carries its `category_id`. The
 * channel TYPE is never inferred from the category: every type is offered
 * under every category, and the type is pre-selected only from the caller's
 * hint (the synthetic Voice group's "+" means another voice channel).
 */

import { Disposable } from "@lib/disposable";
import { attachLimitHint, lineHintText } from "@lib/text/nameLimits";
import { isImeCommit } from "@lib/text/ime";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { closeOnBackdropClick, createModal, type ModalInstance } from "@lib/ui/modalFactory";
import { createRadioCards } from "@lib/ui/radioCards";
import { errorText } from "@lib/api";
import { forumsEnabled } from "@lib/net/serverCapabilities";
import type { MountableComponent } from "@lib/text/safeRender";
import type { ChannelType } from "@lib/types";
import {
  nextPositionInCategory,
  nextPositionInCategoryNamed,
  type CategoryRef,
} from "@stores/channels.store";
import { shellText } from "../../i18n/shell";
import {
  MAX_CHANNEL_NAME_LENGTH,
  MAX_CHANNEL_TOPIC_LENGTH,
  channelTypeLabel,
} from "./channelTypes";
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

const TYPE_ICONS: Readonly<Record<ChannelType, IconName>> = {
  text: "hash",
  voice: "volume-2",
  announcement: "megaphone",
  forum: "messages-square",
  dm: "message-square",
};

const TYPE_HINTS = {
  text: "channelForm.typeHint.text",
  voice: "channelForm.typeHint.voice",
  announcement: "channelForm.typeHint.announcement",
  forum: "channelForm.typeHint.forum",
} as const;

/** The one-line description of what a channel type is for. */
function typeHint(type: ChannelType): string {
  return Object.hasOwn(TYPE_HINTS, type)
    ? shellText(TYPE_HINTS[type as keyof typeof TYPE_HINTS])
    : "";
}

export function createCreateChannelModal(options: CreateChannelModalOptions): MountableComponent {
  const { category, onCreate, onClose } = options;
  const initialType: ChannelType = options.type ?? "text";
  const disposable = new Disposable();
  let instance: ModalInstance | null = null;

  function mount(container: Element): void {
    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement(
      "h3",
      { id: "create-channel-title" },
      shellText("channelForm.create"),
    );
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

    // Type first: a card per type, each with a one-line hint.
    const typeGroup = createElement("div", { class: "form-group" });
    const typeLabel = createElement(
      "div",
      { class: "form-label", id: "create-channel-type-label" },
      shellText("channelForm.type"),
    );

    // Channel name, led by the chosen type's icon
    const nameGroup = createElement("div", { class: "form-group" });
    const nameLabel = createElement(
      "label",
      { class: "form-label", for: "create-channel-name" },
      shellText("channelForm.name"),
    );
    const nameField = createElement("div", { class: "input-with-icon" });
    const nameIcon = createElement("span", { class: "input-leading-icon", "aria-hidden": "true" });
    const nameInput = createElement("input", {
      id: "create-channel-name",
      class: "form-input",
      type: "text",
      "data-testid": "channel-name-input",
    });
    const showType = (type: ChannelType): void => {
      nameIcon.replaceChildren(createIcon(TYPE_ICONS[type], 16));
      nameInput.placeholder = shellText(
        type === "voice" ? "channelForm.namePlaceholder.voice" : "channelForm.namePlaceholder.text",
      );
    };
    const typeCards = createRadioCards<ChannelType>({
      signal: disposable.signal,
      labelledBy: "create-channel-type-label",
      testId: "channel-type-select",
      options: offeredChannelTypes().map((t) => ({
        value: t,
        label: channelTypeLabel(t),
        description: typeHint(t),
        icon: TYPE_ICONS[t],
      })),
      value: initialType,
      onChange: showType,
    });
    typeCards.group.id = "create-channel-type";
    appendChildren(typeGroup, typeLabel, typeCards.el);
    showType(typeCards.value());

    const nameHint = attachLimitHint(nameInput, {
      max: MAX_CHANNEL_NAME_LENGTH,
      countCharacters: true,
      hint: lineHintText(MAX_CHANNEL_NAME_LENGTH),
      id: "create-channel-name-hint",
      signal: disposable.signal,
    });
    appendChildren(nameField, nameIcon, nameInput);
    appendChildren(nameGroup, nameLabel, nameField, nameHint.el);

    // Topic (optional, shown in the chat header)
    const topicGroup = createElement("div", { class: "form-group" });
    const topicLabel = createElement(
      "label",
      { class: "form-label", for: "create-channel-topic" },
      shellText("channelForm.topic"),
    );
    topicLabel.append(
      " ",
      createElement("span", { class: "form-label-optional" }, shellText("channelForm.optional")),
    );
    const topicInput = createElement("input", {
      id: "create-channel-topic",
      class: "form-input",
      type: "text",
      placeholder: shellText("channelForm.topicPlaceholderCreate"),
      maxlength: String(MAX_CHANNEL_TOPIC_LENGTH),
      "data-testid": "channel-topic-input",
    });
    appendChildren(topicGroup, topicLabel, topicInput);

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

    // Error display
    const errorEl = createElement("div", {
      class: "form-group",
      style: "color: var(--text-danger); font-size: 13px; display: none;",
      "data-testid": "channel-create-error",
    });

    appendChildren(body, typeGroup, nameGroup, topicGroup, categoryGroup, errorEl);

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
      shellText("channelForm.create"),
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
        const type = typeCards.value();
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
        setText(createBtn, shellText("channelForm.create"));
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
