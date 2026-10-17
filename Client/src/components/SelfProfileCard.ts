/**
 * SelfProfileCard — the popout your own avatar/name opens in the user panel.
 * Holds the status menu (with the note under Do Not Disturb and Invisible),
 * the custom status line, Edit Profile (Settings → Account) and, with
 * Developer Mode on, Copy User ID.
 *
 * It is built per open and torn down on close: while shut there is no element
 * and no listener. It owns nothing about *saving* — the owner hands in the
 * same status/custom-status callbacks the status dropdown uses, so both go
 * through one presence path.
 */

import { Disposable } from "@lib/disposable";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { resolveDisplayName } from "@lib/avatar";
import type { UserStatus } from "@lib/types";
import { loadUserStatus, onUserStatusChange, MAX_CUSTOM_STATUS_LEN } from "@lib/userStatus";
import { authStore } from "@stores/auth.store";
import { membersStore } from "@stores/members.store";
import { openSettings, uiStore } from "@stores/ui.store";
import { STATUS_DEFS, type StatusDef } from "@components/statusDefs";
import { createAvatarElement } from "@components/message-list/avatar";
import { copyWithToast, isDeveloperMode } from "../features/developer-mode/developerTools";
import { shellText } from "../i18n/shell";

export interface SelfProfileCardOptions {
  /** The button that opens the card; the card anchors above it and hands
   *  focus back to it. */
  readonly trigger: HTMLElement;
  /** Whether a status can be sent right now (socket live, presence sender). */
  readonly canSetStatus: () => boolean;
  /** The authoritative current custom status ("" for none). */
  readonly getCustomStatus: () => string;
  readonly onStatusChange: (status: UserStatus) => void;
  readonly onCustomStatusChange: (text: string) => void;
}

export interface SelfProfileCard {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Close without restoring focus; for the owner's teardown. */
  destroy(): void;
}

/** Only one card may be open at a time, across every owner. */
let closeActive: (() => void) | null = null;

function ownIdentity(): { id: number | null; username: string; displayName: string | null } {
  const user = authStore.getState().user;
  return {
    id: user?.id ?? null,
    username: user?.username ?? shellText("common.unknown"),
    displayName: user?.display_name ?? null,
  };
}

export function createSelfProfileCard(options: SelfProfileCardOptions): SelfProfileCard {
  let disposable: Disposable | null = null;
  let cardEl: HTMLDivElement | null = null;

  function isOpen(): boolean {
    return cardEl !== null;
  }

  function teardown(restoreFocus: boolean): void {
    if (cardEl === null) return;
    const card = cardEl;
    const focusInside = card.contains(document.activeElement);
    const focusLost = document.activeElement === null || document.activeElement === document.body;
    disposable?.destroy();
    disposable = null;
    cardEl = null;
    card.remove();
    if (closeActive === close) closeActive = null;
    options.trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && (focusInside || focusLost)) options.trigger.focus();
  }

  function close(): void {
    teardown(true);
  }

  function open(): void {
    if (cardEl !== null) return;
    closeActive?.();
    const d = new Disposable();
    disposable = d;
    const { signal } = d;

    let status: UserStatus = loadUserStatus();
    let lastCommittedCustom = options.getCustomStatus();
    let enabled = options.canSetStatus();

    const card = createElement("div", {
      class: "self-profile-card",
      role: "dialog",
      "aria-label": shellText("status.profileLabel"),
      "data-testid": "self-profile-card",
      tabindex: "-1",
    });
    cardEl = card;

    // ---- Header: avatar + names ---------------------------------------------
    const identity = ownIdentity();
    const header = createElement("div", { class: "spc-header" });
    const avatar = createAvatarElement(
      {
        username: identity.username,
        displayName: identity.displayName,
        avatar: authStore.getState().user?.avatar ?? null,
      },
      { className: "spc-avatar", background: "var(--accent)" },
    );
    const names = createElement("div", { class: "spc-names" });
    const nameEl = createElement(
      "div",
      { class: "spc-name", "data-testid": "spc-name" },
      resolveDisplayName(identity),
    );
    const usernameEl = createElement(
      "div",
      { class: "spc-username", "data-testid": "spc-username" },
      identity.username,
    );
    const customLineEl = createElement("div", {
      class: "spc-custom-line",
      "data-testid": "spc-custom-line",
    });
    appendChildren(names, nameEl, usernameEl, customLineEl);
    appendChildren(header, avatar, names);

    function paintCustomLine(): void {
      setText(customLineEl, lastCommittedCustom);
      customLineEl.hidden = lastCommittedCustom === "";
    }
    paintCustomLine();

    // ---- Custom status row --------------------------------------------------
    const customRow = createElement("div", { class: "spc-custom" });
    const input = createElement("input", {
      class: "spc-custom-input",
      type: "text",
      placeholder: shellText("status.customPlaceholder"),
      maxlength: String(MAX_CUSTOM_STATUS_LEN),
      "aria-label": shellText("status.customLabel"),
      "data-testid": "spc-custom-input",
    });
    input.value = lastCommittedCustom;
    const clearBtn = createElement("button", {
      class: "spc-custom-clear",
      type: "button",
      title: shellText("status.clearCustom"),
      "aria-label": shellText("status.clearCustom"),
      "data-testid": "spc-custom-clear",
    });
    clearBtn.appendChild(createIcon("x", 14));
    appendChildren(customRow, input, clearBtn);

    function syncClearVisibility(): void {
      clearBtn.hidden = input.value === "" && lastCommittedCustom === "";
    }
    syncClearVisibility();

    function commitCustom(): void {
      if (cardEl !== card || !enabled) return;
      const text = input.value.trim().slice(0, MAX_CUSTOM_STATUS_LEN);
      input.value = text;
      if (text === lastCommittedCustom) return;
      lastCommittedCustom = text;
      paintCustomLine();
      syncClearVisibility();
      options.onCustomStatusChange(text);
    }

    input.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commitCustom();
          close();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          input.value = lastCommittedCustom;
          close();
        }
      },
      { signal },
    );
    input.addEventListener("input", syncClearVisibility, { signal });
    input.addEventListener("blur", commitCustom, { signal });
    clearBtn.addEventListener(
      "click",
      () => {
        if (!enabled) return;
        input.value = "";
        commitCustom();
        input.focus();
      },
      { signal },
    );

    // ---- Status options -----------------------------------------------------
    const group = createElement("div", {
      class: "spc-status-group",
      role: "radiogroup",
      "aria-label": shellText("status.change"),
    });
    const radios = new Map<UserStatus, HTMLButtonElement>();

    function paintStatus(): void {
      for (const [value, el] of radios) {
        const on = value === status;
        el.setAttribute("aria-checked", String(on));
        el.classList.toggle("spc-status--current", on);
      }
    }

    function buildStatusRadio(def: StatusDef): HTMLButtonElement {
      const btn = createElement("button", {
        class: "spc-status",
        type: "button",
        role: "radio",
        "aria-checked": "false",
        "data-testid": `spc-status-${def.value}`,
      });
      const dot = createElement("span", { class: "spc-status-dot" });
      dot.style.background = def.color;
      const text = createElement("span", { class: "spc-status-text" });
      text.appendChild(
        createElement("span", { class: "spc-status-label" }, shellText(def.labelKey)),
      );
      if (def.noteKey !== undefined) {
        text.appendChild(
          createElement(
            "span",
            { class: "spc-status-note", "data-testid": `spc-note-${def.value}` },
            shellText(def.noteKey),
          ),
        );
      }
      const check = createElement("span", { class: "spc-status-check" });
      check.appendChild(createIcon("check", 16));
      appendChildren(btn, dot, text, check);
      btn.addEventListener(
        "click",
        () => {
          if (!enabled) return;
          status = def.value;
          paintStatus();
          options.onStatusChange(def.value);
          close();
        },
        { signal },
      );
      radios.set(def.value, btn);
      return btn;
    }
    for (const def of STATUS_DEFS) group.appendChild(buildStatusRadio(def));
    paintStatus();

    function paintEnabled(): void {
      for (const btn of radios.values()) btn.disabled = !enabled;
      input.disabled = !enabled;
      clearBtn.disabled = !enabled;
    }
    paintEnabled();

    // ---- Actions ------------------------------------------------------------
    const actions = createElement("div", { class: "spc-actions" });
    const editBtn = createElement(
      "button",
      {
        class: "spc-action",
        type: "button",
        "data-testid": "spc-edit-profile",
      },
      shellText("status.editProfile"),
    );
    editBtn.addEventListener(
      "click",
      () => {
        // Close first so the focus the settings dialog remembers is the
        // trigger, not an element that is about to be removed.
        close();
        // i18n-exempt: Settings tab id; its label is settingsText("tabs.account")
        openSettings("Account");
      },
      { signal },
    );
    actions.appendChild(editBtn);

    if (isDeveloperMode() && identity.id !== null) {
      const id = identity.id;
      const copyBtn = createElement(
        "button",
        { class: "spc-action", type: "button", "data-testid": "spc-copy-id" },
        shellText("member.copyId"),
      );
      copyBtn.addEventListener(
        "click",
        () => {
          copyWithToast(String(id), "toast.userIdCopied", "toast.userIdCopyFailed");
          close();
        },
        { signal },
      );
      actions.appendChild(copyBtn);
    }

    appendChildren(
      card,
      header,
      customRow,
      createElement("div", { class: "spc-divider" }),
      group,
      createElement("div", { class: "spc-divider" }),
      actions,
    );
    document.body.appendChild(card);

    // ---- Placement: above the trigger, left edges aligned --------------------
    const rect = options.trigger.getBoundingClientRect();
    card.style.left = `${Math.max(8, rect.left)}px`;
    card.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;

    options.trigger.setAttribute("aria-expanded", "true");

    // ---- Dismissal ----------------------------------------------------------
    // Capture, so a click on a control that stops propagation (the status dot)
    // still counts as outside.
    document.addEventListener(
      "click",
      (e: MouseEvent) => {
        const target = e.target;
        if (!(target instanceof Node)) return;
        if (card.contains(target) || options.trigger.contains(target)) return;
        close();
      },
      { signal, capture: true },
    );
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          input.value = lastCommittedCustom;
          close();
        }
      },
      { signal },
    );

    // ---- Live updates while open (another device, the Account tab) ----------
    onUserStatusChange(
      (next) => {
        status = next;
        paintStatus();
      },
      { signal },
    );
    const syncCustom = (text: string): void => {
      // Never clobber text the user is typing right now.
      if (document.activeElement === input) return;
      lastCommittedCustom = text;
      input.value = text;
      paintCustomLine();
      syncClearVisibility();
    };
    d.onStoreChange(
      authStore,
      (s) => s.user,
      () => {
        const next = ownIdentity();
        setText(nameEl, resolveDisplayName(next));
        setText(usernameEl, next.username);
        syncCustom(options.getCustomStatus());
      },
    );
    d.onStoreChange(
      membersStore,
      (s) => {
        const id = authStore.getState().user?.id;
        return id === undefined ? "" : (s.members.get(id)?.customStatus ?? "");
      },
      (text: string) => syncCustom(text),
    );
    d.onStoreChange(
      uiStore,
      (s) => s.connectionStatus,
      () => {
        enabled = options.canSetStatus();
        paintEnabled();
      },
    );

    closeActive = close;
    (radios.get(status) ?? card).focus();
  }

  function toggle(): void {
    if (isOpen()) close();
    else open();
  }

  return { open, close, toggle, isOpen, destroy: () => teardown(false) };
}
