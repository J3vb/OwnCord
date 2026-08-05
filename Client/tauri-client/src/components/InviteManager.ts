/**
 * InviteManager component — modal overlay for managing server invites.
 * Create, copy, and revoke invite codes.
 */

import { applyDialogSemantics, focusDialog, trapFocus } from "@lib/a11y";
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

/** How long a "Sure?" revoke stays armed before reverting. */
const CONFIRM_TIMEOUT_MS = 4000;

function maskCode(code: string): string {
  if (code.length <= 6) return code;
  return `${code.slice(0, 3)}...${code.slice(-3)}`;
}

function formatInviteInfo(invite: InviteItem): string {
  const uses =
    invite.maxUses !== null ? `${invite.uses}/${invite.maxUses} uses` : `${invite.uses} uses`;
  return `Created by ${invite.createdBy} \u00B7 ${uses}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInviteManager(options: InviteManagerOptions): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;
  let listEl: HTMLDivElement | null = null;
  let emptyEl: HTMLDivElement | null = null;
  let restoreFocus: (() => void) | null = null;
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
      copyBtn.addEventListener(
        "click",
        () => {
          options.onCopyLink(invite.code);
        },
        { signal: ac.signal },
      );

      // Revoking kills a live invite link — two-click confirm, then an
      // in-flight state so a slow revoke isn't clicked twice.
      const revokeBtn = createElement("button", { class: "invite-item__revoke" });
      const revokeLabel = document.createTextNode(" Revoke");
      revokeBtn.appendChild(createIcon("trash-2", 14));
      revokeBtn.appendChild(revokeLabel);
      let confirming = false;
      let revoking = false;
      let disarmTimer: ReturnType<typeof setTimeout> | null = null;
      const disarm = (): void => {
        confirming = false;
        if (disarmTimer !== null) {
          clearTimeout(disarmTimer);
          disarmTimer = null;
        }
        revokeLabel.nodeValue = " Revoke";
        revokeBtn.classList.remove("invite-item__revoke--confirming");
      };
      revokeBtn.addEventListener(
        "click",
        () => {
          if (revoking) return;
          if (!confirming) {
            confirming = true;
            revokeLabel.nodeValue = " Sure?";
            revokeBtn.classList.add("invite-item__revoke--confirming");
            disarmTimer = setTimeout(disarm, CONFIRM_TIMEOUT_MS);
            return;
          }
          if (disarmTimer !== null) {
            clearTimeout(disarmTimer);
            disarmTimer = null;
          }
          confirming = false;
          revoking = true;
          revokeBtn.disabled = true;
          revokeLabel.nodeValue = " Revoking...";
          void options
            .onRevokeInvite(invite.code)
            .then(() => {
              invites = invites.filter((i) => i.code !== invite.code);
              renderList();
            })
            .catch(() => {
              revoking = false;
              revokeBtn.disabled = false;
              revokeBtn.classList.remove("invite-item__revoke--confirming");
              revokeLabel.nodeValue = " Revoke";
              options.onError?.("Failed to revoke invite");
            });
        },
        { signal: ac.signal },
      );

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
    applyDialogSemantics(modal, { labelledBy: "invite-manager-title" });
    trapFocus(modal, ac.signal);

    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", { id: "invite-manager-title" }, "Server Invites");
    // Icon-only button: without a label a screen reader announces just "button".
    const closeBtn = createElement("button", { class: "modal-close", "aria-label": "Close" });
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
    const createLabel = document.createTextNode(" Create Invite");
    createBtn.appendChild(createLabel);
    createBtn.addEventListener(
      "click",
      () => {
        // Without this guard an impatient double-click mints two invites.
        if (createBtn.disabled) return;
        createBtn.disabled = true;
        createLabel.nodeValue = " Creating...";
        const done = (): void => {
          createBtn.disabled = false;
          createLabel.nodeValue = " Create Invite";
        };
        void options
          .onCreateInvite()
          .then((newInvite) => {
            invites = [...invites, newInvite];
            renderList();
            done();
          })
          .catch(() => {
            done();
            options.onError?.("Failed to create invite");
          });
      },
      { signal: ac.signal },
    );
    footer.appendChild(createBtn);

    // Escape key
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          options.onClose();
        }
      },
      { signal: ac.signal },
    );

    // Click overlay to close
    root.addEventListener(
      "click",
      (e) => {
        if (e.target === root) {
          options.onClose();
        }
      },
      { signal: ac.signal },
    );

    appendChildren(modal, header, body, footer);
    root.appendChild(modal);
    renderList();

    container.appendChild(root);

    // Capture where focus came from before anything inside the dialog takes
    // it, so destroy() can hand it back to the opener.
    restoreFocus = focusDialog(modal);
  }

  function destroy(): void {
    ac.abort();
    if (root !== null) {
      root.remove();
      root = null;
    }
    listEl = null;
    emptyEl = null;
    // Every close path (X, backdrop, Escape) funnels through the caller's
    // onClose, which calls destroy() — the single place focus returns.
    restoreFocus?.();
    restoreFocus = null;
  }

  return { mount, destroy };
}
