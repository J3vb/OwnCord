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
import { createModal } from "@lib/modalFactory";
import type { ModalInstance } from "@lib/modalFactory";
import type { MountableComponent } from "@lib/safe-render";
import { membersStore } from "@stores/members.store";
import { authStore } from "@stores/auth.store";
import { MAX_GROUP_DM_PARTICIPANTS } from "@lib/constants";

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
}

// ---------------------------------------------------------------------------
// createMemberPickerModal
// ---------------------------------------------------------------------------

/**
 * Create and mount a member picker modal. Returns a MountableComponent for
 * lifecycle management by the caller.
 */
export function createMemberPickerModal(opts: MemberPickerOptions): MountableComponent {
  let modalInstance: ModalInstance | null = null;
  const selected = new Set<number>();
  const multi = opts.onSelectGroup !== undefined;

  function mount(container: Element): void {
    const members = membersStore.getState().members;
    const currentUserId = authStore.getState().user?.id ?? 0;

    const content = createElement("div", { style: "padding:20px;" });
    const title = createElement("h3", {}, "New Direct Message");
    const subtitle = createElement(
      "p",
      { style: "color:var(--text-secondary);font-size:0.85rem;margin:0 0 8px;" },
      multi
        ? `Select one member for a DM, or up to ${MAX_GROUP_DM_PARTICIPANTS - 1} for a group`
        : "Select a member to start a conversation",
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
      maxlength: "100",
      placeholder: "Group name (optional)",
      "data-testid": "dm-group-name",
      style: "width:100%;margin-top:10px;",
    });
    nameInput.style.display = "none";

    const confirmBtn = createElement(
      "button",
      {
        class: "btn btn-primary",
        style: "margin-top:10px;width:100%;",
        "data-testid": "dm-picker-create",
      },
      "Create DM",
    );
    confirmBtn.style.display = "none";

    const close = (): void => {
      modalInstance?.close();
    };

    const refreshControls = (): void => {
      const isGroup = selected.size >= 2;
      // The name field appears only once the selection is actually a group:
      // the server refuses to name a two-person DM, so offering the field
      // there would be offering something that cannot take effect.
      nameInput.style.display = isGroup ? "" : "none";
      confirmBtn.style.display = selected.size >= 1 ? "" : "none";
      setText(confirmBtn, isGroup ? `Create Group DM (${selected.size + 1})` : "Create DM");
    };

    for (const member of members.values()) {
      if (member.id === currentUserId) continue;
      const item = createElement("div", {
        class: "dm-member-picker-item channel-item",
        "data-testid": `dm-picker-member-${member.id}`,
        style: "cursor:pointer;padding:6px 8px;display:flex;align-items:center;gap:8px;",
      });
      const avatar = createElement("div", {
        class: "dm-avatar",
        style:
          "width:28px;height:28px;border-radius:50%;background:#5865F2;display:flex;align-items:center;justify-content:center;font-size:0.75rem;color:white;flex-shrink:0;",
      });
      const label = (member.displayName ?? "") || member.username;
      setText(avatar, label.charAt(0).toUpperCase());
      const nameEl = createElement("span", {}, label);
      const statusEl = createElement(
        "span",
        {
          style: `font-size:0.75rem;margin-left:auto;color:${member.status === "online" ? "var(--green)" : "var(--text-micro)"};`,
        },
        member.status,
      );
      appendChildren(item, avatar, nameEl, statusEl);

      item.addEventListener("click", () => {
        // Single-select mode keeps the pre-group behaviour: one click, one DM.
        if (!multi) {
          close();
          opts.onSelect(member.id);
          return;
        }
        if (selected.has(member.id)) {
          selected.delete(member.id);
          item.classList.remove("selected");
          refreshControls();
          return;
        }
        // The cap counts the creator too, so the picker allows one fewer.
        if (selected.size >= MAX_GROUP_DM_PARTICIPANTS - 1) return;
        selected.add(member.id);
        item.classList.add("selected");
        refreshControls();
      });

      listContainer.appendChild(item);
    }

    // One button for both outcomes, relabelled by the selection size. A
    // separate "make it a group" control would ask the user to declare their
    // intent before picking who is in it, when the picking is the declaration.
    confirmBtn.addEventListener("click", () => {
      const ids = [...selected];
      if (ids.length === 0) return;
      if (ids.length === 1) {
        close();
        opts.onSelect(ids[0]!);
        return;
      }
      const name = nameInput.value.trim();
      close();
      opts.onSelectGroup?.(ids, name);
    });

    const cancelBtn = createElement(
      "button",
      {
        class: "btn btn-secondary",
        style: "margin-top:8px;width:100%;",
      },
      "Cancel",
    );
    cancelBtn.addEventListener("click", () => close());

    appendChildren(content, title, subtitle, listContainer, nameInput, confirmBtn, cancelBtn);

    modalInstance = createModal(
      {
        content,
        onClose: opts.onClose,
        className: "dm-member-picker-modal",
      },
      container,
    );
  }

  function destroy(): void {
    selected.clear();
    if (modalInstance !== null) {
      modalInstance.destroy();
      modalInstance = null;
    }
  }

  return { mount, destroy };
}
