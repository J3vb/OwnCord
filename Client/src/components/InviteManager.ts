/**
 * InviteManager component — modal overlay for managing server invites.
 * Create, copy, and revoke invite codes.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { errorText } from "@lib/api";
import { closeOnBackdropClick, createModal, type ModalInstance } from "@lib/modalFactory";
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

/** What a new invite is created with: 0 hours = never expires, 0 uses = no limit. */
export interface InviteCreateParams {
  readonly expiresInHours: number;
  readonly maxUses: number;
}

/** Expiry choices in hours (0 = never). The default is 7 days. */
const EXPIRY_HOURS = [1, 6, 12, 24, 168, 720, 0] as const;
const DEFAULT_EXPIRY_HOURS = 168;
/** Max-use choices (0 = no limit). */
const MAX_USES = [0, 1, 5, 10, 25, 50, 100] as const;

export interface InviteManagerOptions {
  invites: readonly InviteItem[];
  /** Code of the invite shown at the top with a prominent Copy button. */
  featuredCode?: string | null;
  /** The shareable link for a code; defaults to the bare code. */
  formatLink?(code: string): string;
  onCreateInvite(params: InviteCreateParams): Promise<InviteItem>;
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

const HOUR_MS = 3_600_000;

function formatExpiry(expiresAt: string | null): string {
  if (expiresAt === null) return shellText("invite.expiresNever");
  const remaining = Date.parse(expiresAt) - Date.now();
  if (Number.isNaN(remaining) || remaining <= 0) return shellText("invite.expired");
  const hours = remaining / HOUR_MS;
  const when =
    hours >= 24
      ? shellText("invite.days", { count: Math.round(hours / 24) })
      : shellText("invite.hours", { count: Math.max(1, Math.round(hours)) });
  return shellText("invite.expiresIn", { when });
}

function formatInviteInfo(invite: InviteItem): string {
  // The server stores "no limit" as null or 0.
  const uses =
    invite.maxUses !== null && invite.maxUses > 0
      ? shellText("invite.usesOfMax", { uses: invite.uses, max: invite.maxUses })
      : shellText("invite.uses", { uses: invite.uses });
  return shellText("invite.meta", {
    creator: invite.createdBy,
    uses,
    expiry: formatExpiry(invite.expiresAt),
  });
}

function expiryLabel(hours: number): string {
  if (hours === 0) return shellText("invite.never");
  return hours % 24 === 0
    ? shellText("invite.days", { count: hours / 24 })
    : shellText("invite.hours", { count: hours });
}

function makeSelect(
  id: string,
  label: string,
  values: readonly number[],
  labelOf: (v: number) => string,
  selected: number,
): { wrap: HTMLElement; select: HTMLSelectElement } {
  const wrap = createElement("label", { class: "invite-manager__field" });
  wrap.appendChild(createElement("span", { class: "invite-manager__field-label" }, label));
  const select = createElement("select", { class: "invite-manager__select", id });
  for (const v of values) {
    const opt = createElement("option", { value: String(v) }, labelOf(v));
    opt.selected = v === selected;
    select.appendChild(opt);
  }
  wrap.appendChild(select);
  return { wrap, select };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInviteManager(options: InviteManagerOptions): MountableComponent {
  const disposable = new Disposable();
  let instance: ModalInstance | null = null;
  let listEl: HTMLDivElement | null = null;
  let emptyEl: HTMLDivElement | null = null;
  let featuredEl: HTMLDivElement | null = null;
  let invites: readonly InviteItem[] = options.invites;

  const linkOf = (code: string): string => options.formatLink?.(code) ?? code;

  function copyButton(code: string, extraClass: string): HTMLButtonElement {
    const btn = createElement("button", { class: extraClass });
    btn.appendChild(createIcon("external-link", 14));
    btn.appendChild(document.createTextNode(` ${shellText("invite.copy")}`));
    btn.addEventListener("click", () => options.onCopyLink(code), { signal: disposable.signal });
    return btn;
  }

  function renderFeatured(): void {
    if (featuredEl === null) return;
    clearChildren(featuredEl);
    const featured = invites.find((i) => i.code === options.featuredCode);
    featuredEl.style.display = featured === undefined ? "none" : "";
    if (featured === undefined) return;
    const label = createElement(
      "div",
      { class: "invite-manager__featured-label" },
      shellText("invite.featured"),
    );
    const row = createElement("div", { class: "invite-manager__featured-row" });
    const link = createElement(
      "span",
      { class: "invite-manager__featured-link" },
      linkOf(featured.code),
    );
    appendChildren(
      row,
      link,
      copyButton(featured.code, "invite-manager__featured-copy btn-modal-save"),
    );
    const meta = createElement("div", { class: "invite-item__meta" }, formatInviteInfo(featured));
    appendChildren(featuredEl, label, row, meta);
  }

  function renderList(): void {
    if (listEl === null || emptyEl === null) return;
    clearChildren(listEl);
    renderFeatured();

    if (invites.length === 0) {
      emptyEl.style.display = "";
      return;
    }

    emptyEl.style.display = "none";

    for (const invite of invites) {
      const row = createElement("div", { class: "invite-item" });

      // Top row: code + action buttons
      const headerRow = createElement("div", { class: "invite-item__header" });
      const code = createElement("span", { class: "invite-item__code" }, linkOf(invite.code));
      const actions = createElement("div", { class: "invite-item__actions" });

      const copyBtn = copyButton(invite.code, "invite-item__copy");

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
            .catch((err: unknown) => {
              revoking = false;
              revokeBtn.disabled = false;
              revokeBtn.classList.remove("invite-item__revoke--confirming");
              revokeLabel.nodeValue = ` ${shellText("invite.revoke")}`;
              options.onError?.(errorText(err, shellText("invite.revokeFailed")));
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
    featuredEl = createElement("div", { class: "invite-manager__featured" });
    appendChildren(body, featuredEl, listEl, emptyEl);

    // Footer
    const footer = createElement("div", { class: "modal-footer" });
    const expiry = makeSelect(
      "invite-expiry",
      shellText("invite.expireAfter"),
      EXPIRY_HOURS,
      expiryLabel,
      DEFAULT_EXPIRY_HOURS,
    );
    const maxUses = makeSelect(
      "invite-max-uses",
      shellText("invite.maxUses"),
      MAX_USES,
      (v) => (v === 0 ? shellText("invite.noLimit") : String(v)),
      0,
    );
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
          .onCreateInvite({
            expiresInHours: Number(expiry.select.value),
            maxUses: Number(maxUses.select.value),
          })
          .then((newInvite) => {
            invites = [...invites, newInvite];
            renderList();
            done();
          })
          .catch((err: unknown) => {
            done();
            options.onError?.(errorText(err, shellText("invite.createFailed")));
          });
      },
      { signal: disposable.signal },
    );
    appendChildren(footer, expiry.wrap, maxUses.wrap, createBtn);

    // Overlay/modal shell, dialog semantics, focus trap, focus save/restore and
    // the IME-safe Escape listener come from the shared factory; only the
    // backdrop wiring stays here, since this component's onClose is decoupled
    // from destroy() (see the caller's onClose, which calls destroy()).
    instance = createModal(
      {
        content: header,
        closeOnBackdrop: false,
        onEscape: () => options.onClose(),
        ariaLabelledBy: "invite-manager-title",
      },
      container,
    );
    appendChildren(instance.modal, body, footer);
    renderList();

    // Click overlay to close
    closeOnBackdropClick(instance.overlay, () => options.onClose(), disposable.signal);
  }

  function destroy(): void {
    disposable.destroy();
    instance?.destroy();
    instance = null;
    listEl = null;
    emptyEl = null;
    featuredEl = null;
  }

  return { mount, destroy };
}
