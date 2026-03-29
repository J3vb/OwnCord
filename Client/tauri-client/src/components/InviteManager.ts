/**
 * InviteManager component — modal overlay for managing server invites.
 * Create, copy, and revoke invite codes.
 */

import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/safe-render";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InviteItem {
  readonly code: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly uses: number;
  readonly maxUses: number | null;
  readonly expiresAt: string | null;
}

export interface InviteManagerOptions {
  invites: readonly InviteItem[];
  onCreateInvite(): Promise<InviteItem>;
  onRevokeInvite(code: string): Promise<void>;
  onCopyLink(code: string): void;
  onClose(): void;
  onError?(message: string): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maskCode(code: string): string {
  if (code.length <= 6) return code;
  return `${code.slice(0, 3)}...${code.slice(-3)}`;
}

function formatInviteInfo(invite: InviteItem): string {
  const uses = invite.maxUses !== null
    ? `${invite.uses}/${invite.maxUses} uses`
    : `${invite.uses} uses`;
  return `Created by ${invite.createdBy} \u00B7 ${uses}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInviteManager(
  options: InviteManagerOptions,
): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;
  let listEl: HTMLDivElement | null = null;
  let emptyEl: HTMLDivElement | null = null;
  let invites: readonly InviteItem[] = options.invites;

  function renderList(): void {
    if (listEl === null || emptyEl === null) return;
    clearChildren(listEl);

    if (invites.length === 0) {
      emptyEl.style.display = "";
      return;
    }

    emptyEl.style.display = "none";

    for (const invite of invites) {
      const row = createElement("div", { class: "invite-item" });

      // Top row: code + action buttons
      const headerRow = createElement("div", { class: "invite-item__header" });
      const code = createElement("span", { class: "invite-item__code" }, maskCode(invite.code));
      const actions = createElement("div", { class: "invite-item__actions" });

      const copyBtn = createElement("button", { class: "invite-item__copy" });
      copyBtn.appendChild(createIcon("external-link", 14));
      copyBtn.appendChild(document.createTextNode(" Copy"));
      copyBtn.addEventListener("click", () => {
        options.onCopyLink(invite.code);
      }, { signal: ac.signal });

      const revokeBtn = createElement("button", { class: "invite-item__revoke" });
      revokeBtn.appendChild(createIcon("trash-2", 14));
      revokeBtn.appendChild(document.createTextNode(" Revoke"));
      revokeBtn.addEventListener("click", () => {
        void options.onRevokeInvite(invite.code).then(() => {
          invites = invites.filter((i) => i.code !== invite.code);
          renderList();
        }).catch(() => {
          options.onError?.("Failed to revoke invite");
        });
      }, { signal: ac.signal });

      appendChildren(actions, copyBtn, revokeBtn);
      appendChildren(headerRow, code, actions);

      // Bottom row: meta info
      const meta = createElement("div", { class: "invite-item__meta" }, formatInviteInfo(invite));

      appendChildren(row, headerRow, meta);
      listEl.appendChild(row);
    }
  }

  function mount(container: Element): void {
    root = createElement("div", {
      class: "modal-overlay visible",
    });

    const modal = createElement("div", {
      class: "modal",
    });

    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", {}, "Server Invites");
    const closeBtn = createElement("button", { class: "modal-close" });
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", () => options.onClose(), { signal: ac.signal });
    appendChildren(header, title, closeBtn);

    // Body
    const body = createElement("div", { class: "modal-body" });
    listEl = createElement("div", { class: "invite-manager__list" });
    emptyEl = createElement("div", { class: "invite-manager__empty" }, "No active invites");
    appendChildren(body, listEl, emptyEl);

    // Footer
    const footer = createElement("div", { class: "modal-footer" });
    const createBtn = createElement("button", { class: "invite-manager__create btn-modal-save" });
    createBtn.appendChild(createIcon("external-link", 14));
    createBtn.appendChild(document.createTextNode(" Create Invite"));
    createBtn.addEventListener("click", () => {
      void options.onCreateInvite().then((newInvite) => {
        invites = [...invites, newInvite];
        renderList();
      }).catch(() => {
        options.onError?.("Failed to create invite");
      });
    }, { signal: ac.signal });
    footer.appendChild(createBtn);

    // Escape key
    document.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        options.onClose();
      }
    }, { signal: ac.signal });

    // Click overlay to close
    root.addEventListener("click", (e) => {
      if (e.target === root) {
        options.onClose();
      }
    }, { signal: ac.signal });

    appendChildren(modal, header, body, footer);
    root.appendChild(modal);
    renderList();

    container.appendChild(root);
  }

  function destroy(): void {
    ac.abort();
    if (root !== null) {
      root.remove();
      root = null;
    }
    listEl = null;
    emptyEl = null;
  }

  return { mount, destroy };
}
