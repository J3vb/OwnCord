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

import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";
import { getKnownCategories } from "@stores/channels.store";

/** The server's ceiling for `slow_mode`, mirrored so the UI cannot exceed it. */
export const MAX_SLOW_MODE_SECONDS = 21600;
/** The server's ceiling for both voice capacity limits. */
export const MAX_VOICE_LIMIT = 99;

/** Slow-mode presets, in seconds. 0 = off. */
const SLOW_MODE_PRESETS: readonly { readonly seconds: number; readonly label: string }[] = [
  { seconds: 0, label: "Off" },
  { seconds: 5, label: "5 seconds" },
  { seconds: 10, label: "10 seconds" },
  { seconds: 15, label: "15 seconds" },
  { seconds: 30, label: "30 seconds" },
  { seconds: 60, label: "1 minute" },
  { seconds: 120, label: "2 minutes" },
  { seconds: 300, label: "5 minutes" },
  { seconds: 600, label: "10 minutes" },
  { seconds: 900, label: "15 minutes" },
  { seconds: 1800, label: "30 minutes" },
  { seconds: 3600, label: "1 hour" },
  { seconds: 7200, label: "2 hours" },
  { seconds: 21600, label: "6 hours" },
] as const;

/** Human label for a second count, for a value that is off the preset list. */
export function formatSlowMode(seconds: number): string {
  const preset = SLOW_MODE_PRESETS.find((p) => p.seconds === seconds);
  if (preset !== undefined) return preset.label;
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} seconds`;
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
    closeBtn.textContent = "";
    closeBtn.appendChild(createIcon("x", 14));
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
    });
    nameInput.value = channelName;
    appendChildren(nameGroup, nameLabel, nameInput);

    // Channel topic (optional, shown in the chat header)
    const topicGroup = createElement("div", { class: "form-group" });
    const topicLabel = createElement("label", { class: "form-label" }, "Topic");
    const topicInput = createElement("input", {
      class: "form-input",
      type: "text",
      placeholder: "What's this channel about? (optional)",
      maxlength: "1024",
      "data-testid": "edit-channel-topic-input",
    });
    topicInput.value = channelTopic ?? "";
    appendChildren(topicGroup, topicLabel, topicInput);

    // Channel category (free text, suggestions from the categories in use)
    const categoryGroup = createElement("div", { class: "form-group" });
    const categoryLabel = createElement("label", { class: "form-label" }, "Category");
    const categoryInput = createElement("input", {
      class: "form-input",
      type: "text",
      list: "edit-channel-categories",
      autocomplete: "off",
      placeholder: "Leave blank for no category",
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
    const slowLabel = createElement("label", { class: "form-label" }, "Slow Mode");
    const slowSelect = createElement("select", {
      class: "form-input",
      "data-testid": "edit-channel-slowmode-select",
    });
    const choices = SLOW_MODE_PRESETS.some((p) => p.seconds === currentSlowMode)
      ? [...SLOW_MODE_PRESETS]
      : [
          ...SLOW_MODE_PRESETS,
          { seconds: currentSlowMode, label: formatSlowMode(currentSlowMode) },
        ];
    for (const choice of choices.toSorted((a, b) => a.seconds - b.seconds)) {
      const opt = createElement("option", { value: String(choice.seconds) }, choice.label);
      if (choice.seconds === currentSlowMode) opt.selected = true;
      slowSelect.appendChild(opt);
    }
    const slowHint = createElement(
      "div",
      { class: "form-hint" },
      "Members must wait this long between messages. Holders of Manage Messages are exempt.",
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
    const nsfwText = createElement("span", {}, "Age-restricted (NSFW)");
    appendChildren(nsfwLabelRow, nsfwInput, nsfwText);
    const nsfwHint = createElement(
      "div",
      { class: "form-hint" },
      "Members see a one-time warning each session before opening the channel, and the channel is marked in the sidebar. Nothing is filtered.",
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
      const voiceHeading = createElement("div", { class: "form-section-title" }, "Voice Limits");
      const users = buildVoiceLimitField(
        "User Limit",
        "How many members may be connected at once. 0 = unlimited.",
        "edit-channel-max-users-input",
        channelVoiceMaxUsers ?? 0,
      );
      const video = buildVoiceLimitField(
        "Video Limit",
        "How many may have a camera or screen share on at once. 0 = unlimited.",
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
          setText(errorEl, err instanceof Error ? err.message : "Failed to update channel");
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
