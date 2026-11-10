/**
 * SelfProfileCard — the popout your own avatar, status dot or name opens in
 * the user panel: the one status menu. Holds the statuses (with the note
 * under Do Not Disturb and Invisible), the custom status line, Edit Profile
 * (the Account tab's profile editor) and, with Developer Mode on, Copy User ID.
 *
 * It is built per open and torn down on close: while shut there is no element
 * and no listener. It owns nothing about *saving* — the owner hands in the
 * status and custom-status callbacks, so every change goes through one
 * presence path.
 */

import { Disposable } from "@lib/disposable";
import { isImeCommit } from "@lib/text/ime";
import { createElement, appendChildren } from "@lib/dom";
import { isPhoneLayout, openBottomSheet } from "@lib/ui/bottomSheet";
import { loadUserStatus, onStatusTimerChange, onUserStatusChange } from "@lib/presence/userStatus";
import { authStore } from "@stores/auth.store";
import { membersStore } from "@stores/members.store";
import { openSettings, uiStore } from "@stores/ui.store";
import { copyWithToast, isDeveloperMode } from "../developer-mode/developerTools";
import { shellText } from "../../i18n/shell";
import { buildCustomStatus, type CustomStatusPart } from "./selfProfileCustomStatus";
import { buildHeader, ownIdentity, type HeaderPart, type OwnIdentity } from "./selfProfileHeader";
import { buildStatusList, type StatusListPart } from "./selfProfileStatusList";
import type { CardSession, SelfProfileCard, SelfProfileCardOptions } from "./selfProfileTypes";

export type { SelfProfileCard, SelfProfileCardOptions } from "./selfProfileTypes";

/** Only one card may be open at a time, across every owner. */
let closeActive: (() => void) | null = null;

/** The parts one open card is made of. */
interface CardParts {
  readonly header: HeaderPart;
  readonly custom: CustomStatusPart;
  readonly list: StatusListPart;
}

/** Edit Profile, and Copy User ID in Developer Mode. */
function buildActions(s: CardSession, identity: OwnIdentity): HTMLElement {
  const { signal } = s;
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
      s.close();
      // i18n-exempt: Settings request id; opens the Account tab's profile editor
      openSettings("Profile");
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
        s.close();
      },
      { signal },
    );
    actions.appendChild(copyBtn);
  }
  return actions;
}

/** Put the card on screen and return what a click must land outside of to close it. */
function mountCard(s: CardSession, onSheetClosed: () => void): HTMLElement {
  const { card, options } = s;
  if (isPhoneLayout()) {
    // A phone gets the card as a bottom sheet, like every other profile; the
    // sheet is the dialog.
    card.removeAttribute("role");
    card.removeAttribute("aria-label");
    return openBottomSheet({
      label: shellText("status.profileLabel"),
      content: card,
      className: "self-profile-sheet",
      testId: "self-profile-sheet",
      signal: s.signal,
      focusFirst: false,
      fallbackFocus: () => (options.trigger.isConnected ? options.trigger : null),
      onClosed: onSheetClosed,
    }).panel;
  }
  document.body.appendChild(card);
  // ---- Placement: above the trigger, left edges aligned ------------------
  const rect = options.trigger.getBoundingClientRect();
  card.style.left = `${Math.max(8, rect.left)}px`;
  card.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
  return card;
}

function watchDismissal(s: CardSession, host: HTMLElement, custom: CustomStatusPart): void {
  const { signal, options } = s;
  // Capture, so a click on a control that stops propagation (the status dot)
  // still counts as outside.
  document.addEventListener(
    "click",
    (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (host.contains(target) || options.trigger.contains(target)) return;
      s.close();
    },
    { signal, capture: true },
  );
  document.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      // The emoji picker already took this Escape (closing itself).
      if (e.key === "Escape" && !isImeCommit(e) && !e.defaultPrevented) {
        e.preventDefault();
        custom.restoreCommitted();
        s.close();
      }
    },
    { signal },
  );
}

/** Live updates while open (another device, the Account tab). */
function watchLiveState(s: CardSession, parts: CardParts): void {
  const { signal, options, disposable: d } = s;
  const { header, custom, list } = parts;
  onUserStatusChange(
    (next) => {
      s.status = next;
      list.paintStatus();
      list.paintTimer();
    },
    { signal },
  );
  onStatusTimerChange(() => list.paintTimer(), { signal });
  d.onStoreChange(
    authStore,
    (st) => st.user,
    () => {
      header.paintNames(ownIdentity());
      custom.syncCustom(options.getCustomStatus());
    },
  );
  d.onStoreChange(
    membersStore,
    (st) => {
      const id = authStore.getState().user?.id;
      return id === undefined ? "" : (st.members.get(id)?.customStatus ?? "");
    },
    (text: string) => custom.syncCustom(text),
  );
  d.onStoreChange(
    membersStore,
    (st) => {
      const id = authStore.getState().user?.id;
      return id === undefined ? null : (st.members.get(id)?.customStatusExpiresAt ?? null);
    },
    () => {
      header.paintClearsLine();
      custom.syncClearAfter();
    },
  );
  d.onStoreChange(
    uiStore,
    (st) => st.connectionStatus,
    () => {
      s.enabled = options.canSetStatus();
      list.paintEnabled();
      custom.paintEnabled();
    },
  );

  d.onStoreChange(
    uiStore,
    (st) => st.settingsOpen,
    (opened) => {
      if (opened) s.close();
    },
  );
  d.onStoreChange(
    uiStore,
    (st) => st.activeView,
    () => s.close(),
  );
}

export function createSelfProfileCard(options: SelfProfileCardOptions): SelfProfileCard {
  let disposable: Disposable | null = null;
  let cardEl: HTMLDivElement | null = null;
  let tearingDown = false;

  function isOpen(): boolean {
    return cardEl !== null;
  }

  function teardown(restoreFocus: boolean): void {
    if (cardEl === null) return;
    const card = cardEl;
    const focusInside = card.contains(document.activeElement);
    const focusLost = document.activeElement === null || document.activeElement === document.body;
    // The phone sheet closes with the owner and reports it; this close is already on its way.
    tearingDown = true;
    disposable?.destroy();
    tearingDown = false;
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

    const status = loadUserStatus();
    const lastCommittedCustom = options.getCustomStatus();
    const enabled = options.canSetStatus();

    const card = createElement("div", {
      class: "self-profile-card",
      role: "dialog",
      "aria-label": shellText("status.profileLabel"),
      "data-testid": "self-profile-card",
      tabindex: "-1",
    });
    cardEl = card;
    const s: CardSession = {
      options,
      disposable: d,
      signal: d.signal,
      card,
      close,
      isCurrent: () => cardEl === card,
      enabled,
      status,
      lastCommittedCustom,
    };

    const identity = ownIdentity();
    const header = buildHeader(s, identity);
    const custom = buildCustomStatus(s, header);
    const list = buildStatusList(s);
    list.paintEnabled();
    custom.paintEnabled();

    appendChildren(
      card,
      header.element,
      ...custom.elements,
      createElement("div", { class: "spc-divider" }),
      list.element,
      createElement("div", { class: "spc-divider" }),
      buildActions(s, identity),
    );
    const host = mountCard(s, () => {
      if (cardEl === card && !tearingDown) close();
    });
    options.trigger.setAttribute("aria-expanded", "true");

    watchDismissal(s, host, custom);
    watchLiveState(s, { header, custom, list });

    closeActive = close;
    const first = s.enabled ? list.currentRow() : undefined;
    (first ?? card).focus();
  }

  function toggle(): void {
    if (isOpen()) close();
    else open();
  }

  return { open, close, toggle, isOpen, destroy: () => teardown(false) };
}
