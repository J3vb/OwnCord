/**
 * EditChannelModal — modal for editing an existing channel's name, topic,
 * category, slow mode, NSFW flag and (for voice channels) its capacity limits.
 * Mounted only for actors holding MANAGE_CHANNELS; the server enforces the same
 * bit on the PATCH behind it.
 *
 * Category is a <select> of the known categories and "No category":
 * moving a channel between groups is an edit, not a recreate, and no category
 * is special (a voice channel groups under whatever it carries).
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
import { closeOnBackdropClick, createModal, type ModalInstance } from "@lib/ui/modalFactory";
import { errorText } from "@lib/api";
import { canManageChannels } from "@lib/permissions";
import { forumsEnabled } from "@lib/net/serverCapabilities";
import type { MountableComponent } from "@lib/text/safeRender";
import { channelsStore, type Channel, type ChannelsState } from "@stores/channels.store";
import { shellText } from "../i18n/shell";
import type { ForumSettingsSection } from "../features/forums/ForumSettingsSection";
import { forumsText } from "../i18n/forums";
import type { ForumSettingsBody } from "@lib/types";
import { channelTypeLabel, MAX_CHANNEL_TOPIC_LENGTH } from "./channelTypes";
import {
  buildCategorySelect,
  categoryFields,
  categoryOptionValue,
  setCategoryValue,
} from "./channelCategorySelect";

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

/**
 * The fields an edit submits. Mirrors the PATCH body, which is partial: only
 * the fields the user changed are present, so a field someone else changed
 * meanwhile is left as they set it.
 */
export interface EditChannelData {
  readonly name?: string;
  readonly topic?: string;
  /** The chosen category's id (0 = none); `category` carries the name on a server that sends no ids. */
  readonly category_id?: number;
  readonly category?: string;
  readonly slow_mode?: number;
  readonly nsfw?: boolean;
  /**
   * Only present for a voice channel. A text channel's PATCH omits them
   * entirely rather than sending 0, so an edit here cannot wipe limits the
   * channel carries.
   */
  readonly voice_max_users?: number;
  readonly voice_max_video?: number;
  /**
   * Voice channels only, and only when the user changed it: "" removes the
   * password, anything else sets or changes it. Absent keeps it as it is.
   */
  readonly password?: string;
}

/** The server's ceiling for a channel password, mirrored on the input. */
export const MAX_CHANNEL_PASSWORD_LENGTH = 64;

export interface EditChannelModalOptions {
  /** Current channel ID. */
  readonly channelId: number;
  /** Current channel name. */
  readonly channelName: string;
  /** Current channel type (displayed, not editable). */
  readonly channelType: string;
  /** Current channel topic ("" = none). */
  readonly channelTopic?: string;
  /** Current channel category name ("" = uncategorized). */
  readonly channelCategory?: string;
  /** Current channel category id (0 or absent = none, or a server that sends no ids). */
  readonly channelCategoryId?: number;
  /** Current cooldown in seconds (0 = off). */
  readonly channelSlowMode?: number;
  /** Whether the channel is currently flagged age-restricted. */
  readonly channelNsfw?: boolean;
  /** Current voice capacity limits (0 = unlimited). Voice channels only. */
  readonly channelVoiceMaxUsers?: number;
  readonly channelVoiceMaxVideo?: number;
  /** Whether the voice channel currently has a password. The password itself is never known here. */
  readonly channelPasswordProtected?: boolean;
  /**
   * Writes a forum's tags and settings (PUT .../forum). Its presence, a forum
   * channel, the forums capability and MANAGE_CHANNELS together show the
   * "Forum settings" section, which saves on its own button.
   */
  readonly onSaveForum?: (body: ForumSettingsBody) => Promise<void>;
  /** Called when the user saves changes. */
  readonly onSave: (data: EditChannelData) => Promise<void>;
  /** Called when the modal is closed. */
  readonly onClose: () => void;
}

const slowOf = (ch: Channel): string => String(clampSlowMode(ch.slowMode ?? 0));
const limitOf = (value: number | undefined): string => String(clampVoiceLimit(value ?? 0));

/** A labelled number input constrained to 0…MAX_VOICE_LIMIT. */
function buildVoiceLimitField(
  labelText: string,
  hintText: string,
  testId: string,
  value: number,
): { group: HTMLDivElement; input: HTMLInputElement } {
  const group = createElement("div", { class: "form-group" });
  const label = createElement("label", { class: "form-label", for: testId }, labelText);
  const input = createElement("input", {
    id: testId,
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
    channelCategoryId,
    channelSlowMode,
    channelNsfw,
    channelVoiceMaxUsers,
    channelVoiceMaxVideo,
    channelPasswordProtected,
    onSave,
    onSaveForum,
    onClose,
  } = options;
  const isVoice = channelType === "voice";
  const disposable = new Disposable();
  let instance: ModalInstance | null = null;
  let forumSection: ForumSettingsSection | null = null;
  let destroyed = false;
  /** Set once the dialog has warned about unsaved forum settings; the next close goes through. */
  let warnedForum = false;

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
    closeBtn.addEventListener("click", requestClose, { signal: disposable.signal });
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
      { class: "form-label", for: "edit-channel-name" },
      shellText("channelForm.name"),
    );
    const nameInput = createElement("input", {
      id: "edit-channel-name",
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
      { class: "form-label", for: "edit-channel-topic" },
      shellText("channelForm.topic"),
    );
    const topicInput = createElement("input", {
      id: "edit-channel-topic",
      class: "form-input",
      type: "text",
      placeholder: shellText("channelForm.topicPlaceholder"),
      maxlength: String(MAX_CHANNEL_TOPIC_LENGTH),
      "data-testid": "edit-channel-topic-input",
    });
    topicInput.value = channelTopic ?? "";
    appendChildren(topicGroup, topicLabel, topicInput);

    // Channel category: a select of the known categories, "No category" first.
    const categoryGroup = createElement("div", { class: "form-group" });
    const categoryLabel = createElement(
      "label",
      { class: "form-label", for: "edit-channel-category" },
      shellText("channelForm.category"),
    );
    const categorySelect = buildCategorySelect(
      "edit-channel-category",
      "edit-channel-category-select",
      categoryOptionValue(channelCategoryId ?? 0, channelCategory ?? ""),
    );
    appendChildren(categoryGroup, categoryLabel, categorySelect);

    // Slow mode (presets; a stored off-preset value keeps its own option)
    const currentSlowMode = clampSlowMode(channelSlowMode ?? 0);
    const slowGroup = createElement("div", { class: "form-group" });
    const slowLabel = createElement(
      "label",
      { class: "form-label", for: "edit-channel-slowmode" },
      shellText("channelForm.slowMode"),
    );
    const slowSelect = createElement("select", {
      id: "edit-channel-slowmode",
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

    // NSFW flag. The hint says what the label does: the server
    // withholds the channel's content from each member until they agree.
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

    // Password (voice channels only). The password is never shown or held
    // anywhere but this input: the section knows only whether one is set. Only
    // a change the user made is sent, so saving other fields never touches it.
    type PasswordMode = "keep" | "change" | "remove";
    let passwordSet = channelPasswordProtected === true;
    let passwordMode: PasswordMode = "keep";
    const passwordGroup = createElement("div", {
      class: "form-group",
      "data-testid": "edit-channel-password-group",
    });
    const passwordInput = createElement("input", {
      id: "edit-channel-password",
      class: "form-input",
      type: "password",
      autocomplete: "new-password",
      maxlength: String(MAX_CHANNEL_PASSWORD_LENGTH),
      "data-testid": "edit-channel-password-input",
    });
    const passwordButton = (label: string, testId: string, onClick: () => void): HTMLElement => {
      const btn = createElement(
        "button",
        { class: "btn-modal-cancel", type: "button", "data-testid": testId },
        label,
      );
      btn.addEventListener("click", onClick, { signal: disposable.signal });
      return btn;
    };
    function setPasswordMode(mode: PasswordMode): void {
      passwordMode = mode;
      if (mode !== "change") passwordInput.value = "";
      renderPassword();
      // The control that was clicked is gone: land on the one that replaced it.
      const next =
        mode === "change"
          ? passwordInput
          : passwordGroup.querySelector<HTMLElement>(
              mode === "remove"
                ? "[data-testid='edit-channel-password-keep']"
                : "[data-testid='edit-channel-password-change']",
            );
      next?.focus();
    }
    function renderPassword(): void {
      // Redrawing detaches the input, which drops focus a remote update would
      // otherwise take from someone typing.
      const hadFocus = document.activeElement === passwordInput;
      drawPassword();
      if (hadFocus && passwordInput.isConnected) passwordInput.focus();
    }
    function drawPassword(): void {
      const label = createElement(
        "label",
        { class: "form-label", for: "edit-channel-password" },
        shellText("channelForm.password"),
      );
      const hint = createElement(
        "div",
        { class: "form-hint" },
        shellText("channelForm.passwordHint"),
      );
      passwordGroup.replaceChildren(label);
      if (!passwordSet) {
        appendChildren(passwordGroup, passwordInput, hint);
        return;
      }
      if (passwordMode === "keep") {
        const row = createElement("div", { class: "form-row", style: "align-items: center;" });
        appendChildren(
          row,
          createElement(
            "span",
            { "data-testid": "edit-channel-password-set" },
            shellText("channelForm.passwordSet"),
          ),
          passwordButton(
            shellText("channelForm.passwordChange"),
            "edit-channel-password-change",
            () => setPasswordMode("change"),
          ),
          passwordButton(
            shellText("channelForm.passwordRemove"),
            "edit-channel-password-remove",
            () => setPasswordMode("remove"),
          ),
        );
        appendChildren(passwordGroup, row, hint);
      } else if (passwordMode === "change") {
        appendChildren(
          passwordGroup,
          passwordInput,
          passwordButton(shellText("channelForm.passwordKeep"), "edit-channel-password-keep", () =>
            setPasswordMode("keep"),
          ),
        );
      } else {
        appendChildren(
          passwordGroup,
          createElement(
            "div",
            { class: "form-hint", "data-testid": "edit-channel-password-removed" },
            shellText("channelForm.passwordRemoved"),
          ),
          passwordButton(shellText("channelForm.passwordUndo"), "edit-channel-password-keep", () =>
            setPasswordMode("keep"),
          ),
        );
      }
    }
    /** What the password part of the PATCH carries, undefined when the user left it alone. */
    function passwordChange(): string | undefined {
      if (!isVoice) return undefined;
      if (passwordSet && passwordMode === "remove") return "";
      if (passwordSet && passwordMode !== "change") return undefined;
      return passwordInput.value === "" ? undefined : passwordInput.value;
    }

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
      appendChildren(voiceSection, voiceHeading, users.group, video.group, passwordGroup);
      body.appendChild(voiceSection);
      renderPassword();
    }

    // Fields the user has not touched follow the store while the dialog is
    // open, and only touched fields are sent: a concurrent edit by another admin
    // is neither hidden from this form nor overwritten by its save. "Touched"
    // is the control differing from the latest server value, so typing back
    // what another admin replaced still counts as a change and is sent.
    type Mutable = { -readonly [K in keyof EditChannelData]: EditChannelData[K] };
    interface TrackedField {
      applied: string | boolean;
      readonly read: () => string | boolean;
      readonly write: (value: string | boolean) => void;
      readonly fromChannel: (ch: Channel) => string | boolean;
      readonly send: (data: Mutable) => void;
    }
    const textField = (
      input: HTMLInputElement,
      fromChannel: (ch: Channel) => string,
      send: (data: Mutable, value: string) => void,
    ): TrackedField => ({
      applied: input.value,
      read: () => input.value,
      write: (value) => {
        input.value = String(value);
      },
      fromChannel,
      send: (data) => send(data, input.value.trim()),
    });
    const fields: TrackedField[] = [
      textField(
        nameInput,
        (ch) => ch.name,
        (d, v) => {
          d.name = v;
        },
      ),
      textField(
        topicInput,
        (ch) => ch.topic,
        (d, v) => {
          d.topic = v;
        },
      ),
      {
        applied: categorySelect.value,
        read: () => categorySelect.value,
        write: (value) => setCategoryValue(categorySelect, String(value)),
        fromChannel: (ch) => categoryOptionValue(ch.categoryId ?? 0, ch.category ?? ""),
        send: (d) => Object.assign(d, categoryFields(categorySelect.value)),
      },
      {
        applied: slowSelect.value,
        read: () => slowSelect.value,
        write: (value) => {
          const v = String(value);
          if (!Array.from(slowSelect.options).some((o) => o.value === v)) {
            slowSelect.appendChild(
              createElement("option", { value: v }, formatSlowMode(Number(v))),
            );
          }
          slowSelect.value = v;
        },
        fromChannel: slowOf,
        send: (d) => {
          d.slow_mode = clampSlowMode(Number.parseInt(slowSelect.value, 10));
        },
      },
      {
        applied: nsfwInput.checked,
        read: () => nsfwInput.checked,
        write: (value) => {
          nsfwInput.checked = value === true;
        },
        fromChannel: (ch) => ch.nsfw === true,
        send: (d) => {
          d.nsfw = nsfwInput.checked;
        },
      },
    ];
    if (maxUsersInput !== null && maxVideoInput !== null) {
      const users = maxUsersInput;
      const video = maxVideoInput;
      fields.push(
        textField(
          users,
          (ch) => limitOf(ch.voiceMaxUsers),
          (d) => {
            d.voice_max_users = clampVoiceLimit(Number.parseInt(users.value, 10));
          },
        ),
        textField(
          video,
          (ch) => limitOf(ch.voiceMaxVideo),
          (d) => {
            d.voice_max_video = clampVoiceLimit(Number.parseInt(video.value, 10));
          },
        ),
      );
    }
    const touched = (f: TrackedField): boolean => f.read() !== f.applied;
    disposable.onStoreChange<ChannelsState, Channel | undefined>(
      channelsStore,
      (state) => state.channels.get(options.channelId),
      (ch) => {
        if (ch === undefined) return;
        // Another admin set or removed the password while this is open: follow
        // it, and drop a pending removal that no longer means anything.
        const nowSet = ch.passwordProtected === true;
        if (isVoice && nowSet !== passwordSet) {
          passwordSet = nowSet;
          // A flip to protected must not carry a half-typed value into "change".
          if (nowSet) passwordInput.value = "";
          else passwordMode = "keep";
          renderPassword();
        }
        for (const f of fields) {
          const next = f.fromChannel(ch);
          if (touched(f)) {
            f.applied = next;
            continue;
          }
          f.write(next);
          f.applied = f.read();
        }
      },
    );

    // Error display
    const errorEl = createElement("div", {
      class: "form-group",
      style: "color: var(--text-danger); font-size: 13px; display: none;",
      "data-testid": "edit-channel-error",
    });
    body.appendChild(errorEl);

    // Forum settings: a lazy chunk, only for a forum an admin may configure.
    if (
      channelType === "forum" &&
      onSaveForum !== undefined &&
      forumsEnabled() &&
      canManageChannels()
    ) {
      void import("../features/forums/ForumSettingsSection").then(
        ({ createForumSettingsSection }) => {
          if (destroyed) return;
          const section = createForumSettingsSection({
            channelId: options.channelId,
            save: onSaveForum,
          });
          if (section === null) return;
          forumSection = section;
          body.insertBefore(section.element, errorEl);
          section.element.addEventListener("input", rearm, { signal: disposable.signal });
          section.element.addEventListener("click", rearm, { signal: disposable.signal });
        },
        () => {
          // The chunk failed to load: the rest of the dialog still works.
        },
      );
    }

    // Footer
    const footer = createElement("div", { class: "modal-footer" });
    const cancelBtn = createElement(
      "button",
      { class: "btn-modal-cancel", type: "button" },
      shellText("common.cancel"),
    );
    cancelBtn.addEventListener("click", requestClose, { signal: disposable.signal });

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

        if (warnUnsavedForum()) return;
        const data: Mutable = {};
        for (const f of fields) if (touched(f)) f.send(data);
        const password = passwordChange();
        if (password !== undefined) data.password = password;
        // Nothing changed: there is nothing to PATCH.
        if (Object.keys(data).length === 0) {
          requestClose();
          return;
        }

        errorEl.style.display = "none";
        nameInput.classList.remove("error");
        saveBtn.setAttribute("disabled", "true");
        setText(saveBtn, shellText("channelForm.saving"));

        try {
          await onSave(data);
        } catch (err) {
          errorEl.style.display = "block";
          setText(errorEl, errorText(err, shellText("channel.updateFailed")));
          saveBtn.removeAttribute("disabled");
          setText(saveBtn, shellText("channelForm.save"));
        }
      },
      { signal: disposable.signal },
    );

    appendChildren(footer, cancelBtn, saveBtn);

    // Overlay/modal shell, dialog semantics, focus trap, focus save/restore and
    // the IME-safe Escape listener come from the shared factory; only the
    // backdrop wiring stays here, since this component's onClose is decoupled
    // from destroy() (see the caller's onClose, which calls destroy()).
    instance = createModal(
      {
        content: header,
        closeOnBackdrop: false,
        // Escape cancels — never saves; unsaved forum edits warn first.
        onEscape: () => requestClose(),
        overlayAttrs: { "data-testid": "edit-channel-modal" },
        ariaLabelledBy: "edit-channel-title",
      },
      container,
    );
    appendChildren(instance.modal, body, footer);

    // Close on backdrop click
    closeOnBackdropClick(instance.overlay, () => requestClose(), disposable.signal);

    nameInput.focus();
    nameInput.select();
  }

  const rearm = (): void => {
    warnedForum = false;
  };
  /**
   * Unsaved forum settings are never dropped silently: the first Save or close
   * with edits pending keeps the dialog open and says so; asking again discards
   * them (editing the section again re-arms the warning). No browser confirm.
   */
  function warnUnsavedForum(): boolean {
    if (forumSection?.isDirty() !== true || warnedForum) return false;
    warnedForum = true;
    const el = document.querySelector<HTMLElement>("[data-testid='edit-channel-error']");
    if (el !== null) {
      el.style.display = "block";
      setText(el, forumsText("settings.unsaved"));
    }
    return true;
  }
  function requestClose(): void {
    if (!warnUnsavedForum()) onClose();
  }

  function destroy(): void {
    destroyed = true;
    forumSection?.destroy();
    forumSection = null;
    disposable.destroy();
    instance?.destroy();
    instance = null;
  }

  return { mount, destroy };
}
