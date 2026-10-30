/**
 * UserProfilePopup — anchored popover that appears when clicking a username
 * in the chat or member list. Shows avatar, username, role badge, status dot,
 * about section, join date, and Message/Call action buttons.
 *
 * Position: anchored to the click point, flipped to the other side and clamped
 * against the measured card height so it always lands fully on screen.
 * Animation: fade+scale, defined in CSS so reduced-motion can drop it.
 * Close: outside click or Escape.
 * A11y: role="dialog", aria-label, focus trap, return focus on close.
 */

import { isImeCommit } from "@lib/text/ime";
import { Disposable } from "@lib/disposable";
import { trapFocus } from "@lib/ui/a11y";
import { openBottomSheet, type BottomSheet } from "@lib/ui/bottomSheet";
import { createElement, appendChildren, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/text/safeRender";
import type { UserStatus } from "@lib/types";
import { resolveDisplayName } from "@lib/ui/avatar";
import { createAvatarElement } from "@components/message-list/avatar";
import { roleColorVar } from "@lib/text/formatting";
import { reportEntryText } from "../i18n/reportEntry";
import { statusLabel } from "../i18n/shell";
import { NOTE_MAX_LENGTH, type NoteBinding } from "../features/profiles/userNotes";
import { paintBanner } from "../features/profiles/banner";
import { bannerImages } from "./bannerImages";
import { requestsText } from "../i18n/requests";
import { shellText } from "../i18n/shell";
import { playingForLine } from "../features/members/gameActivityLine";
import { mountListeningCard } from "../features/members/listeningCard";
import type { ListeningSong } from "../features/members/listeningLine";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserProfileData {
  readonly id: number;
  readonly username: string;
  readonly avatar: string | null;
  readonly role: string;
  readonly status: UserStatus;
  /** Nickname. When set the popup shows it as the heading and the username
   *  underneath, because the username is still the handle you @mention. */
  readonly displayName?: string | null;
  readonly about?: string | null;
  /** Free-text status line, shown under the name. */
  readonly customStatus?: string | null;
  /** The game being played, shown as "Playing <game> · for N min". */
  readonly activity?: { readonly name: string; readonly startedAt: number } | null;
  /** The song being listened to: a card under the game with a
   *  progress bar that ticks while the popup is open. */
  readonly listening?: ListeningSong | null;
  readonly joinDate?: string | null;
  /** Banner image path and colour; absent or null = the gradient. */
  readonly banner?: string | null;
  readonly banner_color?: string | null;
  readonly isDeleted?: boolean;
}

/** What the role area shows right now, read live while the popup is open. */
export interface ProfileRoleState {
  readonly role: string;
  /** Roles the viewer may assign; null when they may not change this role,
   *  which leaves the plain read-only badge. */
  readonly choices: readonly string[] | null;
}

/** The role picker's live source (P11). Re-read on every `subscribe` callback,
 *  so a role change on either side re-filters or removes the picker. */
export interface ProfileRoleControl {
  read(): ProfileRoleState;
  subscribe(listener: () => void): () => void;
  /** Assign `role`. Reports its own failures; the shown role changes only when
   *  the server's echo reaches the store. */
  change(role: string): Promise<void>;
}

/** One role the member holds, as a chip. */
export interface ProfileRoleChip {
  readonly id: number;
  readonly name: string;
  /** Server colour; null = the seeded fallback for the name. */
  readonly color: string | null;
  /** The viewer may take this role away: MANAGE_ROLES and the role is below
   *  their own top role. The popup still hides the x on the last chip. */
  readonly removable: boolean;
}

/** What the multi-role area shows right now. */
export interface ProfileRolesState {
  /** Held roles, highest first. */
  readonly chips: readonly ProfileRoleChip[];
  /** Roles the viewer may add that the member does not hold; empty hides "+". */
  readonly addable: readonly { readonly id: number; readonly name: string }[];
}

/** The multi-role chips' live source, used instead of `ProfileRoleControl` on a
 *  server that advertises `multi_role`. Re-read on every `subscribe` callback. */
export interface ProfileRolesControl {
  read(): ProfileRolesState;
  subscribe(listener: () => void): () => void;
  /** Add / remove one role. Report their own failures; the chips change only
   *  when the server's echo reaches the store. */
  add(roleId: number): Promise<void>;
  remove(roleId: number): Promise<void>;
}

export interface UserProfilePopupOptions {
  readonly user: UserProfileData;
  /** Anchor point — the click event's clientX/clientY. */
  readonly anchorX: number;
  readonly anchorY: number;
  /** Called when the user clicks "Message". */
  readonly onMessage?: (userId: number) => void;
  /** Called when the user clicks "Call". */
  readonly onCall?: (userId: number) => void;
  /** Called when the user clicks "Report"; the popup closes first. */
  readonly onReport?: (userId: number) => void;
  /** Called when the user clicks Block / Unblock; the popup closes
   *  first. `block` is the state asked for. Omitted: no button. */
  readonly onToggleBlock?: (userId: number, block: boolean) => void;
  /** Whether the viewer has blocked this user: picks Block or Unblock. */
  readonly blocked?: boolean;
  /** Why Message and Call cannot be used right now (offline, or blocked).
   *  Set: both render disabled with this as their tooltip. */
  readonly unavailableReason?: string;
  /** Live role and role picker. Absent: the badge shows `user.role` as given. */
  readonly roleControl?: ProfileRoleControl;
  /** Role chips with remove and add. Set on a multi-role server; it
   *  replaces the single-role picker. Absent: `roleControl` as before. */
  readonly rolesControl?: ProfileRolesControl;
  /** The viewer's private note about this member. Absent: no Note
   *  section (the viewer's own card, or no session to keep a note in). */
  readonly note?: NoteBinding;
  /** Called when the popup is destroyed, before `onClose`, so an edit still
   *  waiting on its debounce is sent. The opener binds it to the session that
   *  opened the card. */
  readonly onNoteFlush?: () => void;
  /** Called once when the popup closes, however it was closed. */
  readonly onClose?: () => void;
  /** Where focus goes on close when the opener has left the document. */
  readonly fallbackFocus?: () => HTMLElement | null;
  /** Open as a phone bottom sheet instead of a card beside the anchor. */
  readonly sheet?: boolean;
}

export type UserProfilePopupComponent = MountableComponent & {
  /** Check if the popup is currently visible. */
  isOpen(): boolean;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POPUP_WIDTH = 300;
/** Keeps the card clear of the window edges on both axes. */
const VIEWPORT_MARGIN = 8;
/** Breathing room between the click point and the card. */
const ANCHOR_GAP = 8;

const STATUS_COLORS: Record<UserStatus, string> = {
  online: "var(--green)",
  idle: "var(--yellow)",
  dnd: "var(--red)",
  // Only ever reached for the signed-in user looking at their own profile —
  // the server maps invisible to offline for everyone else.
  invisible: "var(--text-micro)",
  offline: "var(--text-micro)",
};

/** aria-disabled, not `disabled`, so the button stays focusable and its
 *  reason is reachable by keyboard and read by a screen reader. */
const markUnavailable = (btn: HTMLElement, reason: string, id: string): void => {
  btn.setAttribute("aria-disabled", "true");
  btn.setAttribute("aria-describedby", id);
  btn.title = reason;
  btn.appendChild(createElement("span", { id, class: "sr-only" }, reason));
};

/**
 * Place the card beside the anchor, flipping and clamping so it always lands
 * fully on screen — Discord opens its popout away from whichever edge the
 * clicked row is nearest.
 *
 * The height is measured rather than assumed. The previous version guessed
 * 300px and only clamped the top edge, so a member clicked low in the list
 * opened a card that ran off the bottom of the window.
 */
function position(el: HTMLElement, anchorX: number, anchorY: number): void {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const height = el.offsetHeight;

  // Prefer the right of the anchor and flip left when there is no room. The
  // member list sits against the right edge, so flipping is the usual case.
  let left = anchorX + ANCHOR_GAP;
  if (left + POPUP_WIDTH > vw - VIEWPORT_MARGIN) {
    left = anchorX - POPUP_WIDTH - ANCHOR_GAP;
  }
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - POPUP_WIDTH - VIEWPORT_MARGIN));

  // Align the top with the click, then lift the card just enough to fit.
  let top = anchorY;
  if (top + height > vh - VIEWPORT_MARGIN) {
    top = vh - height - VIEWPORT_MARGIN;
  }
  top = Math.max(VIEWPORT_MARGIN, top);

  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function buildAvatar(user: UserProfileData): HTMLDivElement {
  // The shared helper is what makes uploaded avatars work here and in the
  // message rows and member list at the same time: it fetches the
  // authenticated file through the cert-pinned path and falls back to the
  // letter until (or unless) the bytes arrive.
  const wrapper = createAvatarElement(
    {
      username: user.username,
      displayName: user.displayName,
      avatar: user.avatar,
      isDeleted: user.isDeleted,
    },
    {
      className: "upp-avatar",
      animate: "always",
      background: user.isDeleted === true ? "#4e5058" : "var(--accent, #5865f2)",
    },
  );

  // Status dot overlay
  const statusDot = createElement("div", { class: "upp-status-dot" });
  statusDot.style.background = STATUS_COLORS[user.status] ?? STATUS_COLORS.offline;
  statusDot.title = statusLabel(user.status);
  wrapper.appendChild(statusDot);

  return wrapper;
}

// ---------------------------------------------------------------------------
// Component factory
// ---------------------------------------------------------------------------

export function createUserProfilePopup(
  options: UserProfilePopupOptions,
): UserProfilePopupComponent {
  const disposable = new Disposable();
  const { signal } = disposable;

  let overlay: HTMLDivElement | null = null;
  let popup: HTMLDivElement | null = null;
  let previousFocus: Element | null = null;
  let sheet: BottomSheet | null = null;
  const asSheet = options.sheet === true;

  /** Keep the card on screen after its height changed. A sheet places itself. */
  function place(el: HTMLElement): void {
    if (!asSheet && el.isConnected) position(el, options.anchorX, options.anchorY);
  }

  function isOpen(): boolean {
    return popup !== null && overlay !== null;
  }

  function close(): void {
    if (overlay === null) return;
    overlay.remove();
    overlay = null;
    popup = null;
    const closingSheet = sheet;
    sheet = null;
    closingSheet?.close();
    disposable.destroy();
    options.onNoteFlush?.();

    // Return focus to the element that was focused before opening
    if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
      previousFocus.focus();
    } else {
      options.fallbackFocus?.()?.focus();
    }
    options.onClose?.();
  }

  function mount(container: Element): void {
    previousFocus = document.activeElement;
    const user = options.user;
    const displayName = user.isDeleted === true ? "[deleted]" : resolveDisplayName(user);

    // Overlay for outside-click detection
    overlay = createElement("div", {
      class: asSheet ? "upp-sheet-host" : "upp-overlay",
      "data-testid": "user-profile-overlay",
    });

    // Popup container
    popup = createElement("div", {
      class: "upp-popup",
      role: "dialog",
      "aria-label": requestsText("profile.label"),
      "aria-modal": "true",
      tabindex: "-1",
      "data-testid": "user-profile-popup",
    });

    if (!asSheet) popup.style.width = `${POPUP_WIDTH}px`;

    // --- Content ---

    // Avatar
    const avatar = buildAvatar(user);

    // Username
    const nameEl = createElement("div", { class: "upp-username" }, displayName);
    if (user.isDeleted === true) {
      nameEl.style.color = "var(--text-faint, #80848e)";
    }

    // Username line, shown only when a display name is standing in for it.
    // @mentions still resolve by username, so the popup has to keep telling
    // you what to type.
    const handleEl = createElement("div", { class: "upp-username-handle" });
    if (user.isDeleted !== true && displayName !== user.username) {
      setText(handleEl, `@${user.username}`);
    }

    // Custom status line — the user's own words, under the name.
    const customStatusEl = createElement("div", { class: "upp-custom-status" });
    if (typeof user.customStatus === "string" && user.customStatus.length > 0) {
      setText(customStatusEl, user.customStatus);
    }

    // The game being played, under the custom status. Empty (and
    // hidden by CSS) when there is none.
    const activityEl = createElement("div", {
      class: "upp-activity",
      "data-testid": "upp-activity",
    });
    if (user.activity != null && user.isDeleted !== true) {
      const icon = createIcon("gamepad-2", 14);
      icon.setAttribute("aria-hidden", "true");
      icon.classList.add("upp-activity-icon");
      const text = createElement("span", { class: "upp-activity-text" });
      setText(text, playingForLine(user.activity, Date.now()));
      appendChildren(activityEl, icon, text);
    }

    // The song being listened to, under the game. Its clock stops
    // with the popup.
    const listeningEl = createElement("div", {
      class: "upp-listening",
      "data-testid": "upp-listening",
    });
    if (user.listening != null && user.isDeleted !== true) {
      disposable.addCleanup(mountListeningCard(listeningEl, user.listening, { prefix: "upp" }));
    }

    // Role badge, or the role picker for a viewer who may change it.
    const roleHolder = createElement("div", { class: "upp-role", "data-testid": "upp-role" });
    let roleMenuOpen = false;
    let roleBusy = false;
    const control = options.roleControl;
    const rolesControl = options.rolesControl;

    const closeRoleMenu = (focusButton: boolean): void => {
      roleMenuOpen = false;
      renderRole();
      if (focusButton) roleHolder.querySelector<HTMLElement>(".upp-role-btn")?.focus();
    };

    const roleOptions = (): HTMLElement[] =>
      Array.from(roleHolder.querySelectorAll<HTMLElement>(".upp-role-option"));

    const focusRoleOption = (index: number): void => {
      const items = roleOptions();
      if (items.length === 0) return;
      items[(index + items.length) % items.length]?.focus();
    };

    const chooseRole = async (role: string, current: string): Promise<void> => {
      if (roleBusy || control === undefined) return;
      if (role.toLowerCase() === current.toLowerCase()) {
        closeRoleMenu(true);
        return;
      }
      roleBusy = true;
      for (const item of roleOptions()) item.setAttribute("aria-disabled", "true");
      try {
        await control.change(role);
      } catch {
        // change() reports its own failures; the menu just closes.
      } finally {
        roleBusy = false;
      }
      if (isOpen()) closeRoleMenu(true);
    };

    let lastMenuOpen = false;
    /** Re-render the role area; when the list opened or closed the card's height
     *  changed, so it is placed again to stay inside the window. */
    function renderRole(): void {
      renderRoleContent();
      if (popup !== null && roleMenuOpen !== lastMenuOpen) {
        lastMenuOpen = roleMenuOpen;
        place(popup);
      }
    }

    const addRole = async (roleId: number): Promise<void> => {
      if (roleBusy || rolesControl === undefined) return;
      roleBusy = true;
      for (const item of roleOptions()) item.setAttribute("aria-disabled", "true");
      try {
        await rolesControl.add(roleId);
      } catch {
        // add() reports its own failures; the menu just closes.
      } finally {
        roleBusy = false;
      }
      if (!isOpen()) return;
      closeRoleMenu(true);
      // The last addable role went, so "+" is gone and focus would fall to the page.
      if (popup !== null && !roleHolder.contains(document.activeElement)) popup.focus();
    };

    const removeRole = async (roleId: number): Promise<void> => {
      if (roleBusy || rolesControl === undefined) return;
      roleBusy = true;
      try {
        await rolesControl.remove(roleId);
      } catch {
        // remove() reports its own failures.
      } finally {
        roleBusy = false;
      }
    };

    /** Chips for every held role, an x on those the viewer may remove (never on
     *  the last one), and a "+" listing the roles that can be added. */
    function renderChips(state: ProfileRolesState): void {
      if (popup === null || rolesControl === undefined) return;
      const hadFocus = roleHolder.contains(document.activeElement);
      const focusedRole = hadFocus
        ? ((document.activeElement as HTMLElement).dataset["role"] ?? null)
        : null;
      roleHolder.replaceChildren();
      const list = createElement("div", {
        class: "upp-chips",
        role: "list",
        "aria-label": requestsText("profile.role.list"),
        "data-testid": "upp-chips",
      });
      for (const chip of state.chips) {
        const el = createElement("span", {
          class: "upp-role-badge upp-chip",
          role: "listitem",
          "data-role-id": String(chip.id),
        });
        const dot = createElement("span", { class: "upp-role-dot" });
        dot.style.background = chip.color ?? roleColorVar(chip.name.toLowerCase());
        appendChildren(el, dot, createElement("span", {}, chip.name));
        if (chip.removable && state.chips.length > 1) {
          const x = createElement(
            "button",
            {
              class: "upp-chip-x",
              type: "button",
              "aria-label": requestsText("profile.role.remove", { role: chip.name }),
              "data-role-id": String(chip.id),
              "data-testid": `upp-chip-x-${chip.id}`,
            },
            "\u00d7",
          );
          x.addEventListener("click", () => void removeRole(chip.id), { signal });
          el.appendChild(x);
        }
        list.appendChild(el);
      }
      if (state.addable.length > 0) {
        const plus = createElement(
          "button",
          {
            class: "upp-role-badge upp-role-btn upp-chip-add",
            type: "button",
            "aria-haspopup": "menu",
            "aria-expanded": String(roleMenuOpen),
            "aria-label": requestsText("profile.role.add"),
            "data-testid": "upp-chip-add",
          },
          "+",
        );
        plus.addEventListener(
          "click",
          () => {
            roleMenuOpen = !roleMenuOpen;
            renderRole();
            if (roleMenuOpen) focusRoleOption(0);
            else roleHolder.querySelector<HTMLElement>(".upp-role-btn")?.focus();
          },
          { signal },
        );
        plus.addEventListener(
          "keydown",
          (e: KeyboardEvent) => {
            if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            if (!roleMenuOpen) {
              roleMenuOpen = true;
              renderRole();
            }
            focusRoleOption(e.key === "ArrowDown" ? 0 : -1);
          },
          { signal },
        );
        list.appendChild(plus);
      } else {
        roleMenuOpen = false;
      }
      roleHolder.appendChild(list);

      if (roleMenuOpen) {
        const menu = createElement("div", {
          class: "upp-role-menu",
          role: "menu",
          "aria-label": requestsText("profile.role.menu", { name: displayName }),
          "data-testid": "upp-role-menu",
        });
        for (const role of state.addable) {
          const item = createElement(
            "button",
            {
              class: "upp-role-option",
              type: "button",
              role: "menuitem",
              tabindex: "-1",
              "data-role": role.name,
              "data-role-id": String(role.id),
              ...(roleBusy ? { "aria-disabled": "true" } : {}),
            },
            role.name,
          );
          item.addEventListener("click", () => void addRole(role.id), { signal });
          menu.appendChild(item);
        }
        menu.addEventListener(
          "keydown",
          (e: KeyboardEvent) => {
            const items = roleOptions();
            const at = items.indexOf(document.activeElement as HTMLElement);
            if (e.key === "ArrowDown") focusRoleOption(at + 1);
            else if (e.key === "ArrowUp") focusRoleOption(at - 1);
            else if (e.key === "Home") focusRoleOption(0);
            else if (e.key === "End") focusRoleOption(-1);
            else if (e.key === "Escape" && !isImeCommit(e)) {
              e.stopPropagation();
              closeRoleMenu(true);
              return;
            } else if (e.key === "Tab") {
              closeRoleMenu(true);
              return;
            } else return;
            e.preventDefault();
          },
          { signal },
        );
        roleHolder.appendChild(menu);
        if (focusedRole !== null) {
          roleOptions()
            .find((i) => i.dataset["role"] === focusedRole)
            ?.focus();
        }
      } else if (hadFocus && !roleHolder.contains(document.activeElement)) {
        // The control that held focus went away (a chip was removed): keep
        // focus in the card.
        popup.focus();
      }
    }

    function renderRoleContent(): void {
      if (popup === null) return;
      if (rolesControl !== undefined) {
        renderChips(rolesControl.read());
        return;
      }
      const state: ProfileRoleState = control?.read() ?? { role: user.role, choices: null };
      const focusedRole = roleHolder.contains(document.activeElement)
        ? ((document.activeElement as HTMLElement).dataset["role"] ?? null)
        : null;
      const hadFocus = roleHolder.contains(document.activeElement);
      roleHolder.replaceChildren();

      const label = state.role.charAt(0).toUpperCase() + state.role.slice(1);
      const roleDot = createElement("span", { class: "upp-role-dot" });
      roleDot.style.background = roleColorVar(state.role.toLowerCase());
      const roleLabel = createElement("span", {}, label);

      const choices = state.choices;
      if (choices === null || control === undefined) {
        roleMenuOpen = false;
        const badge = createElement("span", { class: "upp-role-badge" });
        appendChildren(badge, roleDot, roleLabel);
        roleHolder.appendChild(badge);
        // The picker went away (a role changed under it): keep focus in the card.
        if (hadFocus) popup.focus();
        return;
      }

      const btn = createElement("button", {
        class: "upp-role-badge upp-role-btn",
        type: "button",
        "aria-haspopup": "menu",
        "aria-expanded": String(roleMenuOpen),
        "aria-label": requestsText("profile.role.change", { role: label }),
        "data-testid": "upp-role-btn",
      });
      appendChildren(btn, roleDot, roleLabel, createIcon("chevron-down", 12));
      btn.addEventListener(
        "click",
        () => {
          roleMenuOpen = !roleMenuOpen;
          renderRole();
          if (roleMenuOpen) {
            const items = roleOptions();
            const checked = items.findIndex((i) => i.getAttribute("aria-checked") === "true");
            focusRoleOption(checked >= 0 ? checked : 0);
          } else {
            roleHolder.querySelector<HTMLElement>(".upp-role-btn")?.focus();
          }
        },
        { signal },
      );
      btn.addEventListener(
        "keydown",
        (e: KeyboardEvent) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          if (!roleMenuOpen) {
            roleMenuOpen = true;
            renderRole();
          }
          focusRoleOption(e.key === "ArrowDown" ? 0 : -1);
        },
        { signal },
      );
      roleHolder.appendChild(btn);

      if (roleMenuOpen) {
        const menu = createElement("div", {
          class: "upp-role-menu",
          role: "menu",
          "aria-label": requestsText("profile.role.menu", { name: displayName }),
          "data-testid": "upp-role-menu",
        });
        for (const role of choices) {
          const checked = role.toLowerCase() === state.role.toLowerCase();
          const item = createElement(
            "button",
            {
              class: "upp-role-option",
              type: "button",
              role: "menuitemradio",
              "aria-checked": String(checked),
              tabindex: "-1",
              "data-role": role,
              "data-testid": `upp-role-option-${role.toLowerCase()}`,
              ...(roleBusy ? { "aria-disabled": "true" } : {}),
            },
            role,
          );
          item.addEventListener("click", () => void chooseRole(role, state.role), { signal });
          menu.appendChild(item);
        }
        menu.addEventListener(
          "keydown",
          (e: KeyboardEvent) => {
            const items = roleOptions();
            const at = items.indexOf(document.activeElement as HTMLElement);
            if (e.key === "ArrowDown") focusRoleOption(at + 1);
            else if (e.key === "ArrowUp") focusRoleOption(at - 1);
            else if (e.key === "Home") focusRoleOption(0);
            else if (e.key === "End") focusRoleOption(-1);
            else if (e.key === "Escape" && !isImeCommit(e)) {
              // Closes the list only; the card stays.
              e.stopPropagation();
              closeRoleMenu(true);
              return;
            } else if (e.key === "Tab") {
              closeRoleMenu(true);
              return;
            } else return;
            e.preventDefault();
          },
          { signal },
        );
        roleHolder.appendChild(menu);
        // A re-render while the list is open (a role changed) keeps the cursor.
        if (focusedRole !== null) {
          roleOptions()
            .find((i) => i.dataset["role"] === focusedRole)
            ?.focus();
        }
      }
    }

    // Status line
    const statusLine = createElement("div", { class: "upp-status-line" });
    const statusDotInline = createElement("span", { class: "upp-status-dot-inline" });
    statusDotInline.style.background = STATUS_COLORS[user.status] ?? STATUS_COLORS.offline;
    const statusText = createElement("span", {}, statusLabel(user.status));
    appendChildren(statusLine, statusDotInline, statusText);

    // About section (2 lines max)
    const aboutSection = createElement("div", { class: "upp-about" });
    if (user.about !== undefined && user.about !== null && user.about.length > 0) {
      const aboutTitle = createElement(
        "div",
        { class: "upp-section-title" },
        requestsText("profile.about"),
      );
      const aboutText = createElement("div", { class: "upp-about-text" }, user.about);
      appendChildren(aboutSection, aboutTitle, aboutText);
    }

    // Note section: private to the viewer, saved as they type.
    const noteSection = createElement("div", {
      class: "upp-note",
      "data-testid": "upp-note-section",
    });
    const note = options.note;
    if (note !== undefined) {
      const noteTitle = createElement(
        "div",
        { class: "upp-section-title" },
        requestsText("profile.note"),
      );
      const noteInput = createElement("textarea", {
        class: "upp-note-input",
        placeholder: requestsText("profile.notePlaceholder"),
        "aria-label": requestsText("profile.note"),
        "data-testid": "upp-note",
        maxlength: String(NOTE_MAX_LENGTH),
        rows: "2",
      });
      const noteError = createElement("div", {
        class: "upp-note-error",
        role: "status",
        "data-testid": "upp-note-error",
      });
      let noteDirty = false;
      if (note.remote) {
        void note.load(signal).then(
          (text) => {
            if (!noteDirty && !signal.aborted) noteInput.value = text;
          },
          () => undefined,
        );
      } else {
        noteInput.value = note.readLocal();
      }
      note.onFailedChange((failed) => {
        setText(noteError, failed ? requestsText("profile.noteNotSaved") : "");
        if (popup !== null) place(popup);
      });
      noteInput.addEventListener(
        "input",
        () => {
          noteDirty = true;
          note.change(noteInput.value);
        },
        { signal },
      );
      noteInput.addEventListener("blur", () => note.flush(), { signal });
      appendChildren(noteSection, noteTitle, noteInput, noteError);
    }

    // Join date
    const joinSection = createElement("div", { class: "upp-join-date" });
    if (user.joinDate !== undefined && user.joinDate !== null) {
      const joinTitle = createElement(
        "div",
        { class: "upp-section-title" },
        requestsText("profile.memberSince"),
      );
      const joinText = createElement("div", { class: "upp-join-text" }, user.joinDate);
      appendChildren(joinSection, joinTitle, joinText);
    }

    // Divider
    const divider = createElement("div", { class: "upp-divider" });

    // Actions — only render buttons that are actually wired up, so the popup
    // never shows a dead control (e.g. Call or Message on your own profile).
    const actions = createElement("div", { class: "upp-actions" });
    const unavailable = options.unavailableReason;

    if (options.onMessage !== undefined) {
      const onMessage = options.onMessage;
      const messageBtn = createElement("button", {
        class: "upp-action-btn",
        "data-testid": "upp-message-btn",
      });
      messageBtn.appendChild(createIcon("send", 16));
      messageBtn.appendChild(document.createTextNode(requestsText("profile.message")));
      if (unavailable !== undefined) {
        markUnavailable(messageBtn, unavailable, "upp-message-reason");
      }
      messageBtn.addEventListener(
        "click",
        () => {
          if (unavailable !== undefined) return;
          onMessage(user.id);
          close();
        },
        { signal },
      );
      actions.appendChild(messageBtn);
    }

    if (options.onCall !== undefined) {
      const onCall = options.onCall;
      const callBtn = createElement("button", {
        class: "upp-action-btn",
        "data-testid": "upp-call-btn",
      });
      callBtn.appendChild(createIcon("phone", 16));
      callBtn.appendChild(document.createTextNode(requestsText("profile.call")));
      if (unavailable !== undefined) {
        markUnavailable(callBtn, unavailable, "upp-call-reason");
      }
      callBtn.addEventListener(
        "click",
        () => {
          if (unavailable !== undefined) return;
          onCall(user.id);
          close();
        },
        { signal },
      );
      actions.appendChild(callBtn);
    }

    if (options.onReport !== undefined) {
      const onReport = options.onReport;
      const reportBtn = createElement("button", {
        class: "upp-action-btn",
        "data-testid": "upp-report-btn",
        "aria-haspopup": "dialog",
      });
      reportBtn.appendChild(createIcon("flag", 16));
      reportBtn.appendChild(document.createTextNode(` ${reportEntryText("report")}`));
      reportBtn.addEventListener(
        "click",
        () => {
          // Close first: focus goes back to the opener, which the report
          // dialog then remembers as the place to return to.
          close();
          onReport(user.id);
        },
        { signal },
      );
      actions.appendChild(reportBtn);
    }

    if (options.onToggleBlock !== undefined) {
      const onToggleBlock = options.onToggleBlock;
      const block = options.blocked !== true;
      const blockBtn = createElement("button", {
        class: "upp-action-btn",
        "data-testid": "upp-block-btn",
        ...(block ? { "aria-haspopup": "dialog" } : {}),
      });
      blockBtn.appendChild(createIcon("ban", 16));
      blockBtn.appendChild(
        document.createTextNode(` ${shellText(block ? "member.block" : "member.unblock")}`),
      );
      blockBtn.addEventListener(
        "click",
        () => {
          // Close first, like Report: the confirm returns focus to the opener.
          close();
          onToggleBlock(user.id, block);
        },
        { signal },
      );
      actions.appendChild(blockBtn);
    }

    // Assemble the card: a banner strip and a body, with the avatar straddling
    // the seam between them the way Discord's popout does.
    const banner = createElement("div", { class: "upp-banner" });
    const body = createElement("div", { class: "upp-body" });
    if (asSheet) {
      // The phone layout: Message and Call as large buttons under the name,
      // Report and Block in their own row at the bottom.
      banner.setAttribute("data-sheet-drag", "");
      const primary = createElement("div", { class: "upp-actions upp-sheet-primary" });
      for (const id of ["upp-message-btn", "upp-call-btn"]) {
        const btn = actions.querySelector(`[data-testid="${id}"]`);
        if (btn !== null) primary.appendChild(btn);
      }
      appendChildren(body, nameEl, handleEl, statusLine, customStatusEl, activityEl, listeningEl);
      if (primary.childElementCount > 0) body.appendChild(primary);
      appendChildren(body, roleHolder, aboutSection, noteSection, joinSection);
      if (actions.childElementCount > 0) {
        actions.classList.add("upp-sheet-secondary");
        appendChildren(body, divider, actions);
      }
    } else {
      appendChildren(
        body,
        nameEl,
        handleEl,
        customStatusEl,
        activityEl,
        listeningEl,
        roleHolder,
        statusLine,
        aboutSection,
        noteSection,
        joinSection,
      );
      if (actions.childElementCount > 0) {
        appendChildren(body, divider, actions);
      }
    }
    // The avatar hangs off the body's top edge, so it is a child of the card
    // rather than the body — the body scrolls, and a scroll container clips.
    // Appending it last puts it over the banner without needing a z-index.
    appendChildren(popup, banner, body, avatar);
    paintBanner(banner, user, popup, bannerImages);

    renderRole();
    overlay.appendChild(popup);
    if (asSheet) {
      // The sheet is the dialog; the card inside is its content.
      popup.removeAttribute("role");
      popup.removeAttribute("aria-modal");
      sheet = openBottomSheet({
        label: requestsText("profile.label"),
        content: overlay,
        className: "profile-sheet",
        testId: "profile-sheet",
        focusFirst: false,
        onClosed: () => {
          sheet = null;
          close();
        },
      });
    } else {
      container.appendChild(overlay);
      // Measure, then place: the card has to be in the document before it has a
      // height to clamp against.
      position(popup, options.anchorX, options.anchorY);
    }

    // The fade+scale itself lives in CSS so `prefers-reduced-motion` can drop it.
    requestAnimationFrame(() => {
      if (popup !== null) {
        popup.classList.add("open");
      }
    });

    const live = rolesControl ?? control;
    if (live !== undefined) {
      disposable.addCleanup(live.subscribe(() => renderRole()));
    }

    // Focus the popup for a11y
    popup.focus();

    // Close on outside click (click on overlay but not on popup)
    overlay.addEventListener(
      "mousedown",
      (e: MouseEvent) => {
        if (popup !== null && !popup.contains(e.target as Node)) {
          close();
        }
      },
      { signal },
    );

    // A press elsewhere in the card closes an open role list.
    popup.addEventListener(
      "mousedown",
      (e: MouseEvent) => {
        if (roleMenuOpen && !roleHolder.contains(e.target as Node)) closeRoleMenu(false);
      },
      { signal },
    );

    // Close on Escape
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && !isImeCommit(e) && isOpen()) {
          close();
        }
      },
      { signal },
    );

    // Focus trap: keep focus inside popup
    trapFocus(popup, signal);
  }

  function destroy(): void {
    close();
  }

  return { mount, destroy, isOpen };
}
