/**
 * MemberPickerModal — a simple modal that lists server members for starting
 * a new DM conversation. Uses the shared modal factory for overlay behavior.
 */

import { createElement, setText, appendChildren } from "@lib/dom";
import { createModal } from "@lib/modalFactory";
import type { ModalInstance } from "@lib/modalFactory";
import type { MountableComponent } from "@lib/safe-render";
import { membersStore } from "@stores/members.store";
import { authStore } from "@stores/auth.store";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemberPickerOptions {
  /** Called when the user selects a member. Receives the member's user ID. */
  readonly onSelect: (userId: number) => void;
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

  function mount(container: Element): void {
    const members = membersStore.getState().members;
    const currentUserId = authStore.getState().user?.id ?? 0;

    // Build the content that goes inside the modal
    const content = createElement("div", { style: "padding:20px;" });
    const title = createElement("h3", {}, "New Direct Message");
    const subtitle = createElement("p", { style: "color:var(--text-secondary);font-size:0.85rem;margin:0 0 8px;" },
      "Select a member to start a conversation");
    const listContainer = createElement("div", {
      class: "dm-member-picker-list",
      style: "max-height:300px;overflow-y:auto;",
    });

    for (const member of members.values()) {
      if (member.id === currentUserId) continue;
      const item = createElement("div", {
        class: "dm-member-picker-item channel-item",
        style: "cursor:pointer;padding:6px 8px;display:flex;align-items:center;gap:8px;",
      });
      const avatar = createElement("div", {
        class: "dm-avatar",
        style: "width:28px;height:28px;border-radius:50%;background:#5865F2;display:flex;align-items:center;justify-content:center;font-size:0.75rem;color:white;flex-shrink:0;",
      });
      setText(avatar, member.username.charAt(0).toUpperCase());
      const nameEl = createElement("span", {}, member.username);
      const statusEl = createElement("span", {
        style: `font-size:0.75rem;margin-left:auto;color:${member.status === "online" ? "var(--green)" : "var(--text-micro)"};`,
      }, member.status);
      appendChildren(item, avatar, nameEl, statusEl);

      item.addEventListener("click", () => {
        if (modalInstance !== null) {
          modalInstance.close();
        }
        opts.onSelect(member.id);
      });
      listContainer.appendChild(item);
    }

    const cancelBtn = createElement("button", {
      class: "btn btn-secondary",
      style: "margin-top:12px;width:100%;",
    }, "Cancel");
    cancelBtn.addEventListener("click", () => {
      if (modalInstance !== null) {
        modalInstance.close();
      }
    });

    appendChildren(content, title, subtitle, listContainer, cancelBtn);

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
    if (modalInstance !== null) {
      modalInstance.destroy();
      modalInstance = null;
    }
  }

  return { mount, destroy };
}
