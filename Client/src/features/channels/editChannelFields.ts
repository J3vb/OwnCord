/**
 * The edit-channel dialog's form controls that carry a channel setting, and
 * the tracking that decides which of them the user has touched.
 */

import { createElement, appendChildren } from "@lib/dom";
import type { Channel } from "@stores/channels.store";
import { shellText } from "../../i18n/shell";
import { categoryFields, categoryOptionValue, setCategoryValue } from "./channelCategorySelect";
import {
  MAX_VOICE_LIMIT,
  SLOW_MODE_PRESETS,
  clampSlowMode,
  clampVoiceLimit,
  formatSlowMode,
} from "./editChannelLimits";

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

export type EditChannelPatch = { -readonly [K in keyof EditChannelData]: EditChannelData[K] };

const slowOf = (ch: Channel): string => String(clampSlowMode(ch.slowMode ?? 0));
const limitOf = (value: number | undefined): string => String(clampVoiceLimit(value ?? 0));

/** A labelled number input constrained to 0…MAX_VOICE_LIMIT. */
export function buildVoiceLimitField(
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

/** Slow mode (presets; a stored off-preset value keeps its own option). */
export function buildSlowModeField(channelSlowMode: number | undefined): {
  group: HTMLDivElement;
  select: HTMLSelectElement;
} {
  const currentSlowMode = clampSlowMode(channelSlowMode ?? 0);
  const group = createElement("div", { class: "form-group" });
  const label = createElement(
    "label",
    { class: "form-label", for: "edit-channel-slowmode" },
    shellText("channelForm.slowMode"),
  );
  const select = createElement("select", {
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
    select.appendChild(opt);
  }
  const hint = createElement("div", { class: "form-hint" }, shellText("channelForm.slowModeHint"));
  appendChildren(group, label, select, hint);
  return { group, select };
}

// Fields the user has not touched follow the store while the dialog is
// open, and only touched fields are sent: a concurrent edit by another admin
// is neither hidden from this form nor overwritten by its save. "Touched"
// is the control differing from the latest server value, so typing back
// what another admin replaced still counts as a change and is sent.
export interface TrackedField {
  applied: string | boolean;
  readonly read: () => string | boolean;
  readonly write: (value: string | boolean) => void;
  readonly fromChannel: (ch: Channel) => string | boolean;
  readonly send: (data: EditChannelPatch) => void;
}

const textField = (
  input: HTMLInputElement,
  fromChannel: (ch: Channel) => string,
  send: (data: EditChannelPatch, value: string) => void,
): TrackedField => ({
  applied: input.value,
  read: () => input.value,
  write: (value) => {
    input.value = String(value);
  },
  fromChannel,
  send: (data) => send(data, input.value.trim()),
});

export interface EditChannelControls {
  readonly nameInput: HTMLInputElement;
  readonly topicInput: HTMLInputElement;
  readonly categorySelect: HTMLSelectElement;
  readonly slowSelect: HTMLSelectElement;
  readonly nsfwInput: HTMLInputElement;
  /** Both present for a voice channel, both null otherwise. */
  readonly maxUsersInput: HTMLInputElement | null;
  readonly maxVideoInput: HTMLInputElement | null;
}

export function buildTrackedFields(controls: EditChannelControls): TrackedField[] {
  const { nameInput, topicInput, categorySelect, slowSelect, nsfwInput } = controls;
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
          slowSelect.appendChild(createElement("option", { value: v }, formatSlowMode(Number(v))));
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
  const users = controls.maxUsersInput;
  const video = controls.maxVideoInput;
  if (users !== null && video !== null) {
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
  return fields;
}

const touched = (f: TrackedField): boolean => f.read() !== f.applied;

/** Follow the store: untouched controls take the new value, touched ones only move their baseline. */
export function followChannel(fields: readonly TrackedField[], ch: Channel): void {
  for (const f of fields) {
    const next = f.fromChannel(ch);
    if (touched(f)) {
      f.applied = next;
      continue;
    }
    f.write(next);
    f.applied = f.read();
  }
}

/** The PATCH body of the fields the user changed. */
export function collectChanges(fields: readonly TrackedField[]): EditChannelPatch {
  const data: EditChannelPatch = {};
  for (const f of fields) if (touched(f)) f.send(data);
  return data;
}
