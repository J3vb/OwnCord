/**
 * InviteManager component — modal overlay for managing server invites.
 * Create, copy, and revoke invite codes.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createModal, type ModalInstance } from "@lib/modalFactory";
import type { MountableComponent } from "@lib/safe-render";
import { shellText } from "../i18n/shell";

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
    invite.maxUses !== null
      ? shellText("invite.usesOfMax", { uses: invite.uses, max: invite.maxUses })
      : shellText("invite.uses", { uses: invite.uses });
  return shellText("invite.meta", { creator: invite.createdBy, uses });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInviteManager(options: InviteManagerOptions): MountableComponent {
  const disposable = new Disposable();
  let instance: ModalInstance | null = null;
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
      copyBtn.appendChild(document.createTextNode(` ${shellText("invite.copy")}`));
      copyBtn.addEventListener(
        "click",
        () => {
          options.onCopyLink(invite.code);
        },
        { signal: disposable.signal },
      );

      // Revoking kills a live invite link — two-click confirm, then an
      // in-flight state so a slow revoke isn't clicked twice.
      const revokeBtn = createElement("button", { class: "invite-item__revoke" });
      const revokeLabel = document.createTextNode(` ${shellText("invite.revoke")}`);
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
        revokeLabel.nodeValue = ` ${shellText("invite.revoke")}`;
        revokeBtn.classList.remove("invite-item__revoke--confirming");
      };
      revokeBtn.addEventListener(
        "click",
        () => {
          if (revoking) return;
          if (!confirming) {
            confirming = true;
            revokeLabel.nodeValue = ` ${shellText("invite.revokeConfirm")}`;
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
          revokeLabel.nodeValue = ` ${shellText("invite.revoking")}`;
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
              revokeLabel.nodeValue = ` ${shellText("invite.revoke")}`;
              options.onError?.(shellText("invite.revokeFailed"));
            });
        },
        { signal: disposable.signal },
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
    // Header
    const header = createElement("div", { class: "modal-header" });
    const title = createElement("h3", { id: "invite-manager-title" }, shellText("invite.title"));
    // Icon-only button: without a label a screen reader announces just "button".
    const closeBtn = createElement("button", {
      class: "modal-close",
      "aria-label": shellText("common.close"),
    });
    closeBtn.appendChild(createIcon("x", 14));
    closeBtn.addEventListener("click", () => options.onClose(), { signal: disposable.signal });
    appendChildren(header, title, closeBtn);

    // Body
    const body = createElement("div", { class: "modal-body" });
    listEl = createElement("div", { class: "invite-manager__list" });
    emptyEl = createElement("div", { class: "invite-manager__empty" }, shellText("invite.empty"));
    appendChildren(body, listEl, emptyEl);

    // Footer
    const footer = createElement("div", { class: "modal-footer" });
    const createBtn = createElement("button", { class: "invite-manager__create btn-modal-save" });
    createBtn.appendChild(createIcon("external-link", 14));
    const createLabel = document.createTextNode(` ${shellText("invite.create")}`);
    createBtn.appendChild(createLabel);
    createBtn.addEventListener(
      "click",
      () => {
        // Without this guard an impatient double-click mints two invites.
        if (createBtn.disabled) return;
        createBtn.disabled = true;
        createLabel.nodeValue = ` ${shellText("invite.creating")}`;
        const done = (): void => {
          createBtn.disabled = false;
          createLabel.nodeValue = ` ${shellText("invite.create")}`;
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
            options.onError?.(shellText("invite.createFailed"));
          });
      },
      { signal: disposable.signal },
    );
    footer.appendChild(createBtn);

    // Overlay/modal shell, dialog semantics, focus trap and focus
    // save/restore all come from the shared factory; only the backdrop and
    // Escape wiring stay here, since this component's onClose is decoupled
    // from destroy() (see the caller's onClose, which calls destroy()).
    instance = createModal(
      {
        content: header,
        closeOnBackdrop: false,
        closeOnEscape: false,
        ariaLabelledBy: "invite-manager-title",
      },
      container,
    );
    appendChildren(instance.modal, body, footer);
    renderList();

    // Escape key
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          options.onClose();
        }
      },
      { signal: disposable.signal },
    );

    // Click overlay to close
    instance.overlay.addEventListener(
      "click",
      (e) => {
        if (e.target === instance?.overlay) {
          options.onClose();
        }
      },
      { signal: disposable.signal },
    );
  }

  function destroy(): void {
    disposable.destroy();
    instance?.destroy();
    instance = null;
    listEl = null;
    emptyEl = null;
  }

  return { mount, destroy };
}
