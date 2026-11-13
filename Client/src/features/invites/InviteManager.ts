/**
 * InviteManager component — modal overlay for managing server invites.
 * Create, copy, and revoke invite codes.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, clearChildren, setOwnedTimeout } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { errorText } from "@lib/api";
import { closeOnBackdropClick, createModal, type ModalInstance } from "@lib/ui/modalFactory";
import type { MountableComponent } from "@lib/text/safeRender";
import { shellText } from "../../i18n/shell";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InviteItem {
  readonly id: number;
  readonly code: string;
  /** The creator's username; empty when the client cannot know it. */
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
  /** Name of the server the links join, for the line under the title. */
  serverName?: string | null;
  /** The shareable link for a code; defaults to the bare code. */
  formatLink?(code: string): string;
  onCreateInvite(params: InviteCreateParams): Promise<InviteItem>;
  onRevokeInvite(id: number, code: string): Promise<void>;
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

/** How many trailing characters of a code the list shows. */
const SHORT_CODE_CHARS = 8;

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

/** The server stores "no limit" as null or 0. */
function hasUseLimit(invite: InviteItem): invite is InviteItem & { maxUses: number } {
  return invite.maxUses !== null && invite.maxUses > 0;
}

function isUsedUp(invite: InviteItem): boolean {
  return hasUseLimit(invite) && invite.uses >= invite.maxUses;
}

function formatUses(invite: InviteItem): string {
  if (hasUseLimit(invite)) {
    return shellText("invite.usesOfMax", { uses: invite.uses, max: invite.maxUses });
  }
  return invite.uses === 0
    ? shellText("invite.notUsed")
    : shellText("invite.uses", { count: invite.uses });
}

/** The meta line: each part wraps as a whole, never inside itself. */
function inviteMeta(invite: InviteItem, withCreator: boolean, className: string): HTMLElement {
  const parts: string[] = [];
  if (withCreator && invite.createdBy !== "") {
    parts.push(shellText("invite.madeBy", { creator: invite.createdBy }));
  }
  parts.push(formatUses(invite), formatExpiry(invite.expiresAt));
  const meta = createElement("div", { class: className });
  parts.forEach((part, i) => {
    if (i > 0) meta.append(" · "); // i18n-exempt: list separator, not prose
    meta.appendChild(createElement("span", {}, part));
  });
  return meta;
}

function shortCode(code: string): string {
  return code.length > SHORT_CODE_CHARS ? `…${code.slice(-SHORT_CODE_CHARS)}` : code;
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
  const select = createElement("select", {
    class: "settings-select invite-manager__select",
    id,
  });
  for (const v of values) {
    const opt = createElement("option", { value: String(v) }, labelOf(v));
    opt.selected = v === selected;
    select.appendChild(opt);
  }
  wrap.appendChild(select);
  return { wrap, select };
}

function sectionHeading(text: string): HTMLElement {
  return createElement("h4", { class: "invite-manager__section-title" }, text);
}

function iconButton(
  className: string,
  icon: "copy" | "trash-2",
  label: string,
): { btn: HTMLButtonElement; label: Text } {
  const btn = createElement("button", { class: className, type: "button" });
  const text = document.createTextNode(label);
  btn.append(createIcon(icon, 14), text);
  return { btn, label: text };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInviteManager(options: InviteManagerOptions): MountableComponent {
  const disposable = new Disposable();
  let instance: ModalInstance | null = null;
  let listEl: HTMLDivElement | null = null;
  let othersEl: HTMLElement | null = null;
  let othersTitleEl: HTMLElement | null = null;
  let emptyEl: HTMLDivElement | null = null;
  let featuredEl: HTMLDivElement | null = null;
  let invites: readonly InviteItem[] = options.invites;

  const linkOf = (code: string): string => options.formatLink?.(code) ?? code;

  function copyButton(code: string, className: string, label: string): HTMLButtonElement {
    const { btn } = iconButton(className, "copy", label);
    btn.addEventListener("click", () => options.onCopyLink(code), { signal: disposable.signal });
    return btn;
  }

  function featuredInvite(): InviteItem | undefined {
    return invites.find((i) => i.code === options.featuredCode);
  }

  function renderFeatured(featured: InviteItem | undefined): void {
    if (featuredEl === null) return;
    clearChildren(featuredEl);
    featuredEl.hidden = featured === undefined;
    if (featured === undefined) return;
    const row = createElement("div", { class: "invite-manager__featured-row" });
    const full = linkOf(featured.code);
    const box = createElement("div", { class: "invite-manager__link-box", title: full });
    const link = createElement("span", { class: "invite-manager__featured-link" }, full);
    appendChildren(box, createIcon("link", 16), link);
    appendChildren(
      row,
      box,
      copyButton(
        featured.code,
        "invite-manager__featured-copy btn-modal-save",
        shellText("invite.copyLink"),
      ),
    );
    const meta = inviteMeta(featured, false, "invite-item__meta invite-manager__featured-meta");
    appendChildren(featuredEl, row, meta);
  }

  function revokeButton(invite: InviteItem): HTMLButtonElement {
    // Revoking kills a live invite link — two-click confirm, then an
    // in-flight state so a slow revoke isn't clicked twice.
    const { btn: revokeBtn, label: revokeLabel } = iconButton(
      "invite-item__revoke",
      "trash-2",
      shellText("invite.revoke"),
    );
    let confirming = false;
    let revoking = false;
    let cancelDisarm: (() => void) | null = null;
    const clearDisarm = (): void => {
      cancelDisarm?.();
      cancelDisarm = null;
    };
    const reset = (): void => {
      revokeLabel.nodeValue = shellText("invite.revoke");
      revokeBtn.classList.remove("invite-item__revoke--confirming");
    };
    const disarm = (): void => {
      confirming = false;
      clearDisarm();
      reset();
    };
    const revoke = (): void => {
      clearDisarm();
      confirming = false;
      revoking = true;
      revokeBtn.disabled = true;
      revokeLabel.nodeValue = shellText("invite.revoking");
      void options
        .onRevokeInvite(invite.id, invite.code)
        .then(() => {
          invites = invites.filter((i) => i.id !== invite.id);
          renderList();
        })
        .catch((err: unknown) => {
          revoking = false;
          revokeBtn.disabled = false;
          reset();
          options.onError?.(errorText(err, shellText("invite.revokeFailed")));
        });
    };
    revokeBtn.addEventListener(
      "click",
      () => {
        if (revoking) return;
        if (confirming) {
          revoke();
          return;
        }
        confirming = true;
        revokeLabel.nodeValue = shellText("invite.revokeConfirm");
        revokeBtn.classList.add("invite-item__revoke--confirming");
        cancelDisarm = setOwnedTimeout(disposable.signal, disarm, CONFIRM_TIMEOUT_MS);
      },
      { signal: disposable.signal },
    );
    return revokeBtn;
  }

  function inviteRow(invite: InviteItem): HTMLElement {
    const row = createElement("div", { class: "invite-item" });
    const info = createElement("div", { class: "invite-item__info" });
    const codeId = `invite-code-${invite.id}`;
    const code = createElement(
      "span",
      { class: "invite-item__code", id: codeId, title: linkOf(invite.code) },
      shortCode(invite.code),
    );
    const meta = inviteMeta(invite, true, "invite-item__meta");
    appendChildren(info, code, meta);

    const actions = createElement("div", { class: "invite-item__actions" });
    if (isUsedUp(invite)) {
      actions.appendChild(
        createElement("span", { class: "invite-item__chip" }, shellText("invite.usedUp")),
      );
    } else {
      const copyBtn = copyButton(invite.code, "invite-item__copy", shellText("invite.copy"));
      copyBtn.setAttribute("aria-describedby", codeId);
      actions.appendChild(copyBtn);
    }
    const revokeBtn = revokeButton(invite);
    revokeBtn.setAttribute("aria-describedby", codeId);
    actions.appendChild(revokeBtn);

    appendChildren(row, info, actions);
    return row;
  }

  function renderList(): void {
    if (listEl === null || emptyEl === null || othersEl === null || othersTitleEl === null) return;
    clearChildren(listEl);
    const featured = featuredInvite();
    renderFeatured(featured);

    emptyEl.hidden = invites.length !== 0;
    const others = invites.filter((i) => i !== featured);
    othersEl.hidden = others.length === 0;
    othersTitleEl.textContent = shellText(
      featured === undefined ? "invite.activeLinks" : "invite.otherLinks",
      { count: others.length },
    );
    for (const invite of others) listEl.appendChild(inviteRow(invite));
  }

  function buildCreateSection(): HTMLElement {
    const section = createElement("section", { class: "invite-manager__new" });
    const row = createElement("div", { class: "invite-manager__new-row" });
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
    const createBtn = createElement("button", {
      class: "invite-manager__create",
      type: "button",
    });
    const createLabel = document.createTextNode(shellText("invite.create"));
    createBtn.appendChild(createLabel);
    createBtn.addEventListener(
      "click",
      () => {
        // Without this guard an impatient double-click mints two invites.
        if (createBtn.disabled) return;
        createBtn.disabled = true;
        createLabel.nodeValue = shellText("invite.creating");
        const done = (): void => {
          createBtn.disabled = false;
          createLabel.nodeValue = shellText("invite.create");
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
    appendChildren(row, expiry.wrap, maxUses.wrap, createBtn);
    appendChildren(section, sectionHeading(shellText("invite.newLink")), row);
    return section;
  }

  function buildLead(): HTMLElement {
    const lead = createElement("p", { class: "invite-manager__lead" });
    const name = options.serverName?.trim() ?? "";
    if (name === "") {
      lead.textContent = shellText("invite.leadNoName");
      return lead;
    }
    // Split at a marker the name can never contain, so the name stays data
    // and the sentence stays whole for translation.
    const [before = "", after = ""] = shellText("invite.lead", { server: "\u0000" }).split(
      "\u0000",
    );
    appendChildren(lead, before, createElement("strong", {}, name), after);
    return lead;
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
    const body = createElement("div", { class: "modal-body invite-manager__body" });
    featuredEl = createElement("div", { class: "invite-manager__featured" });
    emptyEl = createElement("div", { class: "invite-manager__empty" }, shellText("invite.empty"));
    othersEl = createElement("section", { class: "invite-manager__others" });
    othersTitleEl = sectionHeading("");
    listEl = createElement("div", { class: "invite-manager__list" });
    appendChildren(othersEl, othersTitleEl, listEl);
    appendChildren(body, buildLead(), featuredEl, emptyEl, buildCreateSection(), othersEl);

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
    instance.modal.classList.add("invite-manager");
    instance.modal.appendChild(body);
    renderList();

    // Click overlay to close
    closeOnBackdropClick(instance.overlay, () => options.onClose(), disposable.signal);
  }

  function destroy(): void {
    disposable.destroy();
    instance?.destroy();
    instance = null;
    listEl = null;
    othersEl = null;
    othersTitleEl = null;
    emptyEl = null;
    featuredEl = null;
  }

  return { mount, destroy };
}
