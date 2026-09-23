/**
 * EditChannelModal — modal for editing an existing channel's name, topic,
 * category, slow mode, NSFW flag and (for voice channels) its capacity limits.
 * Mounted only for actors holding MANAGE_CHANNELS; the server enforces the same
 * bit on the PATCH behind it.
 *
 * Category is free text with a <datalist> of the categories already in use:
 * moving a channel between groups is a rename, not a recreate, and no category
 * name is special (a voice channel groups under whatever it carries).
 *
 * Slow mode is a preset <select> rather than a number box. The server accepts
 * any value in 0…21600, but the useful values are a short list, and a free
 * number field mostly produces typos ("300" meant as minutes) that only surface
 * when a member cannot post for five hours. A stored value outside the presets
 * — set through the admin panel, which does offer a free number — is kept and
 * shown as its own option rather than being silently rounded to a neighbour.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createModal, type ModalInstance } from "@lib/modalFactory";
import type { MountableComponent } from "@lib/safe-render";
import { getKnownCategories } from "@stores/channels.store";
import { shellText } from "../i18n/shell";
import { channelTypeLabel } from "./CreateChannelModal";

/** The server's ceiling for `slow_mode`, mirrored so the UI cannot exceed it. */
export const MAX_SLOW_MODE_SECONDS = 21600;
/** The server's ceiling for both voice capacity limits. */
export const MAX_VOICE_LIMIT = 99;

/** Slow-mode presets, in seconds. 0 = off. */
const SLOW_MODE_PRESETS: readonly number[] = [
  0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600,
];

/** Human label for a slow-mode second count, preset or not. */
export function formatSlowMode(seconds: number): string {
  if (seconds === 0) return shellText("slowMode.off");
  if (seconds % 3600 === 0) return shellText("slowMode.hours", { count: seconds / 3600 });
  if (seconds % 60 === 0) return shellText("slowMode.minutes", { count: seconds / 60 });
  return shellText("slowMode.seconds", { count: seconds });
}

/**
 * Clamp a value into the server's accepted slow-mode range.
 * Applied to the STORED value as well as the submitted one, so a row carrying
 * something out of range still opens the modal on a legal option.
 */
export function clampSlowMode(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_SLOW_MODE_SECONDS, Math.max(0, Math.trunc(value)));
}

/**
 * Clamp a voice limit into the server's accepted range.
 *
 * A `<input type="number" max>` is advisory — typing past it, or pasting, still
 * produces the larger value — so the bound is applied here rather than trusting
 * the attribute and letting the server 400 a form the user had no way to fix.
 */
export function clampVoiceLimit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(MAX_VOICE_LIMIT, Math.max(0, Math.trunc(value)));
}

/** The fields an edit submits. Mirrors the PATCH body. */
export interface EditChannelData {
  readonly name: string;
  readonly topic: string;
  readonly category: string;
  readonly slow_mode: number;
  readonly nsfw: boolean;
  /**
   * Only present for a voice channel. A text channel's PATCH omits them
   * entirely rather than sending 0, so an edit here cannot wipe limits the
   * channel carries.
   */
  readonly voice_max_users?: number;
  readonly voice_max_video?: number;
}

export interface EditChannelModalOptions {
  /** Current channel ID. */
  readonly channelId: number;
  /** Current channel name. */
  readonly channelName: string;
  /** Current channel type (displayed, not editable). */
  readonly channelType: string;
  /** Current channel topic ("" = none). */
  readonly channelTopic?: string;
  /** Current channel category ("" = uncategorized). */
  readonly channelCategory?: string;
  /** Current cooldown in seconds (0 = off). */
  readonly channelSlowMode?: number;
  /** Whether the channel is currently flagged age-restricted. */
  readonly channelNsfw?: boolean;
  /** Current voice capacity limits (0 = unlimited). Voice channels only. */
  readonly channelVoiceMaxUsers?: number;
  readonly channelVoiceMaxVideo?: number;
  /** Called when the user saves changes. */
  readonly onSave: (data: EditChannelData) => Promise<void>;
  /** Called when the modal is closed. */
  readonly onClose: () => void;
}

/** A labelled number input constrained to 0…MAX_VOICE_LIMIT. */
function buildVoiceLimitField(
  labelText: string,
  hintText: string,
  testId: string,
  value: number,
): { group: HTMLDivElement; input: HTMLInputElement } {
  const group = createElement("div", { class: "form-group" });
  const label = createElement("label", { class: "form-label" }, labelText);
  const input = createElement("input", {
    class: "form-input",
    type: "number",
    min: "0",
    max: String(MAX_VOICE_LIMIT),
    "data-testid": testId,
  });
  input.value = String(clampVoiceLimit(value));
  const hint = createElement("div", { class: "form-hint" }, hintText);
  appendChildren(group, label, input, hint);
  return { group, input };
}

export function createEditChannelModal(options: EditChannelModalOptions): MountableComponent {
  const {
    channelName,
    channelType,
    channelTopic,
    channelCategory,
    channelSlowMode,
    channelNsfw,
    channelVoiceMaxUsers,
    channelVoiceMaxVideo,
    onSave,
    onClose,
  } = options;
  const isVoice = channelType === "voice";
  const disposable = new Disposable();
  let instance: ModalInstance | null = null;

  function mount(container: Element): void {
    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", { id: "edit-channel-title" }, shellText("channel.edit"));
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

    // Channel type (read-only)
    const typeGroup = createElement("div", { class: "form-group" });
    const typeLabel = createElement(
      "label",
      { class: "form-label" },
      shellText("channelForm.type"),
    );
    const typeDisplay = createElement("div", {
      class: "form-input",
      style: "opacity: 0.7; cursor: default;",
    });
    setText(typeDisplay, channelTypeLabel(channelType));
    appendChildren(typeGroup, typeLabel, typeDisplay);

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
      value: channelName,
      "data-testid": "edit-channel-name-input",
    });
    nameInput.value = channelName;
    appendChildren(nameGroup, nameLabel, nameInput);

    // Channel topic (optional, shown in the chat header)
    const topicGroup = createElement("div", { class: "form-group" });
    const topicLabel = createElement(
      "label",
      { class: "form-label" },
      shellText("channelForm.topic"),
    );
    const topicInput = createElement("input", {
      class: "form-input",
      type: "text",
      placeholder: shellText("channelForm.topicPlaceholder"),
      maxlength: "1024",
      "data-testid": "edit-channel-topic-input",
    });
    topicInput.value = channelTopic ?? "";
    appendChildren(topicGroup, topicLabel, topicInput);

    // Channel category (free text, suggestions from the categories in use)
    const categoryGroup = createElement("div", { class: "form-group" });
    const categoryLabel = createElement(
      "label",
      { class: "form-label" },
      shellText("channelForm.category"),
    );
    const categoryInput = createElement("input", {
      class: "form-input",
      type: "text",
      list: "edit-channel-categories",
      autocomplete: "off",
      placeholder: shellText("channelForm.categoryPlaceholder"),
      "data-testid": "edit-channel-category-input",
    });
    categoryInput.value = channelCategory ?? "";
    const categoryList = createElement("datalist", { id: "edit-channel-categories" });
    for (const known of getKnownCategories()) {
      categoryList.appendChild(createElement("option", { value: known }));
    }
    appendChildren(categoryGroup, categoryLabel, categoryInput, categoryList);

    // Slow mode (presets; a stored off-preset value keeps its own option)
    const currentSlowMode = clampSlowMode(channelSlowMode ?? 0);
    const slowGroup = createElement("div", { class: "form-group" });
    const slowLabel = createElement(
      "label",
      { class: "form-label" },
      shellText("channelForm.slowMode"),
    );
    const slowSelect = createElement("select", {
      class: "form-input",
      "data-testid": "edit-channel-slowmode-select",
    });
    const choices = SLOW_MODE_PRESETS.includes(currentSlowMode)
      ? SLOW_MODE_PRESETS
      : [...SLOW_MODE_PRESETS, currentSlowMode];
    for (const seconds of choices.toSorted((a, b) => a - b)) {
      const opt = createElement("option", { value: String(seconds) }, formatSlowMode(seconds));
      if (seconds === currentSlowMode) opt.selected = true;
      slowSelect.appendChild(opt);
    }
    const slowHint = createElement(
      "div",
      { class: "form-hint" },
      shellText("channelForm.slowModeHint"),
    );
    appendChildren(slowGroup, slowLabel, slowSelect, slowHint);

    // NSFW flag. The copy states the limit of the feature: the server does not
    // filter anything, so promising otherwise here would be a lie.
    const nsfwGroup = createElement("div", { class: "form-group" });
    const nsfwLabelRow = createElement("label", { class: "form-check" });
    const nsfwInput = createElement("input", {
      type: "checkbox",
      "data-testid": "edit-channel-nsfw-checkbox",
    });
    nsfwInput.checked = channelNsfw === true;
    const nsfwText = createElement("span", {}, shellText("channelForm.nsfw"));
    appendChildren(nsfwLabelRow, nsfwInput, nsfwText);
    const nsfwHint = createElement(
      "div",
      { class: "form-hint" },
      shellText("channelForm.nsfwHint"),
    );
    appendChildren(nsfwGroup, nsfwLabelRow, nsfwHint);

    appendChildren(body, typeGroup, nameGroup, topicGroup, categoryGroup, slowGroup, nsfwGroup);

    // Voice-only section. Rendered for a voice channel alone: the columns exist
    // on every row, but on a text channel they are values nothing reads, and
    // offering them would imply an enforcement that does not happen.
    let maxUsersInput: HTMLInputElement | null = null;
    let maxVideoInput: HTMLInputElement | null = null;
    if (isVoice) {
      const voiceSection = createElement("div", {
        class: "form-section",
        "data-testid": "edit-channel-voice-section",
      });
      const voiceHeading = createElement(
        "div",
        { class: "form-section-title" },
        shellText("channelForm.voiceLimits"),
      );
      const users = buildVoiceLimitField(
        shellText("channelForm.userLimit"),
        shellText("channelForm.userLimitHint"),
        "edit-channel-max-users-input",
        channelVoiceMaxUsers ?? 0,
      );
      const video = buildVoiceLimitField(
        shellText("channelForm.videoLimit"),
        shellText("channelForm.videoLimitHint"),
        "edit-channel-max-video-input",
        channelVoiceMaxVideo ?? 0,
      );
      maxUsersInput = users.input;
      maxVideoInput = video.input;
      appendChildren(voiceSection, voiceHeading, users.group, video.group);
      body.appendChild(voiceSection);
    }

    // Error display
    const errorEl = createElement("div", {
      class: "form-group",
      style: "color: var(--red); font-size: 13px; display: none;",
      "data-testid": "edit-channel-error",
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

    const saveBtn = createElement(
      "button",
      {
        class: "btn-modal-save",
        type: "button",
        "data-testid": "edit-channel-submit",
      },
      shellText("channelForm.save"),
    );

    saveBtn.addEventListener(
      "click",
      async () => {
        const name = nameInput.value.trim();
        if (name === "") {
          errorEl.style.display = "block";
          setText(errorEl, shellText("channelForm.nameRequired"));
          nameInput.classList.add("error");
          return;
        }

        errorEl.style.display = "none";
        nameInput.classList.remove("error");
        saveBtn.setAttribute("disabled", "true");
        setText(saveBtn, shellText("channelForm.saving"));

        const data: EditChannelData = {
          name,
          topic: topicInput.value.trim(),
          category: categoryInput.value.trim(),
          slow_mode: clampSlowMode(Number.parseInt(slowSelect.value, 10)),
          nsfw: nsfwInput.checked,
          ...(maxUsersInput !== null
            ? { voice_max_users: clampVoiceLimit(Number.parseInt(maxUsersInput.value, 10)) }
            : {}),
          ...(maxVideoInput !== null
            ? { voice_max_video: clampVoiceLimit(Number.parseInt(maxVideoInput.value, 10)) }
            : {}),
        };

        try {
          await onSave(data);
        } catch (err) {
          errorEl.style.display = "block";
          setText(errorEl, err instanceof Error ? err.message : shellText("channel.updateFailed"));
          saveBtn.removeAttribute("disabled");
          setText(saveBtn, shellText("channelForm.save"));
        }
      },
      { signal: disposable.signal },
    );

    appendChildren(footer, cancelBtn, saveBtn);

    // Overlay/modal shell, dialog semantics, focus trap and focus
    // save/restore all come from the shared factory; only the backdrop and
    // Escape wiring stay here, since this component's onClose is decoupled
    // from destroy() (see the caller's onClose, which calls destroy()).
    instance = createModal(
      {
        content: header,
        closeOnBackdrop: false,
        closeOnEscape: false,
        overlayAttrs: { "data-testid": "edit-channel-modal" },
        ariaLabelledBy: "edit-channel-title",
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

    // Escape cancels — never saves. Document-level so it works wherever focus
    // sits; guarded on the overlay still being attached because the listener
    // lives until destroy() aborts it.
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && instance?.overlay.isConnected === true) {
          onClose();
        }
      },
      { signal: disposable.signal },
    );

    nameInput.focus();
    nameInput.select();
  }

  function destroy(): void {
    disposable.destroy();
    instance?.destroy();
    instance = null;
  }

  return { mount, destroy };
}
