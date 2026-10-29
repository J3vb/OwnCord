/**
 * The "Forum settings" section of the Edit Channel dialog: the
 * forum's tags (add, rename, emoji, reorder, remove), whether a new post needs
 * a tag, and the default auto-archive period. Loaded on demand by
 * EditChannelModal, for a forum only.
 *
 * It saves on its own button through the injected `save` (the moderation PUT),
 * independent of the dialog's channel fields, and never writes a store: the
 * `channel_update` the server broadcasts reaches channelsStore through the
 * dispatcher, and this section only reads it. A draft the admin has edited
 * absorbs a live change by id (mergeRemote), so saving, a full replace, cannot
 * delete a tag another admin just added.
 */

import { Disposable } from "@lib/disposable";
import { createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { errorText } from "@lib/api";
import type { ForumSettingsBody, ThreadAutoArchiveMinutes } from "@lib/types";
import { channelsStore, type Channel, type ChannelsState } from "@stores/channels.store";
import { forumsText } from "../../i18n/forums";
import { threadsText } from "../../i18n/threads";
import { AUTO_ARCHIVE_CHOICES } from "../threads/threadCommands";
import {
  MAX_FORUM_TAGS,
  MAX_FORUM_TAG_NAME,
  draftFromForum,
  mergeRemote,
  sentNewTags,
  type SentNewTag,
  newRowKey,
  sameDraft,
  toBody,
  validateDraft,
  type DraftProblem,
  type DraftTag,
  type ForumDraft,
} from "./forumSettingsModel";

const PERIOD_KEYS = {
  60: "period.60",
  1440: "period.1440",
  4320: "period.4320",
  10080: "period.10080",
} as const satisfies Record<ThreadAutoArchiveMinutes, string>;

export interface ForumSettingsSectionOptions {
  readonly channelId: number;
  /** The PUT behind the Save button; a rejection is shown under the form. */
  readonly save: (body: ForumSettingsBody) => Promise<void>;
}

export interface ForumSettingsSection {
  readonly element: HTMLElement;
  /** Whether the draft holds edits that are not saved yet. */
  readonly isDirty: () => boolean;
  readonly destroy: () => void;
}

const problemText = (p: DraftProblem): string => {
  switch (p.kind) {
    case "name":
      return forumsText("settings.error.name", { max: MAX_FORUM_TAG_NAME });
    case "duplicate":
      return forumsText("settings.error.duplicate");
    case "emoji":
      return forumsText("settings.error.emoji");
    default:
      return forumsText("settings.error.count", { max: MAX_FORUM_TAGS });
  }
};

export function createForumSettingsSection(
  options: ForumSettingsSectionOptions,
): ForumSettingsSection | null {
  const { channelId } = options;
  const disposable = new Disposable();
  const start = channelsStore.getState().channels.get(channelId)?.forum;
  if (start === undefined) return null;

  let base: ForumDraft = draftFromForum(start);
  let draft: ForumDraft = base;
  /**
   * The draft of the latest save, in flight or accepted: the server's
   * `channel_update` for it may beat the HTTP answer, so both count as its echo.
   */
  let savedAs: { readonly draft: ForumDraft; readonly sentNew: SentNewTag[] } | null = null;
  let saving = false;

  const root = createElement("div", { class: "form-section", "data-testid": "forum-settings" });
  root.appendChild(
    createElement("div", { class: "form-section-title" }, forumsText("settings.title")),
  );

  // Tags
  const tagsGroup = createElement("div", { class: "form-group" });
  const tagsLabelId = `forum-settings-tags-label-${channelId}`;
  const tagsLabel = createElement(
    "div",
    { class: "form-label", id: tagsLabelId },
    forumsText("settings.tags"),
  );
  const list = createElement("div", {
    class: "forum-tag-editor",
    role: "list",
    "aria-labelledby": tagsLabelId,
    "data-testid": "forum-settings-tags",
  });
  const addRow = createElement("div", { class: "forum-tag-editor-foot" });
  const addBtn = createElement(
    "button",
    { class: "forum-tag-add", type: "button", "data-testid": "forum-settings-add" },
    forumsText("settings.addTag"),
  );
  const count = createElement("span", { class: "form-hint" });
  addRow.append(addBtn, count);
  const tagsHint = createElement("div", { class: "form-hint" }, forumsText("settings.tagsHint"));
  tagsGroup.append(tagsLabel, list, addRow, tagsHint);

  // Require a tag
  const requireGroup = createElement("div", { class: "form-group" });
  const requireRow = createElement("label", { class: "form-check" });
  const requireInput = createElement("input", {
    type: "checkbox",
    "data-testid": "forum-settings-require-tag",
  });
  requireRow.append(requireInput, createElement("span", {}, forumsText("settings.requireTag")));
  requireGroup.append(
    requireRow,
    createElement("div", { class: "form-hint" }, forumsText("settings.requireTagHint")),
  );

  // Default auto-archive: the same four periods the Create Thread dialog offers.
  const archiveGroup = createElement("div", { class: "form-group" });
  const archiveId = `forum-settings-archive-${channelId}`;
  const archiveSelect = createElement("select", {
    id: archiveId,
    class: "form-input",
    "data-testid": "forum-settings-archive",
  });
  for (const minutes of AUTO_ARCHIVE_CHOICES) {
    archiveSelect.appendChild(
      createElement("option", { value: String(minutes) }, threadsText(PERIOD_KEYS[minutes])),
    );
  }
  archiveGroup.append(
    createElement("label", { class: "form-label", for: archiveId }, forumsText("settings.archive")),
    archiveSelect,
    createElement("div", { class: "form-hint" }, forumsText("settings.archiveHint")),
  );

  const note = createElement("div", {
    class: "form-hint",
    role: "status",
    "data-testid": "forum-settings-note",
  });
  note.hidden = true;
  const errorEl = createElement("div", {
    class: "forum-settings-error",
    role: "alert",
    "data-testid": "forum-settings-error",
  });
  errorEl.hidden = true;
  const saveBtn = createElement(
    "button",
    { class: "btn-primary", type: "button", "data-testid": "forum-settings-save" },
    forumsText("settings.save"),
  );
  root.append(tagsGroup, requireGroup, archiveGroup, note, errorEl, saveBtn);

  const showError = (msg: string | null): void => {
    errorEl.hidden = msg === null;
    setText(errorEl, msg ?? "");
  };
  const showNote = (msg: string | null): void => {
    note.hidden = msg === null;
    setText(note, msg ?? "");
  };

  function setTags(tags: readonly DraftTag[]): void {
    draft = { ...draft, tags };
    showError(null);
    showNote(null);
    renderTags();
  }
  function patchTag(key: number, patch: Partial<DraftTag>): void {
    draft = { ...draft, tags: draft.tags.map((t) => (t.key === key ? { ...t, ...patch } : t)) };
    showError(null);
    showNote(null);
  }
  function move(index: number, by: -1 | 1): void {
    const tags = [...draft.tags];
    const target = index + by;
    const a = tags[index];
    const b = tags[target];
    if (a === undefined || b === undefined) return;
    tags[index] = b;
    tags[target] = a;
    setTags(tags);
    // The moved row may now sit at an end, which disables that direction: keep
    // focus on the row's other move button rather than letting it fall to <body>.
    const row = list.querySelector<HTMLElement>(`[data-key="${a.key}"]`);
    const same = row?.querySelector<HTMLButtonElement>(`[data-move="${by}"]`);
    const other = row?.querySelector<HTMLButtonElement>(`[data-move="${-by}"]`);
    (same?.disabled === false ? same : other)?.focus();
  }

  function renderTags(): void {
    list.replaceChildren();
    if (draft.tags.length === 0) {
      list.appendChild(
        createElement(
          "div",
          { class: "form-hint", "data-testid": "forum-settings-no-tags" },
          forumsText("settings.noTags"),
        ),
      );
    }
    draft.tags.forEach((tag, i) => {
      const row = createElement("div", {
        class: "forum-tag-row",
        role: "listitem",
        "data-key": String(tag.key),
        "data-testid": `forum-settings-tag-${i}`,
      });
      const emoji = createElement("input", {
        class: "form-input forum-tag-row-emoji",
        type: "text",
        autocomplete: "off",
        placeholder: forumsText("settings.tagEmojiPlaceholder"),
        "aria-label": forumsText("settings.tagEmoji", { position: i + 1 }),
        "data-testid": `forum-settings-tag-emoji-${i}`,
      });
      emoji.value = tag.emoji;
      emoji.addEventListener("input", () => patchTag(tag.key, { emoji: emoji.value }), {
        signal: disposable.signal,
      });
      const name = createElement("input", {
        class: "form-input forum-tag-row-name",
        type: "text",
        autocomplete: "off",
        placeholder: forumsText("settings.tagNamePlaceholder"),
        "aria-label": forumsText("settings.tagName", { position: i + 1 }),
        "data-testid": `forum-settings-tag-name-${i}`,
      });
      name.value = tag.name;
      name.addEventListener("input", () => patchTag(tag.key, { name: name.value }), {
        signal: disposable.signal,
      });
      const label = tag.name.trim() === "" ? forumsText("settings.unnamed") : tag.name.trim();
      const button = (
        icon: "chevron-up" | "chevron-down" | "trash-2",
        text: string,
        testId: string,
        onClick: () => void,
        moveBy?: -1 | 1,
      ): HTMLButtonElement => {
        const b = createElement("button", {
          class: "forum-tag-row-btn",
          type: "button",
          "aria-label": text,
          title: text,
          "data-testid": testId,
          ...(moveBy === undefined ? {} : { "data-move": String(moveBy) }),
        });
        b.appendChild(createIcon(icon, 14));
        b.disabled = moveBy !== undefined && (i + moveBy < 0 || i + moveBy >= draft.tags.length);
        b.addEventListener("click", onClick, { signal: disposable.signal });
        return b;
      };
      row.append(
        emoji,
        name,
        button(
          "chevron-up",
          forumsText("settings.moveUp", { name: label }),
          `forum-settings-tag-up-${i}`,
          () => move(i, -1),
          -1,
        ),
        button(
          "chevron-down",
          forumsText("settings.moveDown", { name: label }),
          `forum-settings-tag-down-${i}`,
          () => move(i, 1),
          1,
        ),
        button(
          "trash-2",
          forumsText("settings.remove", { name: label }),
          `forum-settings-tag-remove-${i}`,
          () => {
            setTags(draft.tags.filter((t) => t.key !== tag.key));
            (list.querySelector("input") ?? addBtn).focus();
          },
        ),
      );
      list.appendChild(row);
    });
    setText(
      count,
      forumsText("settings.tagsCount", { count: draft.tags.length, max: MAX_FORUM_TAGS }),
    );
    addBtn.disabled = draft.tags.length >= MAX_FORUM_TAGS;
  }

  function syncControls(): void {
    requireInput.checked = draft.requireTag;
    archiveSelect.value = String(draft.autoArchive);
    renderTags();
  }

  addBtn.addEventListener(
    "click",
    () => {
      if (draft.tags.length >= MAX_FORUM_TAGS) return;
      setTags([...draft.tags, { id: 0, key: newRowKey(), name: "", emoji: "" }]);
      const inputs = list.querySelectorAll<HTMLInputElement>(".forum-tag-row-name");
      inputs[inputs.length - 1]?.focus();
    },
    { signal: disposable.signal },
  );
  requireInput.addEventListener(
    "change",
    () => {
      draft = { ...draft, requireTag: requireInput.checked };
      showError(null);
      showNote(null);
    },
    { signal: disposable.signal },
  );
  archiveSelect.addEventListener(
    "change",
    () => {
      draft = { ...draft, autoArchive: Number(archiveSelect.value) as ThreadAutoArchiveMinutes };
      showError(null);
      showNote(null);
    },
    { signal: disposable.signal },
  );

  saveBtn.addEventListener(
    "click",
    async () => {
      if (saving) return;
      const problem = validateDraft(draft);
      if (problem !== null) {
        showNote(null);
        showError(problemText(problem));
        if (problem.kind !== "count") {
          list
            .querySelector<HTMLElement>(`[data-key="${problem.key}"] .forum-tag-row-name`)
            ?.focus();
        }
        return;
      }
      saving = true;
      saveBtn.disabled = true;
      setText(saveBtn, forumsText("settings.saving"));
      showError(null);
      showNote(null);
      const sent = draft;
      const mine = { draft: sent, sentNew: sentNewTags(sent) };
      savedAs = mine;
      try {
        await options.save(toBody(sent));
        showNote(forumsText("settings.saved"));
      } catch (err) {
        if (savedAs === mine) savedAs = null;
        showError(errorText(err, forumsText("settings.error.other")));
      } finally {
        saving = false;
        saveBtn.disabled = false;
        setText(saveBtn, forumsText("settings.save"));
      }
    },
    { signal: disposable.signal },
  );

  // Live changes. An untouched draft follows the server; an edited one absorbs
  // the change by tag id; the echo of this section's own save replaces the
  // draft so the new tags pick up their ids.
  disposable.onStoreChange<ChannelsState, Channel["forum"]>(
    channelsStore,
    (state) => state.channels.get(channelId)?.forum,
    (forum) => {
      if (forum === undefined) return;
      const next = draftFromForum(forum);
      if (sameDraft(next, base)) return;
      const echo = savedAs !== null && sameDraft(stripIds(draft), stripIds(savedAs.draft));
      const clean = sameDraft(draft, base);
      const merged = echo || clean ? next : mergeRemote(draft, base, next, savedAs?.sentNew ?? []);
      const foreign = savedAs === null && !clean;
      const focus = focusedField();
      base = next;
      savedAs = null;
      draft = merged;
      syncControls();
      restoreFocus(focus);
      if (foreign) showNote(forumsText("settings.changed"));
    },
  );

  /** Which tag input has focus, so a re-render caused by a live change does not drop it. */
  function focusedField(): { key: string; cls: string; at: number | null } | null {
    const el = document.activeElement;
    const row = el instanceof HTMLInputElement ? el.closest<HTMLElement>("[data-key]") : null;
    if (!(el instanceof HTMLInputElement) || row === null || !list.contains(el)) return null;
    return {
      key: row.dataset["key"] ?? "",
      cls: el.classList.contains("forum-tag-row-name")
        ? ".forum-tag-row-name"
        : ".forum-tag-row-emoji",
      at: el.selectionStart,
    };
  }
  function restoreFocus(f: { key: string; cls: string; at: number | null } | null): void {
    if (f === null) return;
    const el = list.querySelector<HTMLInputElement>(`[data-key="${f.key}"] ${f.cls}`);
    if (el === null) return;
    el.focus();
    if (f.at !== null) el.setSelectionRange(f.at, f.at);
  }

  syncControls();
  return {
    element: root,
    isDirty: () => !sameDraft(draft, base),
    destroy: () => disposable.destroy(),
  };
}

/** A draft with the ids of unsaved-then-saved tags blanked, to compare a draft with its own echo. */
function stripIds(d: ForumDraft): ForumDraft {
  return { ...d, tags: d.tags.map((t) => ({ ...t, id: 0 })) };
}
