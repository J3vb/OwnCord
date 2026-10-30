/**
 * MemberPickerModal — lists server members for starting a DM.
 *
 * One picker covers both cases rather than two: selecting a single member
 * opens a 1:1 DM, selecting two or more creates a group. That is Discord's
 * model, and it is also the honest one — "new conversation" is one intent, and
 * making the user choose "DM" or "group DM" up front asks them to commit
 * before they have picked who is in it.
 *
 * Uses the shared modal factory for overlay behavior.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createModal } from "@lib/ui/modalFactory";
import { showToast } from "@lib/ui/toast";
import type { ModalInstance } from "@lib/ui/modalFactory";
import { Disposable } from "@lib/disposable";
import { enableRovingNavigation, setRovingTabindex } from "@lib/ui/a11y";
import type { MountableComponent } from "@lib/text/safeRender";
import { membersStore } from "@stores/members.store";
import type { Member } from "@stores/members.store";
import { createAvatarElement, pickAvatarColor } from "../../components/message-list/avatar";
import { statusLabel } from "../../i18n/shell";
import { authStore } from "@stores/auth.store";
import { MAX_GROUP_DM_PARTICIPANTS } from "@lib/constants";
import { requestsText } from "../../i18n/requests";
import { connectText } from "../../i18n/connect";
import {
  attachLimitHint,
  collapseSpaces,
  lineHintText,
  runeCount,
  MAX_GROUP_DM_NAME_LEN,
} from "@lib/text/nameLimits";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemberPickerOptions {
  /** One member picked — open a 1:1 DM. */
  readonly onSelect: (userId: number) => void;
  /**
   * Two or more picked — create a group DM. Optional: without it the picker
   * stays single-select and behaves exactly as it did before groups.
   */
  readonly onSelectGroup?: (userIds: readonly number[], name: string) => void;
  /** Called when the modal is dismissed (cancel or overlay click). */
  readonly onClose: () => void;
  /**
   * Add mode: pick people to add to an existing group. Setting
   * `onAdd` makes the picker multi-select with an "Add" button and no group
   * name; `onSelect` and `onSelectGroup` are not called. `onAdd` resolves to
   * null on success (the picker closes) or the error text to show in the
   * picker, which then stays open with the selection intact.
   */
  readonly onAdd?: (userIds: readonly number[]) => Promise<string | null>;
  /** Add mode: members who are already in the group; they are not listed. */
  readonly excludeIds?: ReadonlySet<number>;
  /** Add mode: how many more people fit. Defaults to the group-create limit. */
  readonly maxSelect?: number;
}

// ---------------------------------------------------------------------------
// createMemberPickerModal
// ---------------------------------------------------------------------------

/** Rows the roving navigation may land on: a filtered-out row is `hidden`. */
const VISIBLE_ROW = ".dm-member-picker-item:not([hidden])";

const memberLabel = (m: Member): string => (m.displayName ?? "") || m.username;
// Reachable people first (online, idle, dnd), then by the name the reader sees.
const reachable = (m: Member): number =>
  m.status === "online" || m.status === "idle" || m.status === "dnd" ? 0 : 1;

/**
 * Create and mount a member picker modal. Returns a MountableComponent for
 * lifecycle management by the caller.
 */
export function createMemberPickerModal(opts: MemberPickerOptions): MountableComponent {
  let modalInstance: ModalInstance | null = null;
  // Set once the modal is dismissed or destroyed, so a late answer to an add
  // that was still in flight does not touch a picker nobody can see.
  let closed = false;
  const selected = new Set<number>();
  const adding = opts.onAdd !== undefined;
  const multi = adding || opts.onSelectGroup !== undefined;
  const maxPicks = adding
    ? (opts.maxSelect ?? MAX_GROUP_DM_PARTICIPANTS - 1)
    : MAX_GROUP_DM_PARTICIPANTS - 1;
  // Owns the list's roving-navigation listener; dies with the modal.
  const pickerOwner = new Disposable();

  function mount(container: Element): void {
    const members = membersStore.getState().members;
    const currentUserId = authStore.getState().user?.id ?? 0;

    const content = createElement("div", { style: "padding:20px;" });
    const title = createElement(
      "h3",
      {},
      adding ? requestsText("picker.addTitle") : requestsText("picker.title"),
    );
    const subtitle = createElement(
      "p",
      { style: "color:var(--text-secondary);font-size:0.85rem;margin:0 0 8px;" },
      adding
        ? requestsText("picker.addHint", { max: String(maxPicks) })
        : multi
          ? requestsText("picker.groupHint", { max: String(MAX_GROUP_DM_PARTICIPANTS - 1) })
          : requestsText("picker.singleHint"),
    );
    const listContainer = createElement("div", {
      class: "dm-member-picker-list",
      style: "max-height:300px;overflow-y:auto;",
    });

    // Group name field, revealed only once the selection is actually a group:
    // asking a 1:1 DM to be named would be asking for something that has no
    // effect (the server refuses to name a two-person DM).
    const nameInput = createElement("input", {
      class: "dm-group-name-input",
      type: "text",
      placeholder: requestsText("picker.groupNamePlaceholder"),
      "data-testid": "dm-group-name",
      style: "width:100%;margin-top:10px;",
    });
    nameInput.style.display = "none";
    const nameHint = attachLimitHint(nameInput, {
      max: MAX_GROUP_DM_NAME_LEN,
      hint: lineHintText(MAX_GROUP_DM_NAME_LEN),
      countCharacters: true,
      id: "dm-group-name-hint",
      signal: pickerOwner.signal,
    });
    nameHint.el.style.display = "none";

    const confirmBtn = createElement(
      "button",
      {
        class: "btn btn-primary",
        style: "margin-top:10px;width:100%;",
        "data-testid": "dm-picker-create",
      },
      adding ? requestsText("picker.add") : requestsText("picker.create"),
    );
    confirmBtn.style.display = "none";
    // Add mode: a server refusal lands here, in the picker, not in a toast.
    const errorEl = createElement(
      "p",
      { class: "dm-member-picker-error", role: "alert", "data-testid": "dm-picker-error" },
      "",
    );
    errorEl.hidden = true;

    const close = (): void => {
      modalInstance?.close();
    };

    const refreshControls = (): void => {
      const isGroup = !adding && selected.size >= 2;
      // The name field appears only once the selection is actually a group:
      // the server refuses to name a two-person DM, so offering the field
      // there would be offering something that cannot take effect.
      nameInput.style.display = isGroup ? "" : "none";
      nameHint.el.style.display = isGroup ? "" : "none";
      confirmBtn.style.display = selected.size >= 1 ? "" : "none";
      renderChips();
      if (adding) return;
      setText(
        confirmBtn,
        isGroup
          ? requestsText("picker.createGroup", { count: String(selected.size + 1) })
          : requestsText("picker.create"),
      );
    };

    // Search, chips and the empty notice sit around the list. Rows are built
    // once and only re-ordered/filtered, so typing never refetches an avatar
    // and the selection (a Set of ids) survives every filter.
    const searchInput = createElement("input", {
      class: "dm-member-picker-search",
      type: "text",
      autofocus: "",
      autocomplete: "off",
      placeholder: requestsText("picker.searchPlaceholder"),
      "aria-label": requestsText("picker.searchLabel"),
      "data-testid": "dm-picker-search",
    });
    const chips = createElement("div", {
      class: "dm-member-picker-chips",
      "data-testid": "dm-picker-chips",
    });
    chips.hidden = true;
    const emptyNotice = createElement(
      "p",
      { class: "dm-member-picker-empty", role: "status", "data-testid": "dm-picker-empty" },
      requestsText("picker.noMatches"),
    );
    emptyNotice.hidden = true;

    interface PickerRow {
      readonly member: Member;
      readonly label: string;
      readonly item: HTMLElement;
    }
    const rows: PickerRow[] = [];
    const rowById = new Map<number, PickerRow>();

    const candidates = [...members.values()]
      .filter((m) => m.id !== currentUserId && opts.excludeIds?.has(m.id) !== true)
      .toSorted(
        (a, b) =>
          reachable(a) - reachable(b) ||
          memberLabel(a).localeCompare(memberLabel(b), undefined, { sensitivity: "base" }) ||
          a.id - b.id,
      );

    const toggle = (row: PickerRow): void => {
      const { member, item } = row;
      if (selected.has(member.id)) {
        selected.delete(member.id);
        item.classList.remove("selected");
        refreshControls();
        return;
      }
      // The cap counts the creator too, so the picker allows one fewer; add
      // mode is limited to the slots the group has left.
      if (selected.size >= maxPicks) return;
      selected.add(member.id);
      item.classList.add("selected");
      refreshControls();
    };

    function renderChips(): void {
      const nodes: HTMLElement[] = [];
      for (const id of selected) {
        const row = rowById.get(id);
        if (row === undefined) continue;
        const chip = createElement(
          "button",
          {
            type: "button",
            class: "dm-member-picker-chip",
            "data-testid": `dm-picker-chip-${id}`,
            "aria-label": requestsText("picker.removeChip", { name: row.label }),
          },
          row.label,
        );
        chip.appendChild(createElement("span", { "aria-hidden": "true" }, " \u00d7"));
        chip.addEventListener("click", () => {
          toggle(row);
          searchInput.focus();
        });
        nodes.push(chip);
      }
      chips.replaceChildren(...nodes);
      chips.hidden = nodes.length === 0;
    }

    function applyFilter(): void {
      const q = searchInput.value.trim().toLowerCase();
      const shown = rows.filter(
        (r) =>
          q === "" ||
          r.label.toLowerCase().includes(q) ||
          r.member.username.toLowerCase().includes(q),
      );
      // Hide, don't detach: a row filtered out before its avatar loads still
      // gets its picture, and the selection marks stay on the elements.
      for (const r of rows) r.item.hidden = !shown.includes(r);
      emptyNotice.hidden = shown.length > 0;
      for (const r of rows) r.item.setAttribute("tabindex", "-1");
      setRovingTabindex(listContainer, VISIBLE_ROW);
    }

    for (const member of candidates) {
      const label = memberLabel(member);
      const item = createElement("div", {
        class: "dm-member-picker-item channel-item",
        "data-testid": `dm-picker-member-${member.id}`,
        // Roving list item: reachable by Tab once, then arrow-stepped. Without
        // this the modal's focus trap could only reach the input and buttons,
        // so the picker was mouse-only — and it is the only way to start a DM.
        role: "button",
        tabindex: "-1",
        // Layout lives in group-dms.css: an inline display would beat [hidden].
        style: "cursor:pointer;",
      });
      const avatar = createAvatarElement(member, {
        className: "dm-avatar dm-member-picker-avatar",
        background: pickAvatarColor(member.username),
        decorative: true,
      });
      const nameEl = createElement("span", {}, label);
      const statusEl = createElement(
        "span",
        {
          style: `font-size:0.75rem;margin-left:auto;color:${member.status === "online" ? "var(--green)" : "var(--text-micro)"};`,
        },
        statusLabel(member.status),
      );
      appendChildren(item, avatar, nameEl, statusEl);

      const row: PickerRow = { member, label, item };
      rows.push(row);
      rowById.set(member.id, row);

      item.addEventListener("click", () => {
        // Single-select mode keeps the pre-group behaviour: one click, one DM.
        if (!multi) {
          close();
          opts.onSelect(member.id);
          return;
        }
        toggle(row);
      });
    }

    searchInput.addEventListener("input", applyFilter);
    searchInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown") return;
      const first = listContainer.querySelector<HTMLElement>(VISIBLE_ROW);
      if (first === null) return;
      e.preventDefault();
      for (const r of rows) r.item.setAttribute("tabindex", "-1");
      first.setAttribute("tabindex", "0");
      first.focus();
    });

    // One Tab stop enters the list; ArrowUp/Down step rows and Enter/Space
    // activate the focused one (a roving list, as the DM sidebar rows do).
    listContainer.append(...rows.map((r) => r.item));
    applyFilter();
    // Registered before the roving handler so ArrowUp on the first visible row
    // returns to the search box instead of clamping in place.
    listContainer.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key !== "ArrowUp" || e.altKey || e.ctrlKey || e.metaKey) return;
        const first = listContainer.querySelector<HTMLElement>(VISIBLE_ROW);
        if (first === null || e.target !== first) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        searchInput.focus();
      },
      { signal: pickerOwner.signal },
    );
    enableRovingNavigation(listContainer, VISIBLE_ROW, pickerOwner.signal, "vertical");

    // One button for both outcomes, relabelled by the selection size. A
    // separate "make it a group" control would ask the user to declare their
    // intent before picking who is in it, when the picking is the declaration.
    confirmBtn.addEventListener("click", () => {
      const ids = [...selected];
      if (ids.length === 0) return;
      if (opts.onAdd !== undefined) {
        const onAdd = opts.onAdd;
        errorEl.hidden = true;
        confirmBtn.disabled = true;
        onAdd(ids)
          .then((failure) => {
            if (closed) {
              // Dismissed while the add was in flight: say how it ended.
              if (failure !== null) showToast(failure, "error");
              return;
            }
            if (failure === null) {
              close();
              return;
            }
            setText(errorEl, failure);
            errorEl.hidden = false;
            confirmBtn.disabled = false;
          })
          .catch(() => {
            confirmBtn.disabled = false;
          });
        return;
      }
      if (ids.length === 1) {
        close();
        opts.onSelect(ids[0]!);
        return;
      }
      // Collapsed like the server stores it: what is checked is what is sent.
      const name = collapseSpaces(nameInput.value);
      // A pasted or scripted name past the limit would be refused by the
      // server: keep the picker open with the hint and the typed name.
      if (runeCount(name) > MAX_GROUP_DM_NAME_LEN) {
        nameHint.showError(connectText("limits.groupNameTooLong", { max: MAX_GROUP_DM_NAME_LEN }));
        return;
      }
      close();
      opts.onSelectGroup?.(ids, name);
    });

    const cancelBtn = createElement(
      "button",
      {
        class: "btn btn-secondary",
        style: "margin-top:8px;width:100%;",
      },
      requestsText("picker.cancel"),
    );
    cancelBtn.addEventListener("click", () => close());

    appendChildren(
      content,
      title,
      subtitle,
      searchInput,
      chips,
      listContainer,
      emptyNotice,
      ...(adding ? [] : [nameInput, nameHint.el]),
      errorEl,
      confirmBtn,
      cancelBtn,
    );

    modalInstance = createModal(
      {
        content,
        onClose: () => {
          closed = true;
          opts.onClose();
        },
        className: "dm-member-picker-modal",
      },
      container,
    );
    searchInput.focus();
  }

  function destroy(): void {
    closed = true;
    selected.clear();
    pickerOwner.destroy();
    if (modalInstance !== null) {
      modalInstance.destroy();
      modalInstance = null;
    }
  }

  return { mount, destroy };
}
