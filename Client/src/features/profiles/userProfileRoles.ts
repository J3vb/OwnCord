/**
 * The role area of the user profile popup: a plain badge, a single-role picker,
 * or the multi-role chips with an add menu. It re-renders itself whenever the
 * live role source changes, and keeps focus in the card when the control that
 * held it goes away.
 */
import { isImeCommit } from "@lib/text/ime";
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { roleColorVar } from "@lib/text/formatting";
import { requestsText } from "../../i18n/requests";
import type {
  ProfileRoleControl,
  ProfileRoleChip,
  ProfileRoleState,
  ProfileRolesControl,
  ProfileRolesState,
  UserProfileData,
} from "./userProfileTypes";

export interface RoleAreaDeps {
  readonly user: UserProfileData;
  readonly displayName: string;
  readonly control: ProfileRoleControl | undefined;
  readonly rolesControl: ProfileRolesControl | undefined;
  readonly signal: AbortSignal;
  /** The card, read live: it is null once the popup has closed. */
  readonly getPopup: () => HTMLDivElement | null;
  readonly isOpen: () => boolean;
  /** Keep the card on screen after its height changed. */
  readonly place: (el: HTMLElement) => void;
}

export interface RoleArea {
  readonly holder: HTMLDivElement;
  render(): void;
  /** Close the open list when a press landed outside the role area. */
  closeMenuOnOutsidePress(target: Node): void;
}

type RoleMenuKeys = { readonly closeMenu: (focusButton: boolean) => void };

function roleOptionsOf(holder: HTMLElement): HTMLElement[] {
  return Array.from(holder.querySelectorAll<HTMLElement>(".upp-role-option"));
}

function focusRoleOptionAt(holder: HTMLElement, index: number): void {
  const items = roleOptionsOf(holder);
  if (items.length === 0) return;
  items[(index + items.length) % items.length]?.focus();
}

/** The `data-role` of the focused control inside the area, or null. */
function focusedRoleIn(holder: HTMLElement): string | null {
  return holder.contains(document.activeElement)
    ? ((document.activeElement as HTMLElement).dataset["role"] ?? null)
    : null;
}

/** A re-render while the list is open (a role changed) keeps the cursor. */
function refocusRole(holder: HTMLElement, focusedRole: string | null): void {
  if (focusedRole === null) return;
  roleOptionsOf(holder)
    .find((i) => i.dataset["role"] === focusedRole)
    ?.focus();
}

function focusPickerButton(holder: HTMLElement): void {
  holder.querySelector<HTMLElement>(".upp-role-btn")?.focus();
}

function buildRoleMenu(displayName: string): HTMLDivElement {
  return createElement("div", {
    class: "upp-role-menu",
    role: "menu",
    "aria-label": requestsText("profile.role.menu", { name: displayName }),
    "data-testid": "upp-role-menu",
  });
}

/** Arrow keys, Home and End move through the options; Escape closes the list
 *  only (the card stays) and Tab closes it too. */
function onMenuKeydown(e: KeyboardEvent, holder: HTMLElement, keys: RoleMenuKeys): void {
  const items = roleOptionsOf(holder);
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === "ArrowDown") focusRoleOptionAt(holder, at + 1);
  else if (e.key === "ArrowUp") focusRoleOptionAt(holder, at - 1);
  else if (e.key === "Home") focusRoleOptionAt(holder, 0);
  else if (e.key === "End") focusRoleOptionAt(holder, -1);
  else if (e.key === "Escape" && !isImeCommit(e)) {
    e.stopPropagation();
    keys.closeMenu(true);
    return;
  } else if (e.key === "Tab") {
    keys.closeMenu(true);
    return;
  } else return;
  e.preventDefault();
}

/** The role dot and label shared by the plain badge and the picker button. */
function buildRoleLabel(state: ProfileRoleState): {
  readonly label: string;
  readonly roleDot: HTMLElement;
  readonly roleLabel: HTMLElement;
} {
  const label = state.role.charAt(0).toUpperCase() + state.role.slice(1);
  const roleDot = createElement("span", { class: "upp-role-dot" });
  roleDot.style.background = roleColorVar(state.role.toLowerCase());
  const roleLabel = createElement("span", {}, label);
  return { label, roleDot, roleLabel };
}

function buildChipRemoveButton(
  chip: ProfileRoleChip,
  onRemove: (roleId: number) => void,
  signal: AbortSignal,
): HTMLElement {
  const x = createElement(
    "button",
    {
      class: "upp-chip-x",
      type: "button",
      "aria-label": requestsText("profile.role.remove", { role: chip.name }),
      "data-role-id": String(chip.id),
      "data-testid": `upp-chip-x-${chip.id}`,
    },
    "×",
  );
  x.addEventListener("click", () => onRemove(chip.id), { signal });
  return x;
}

export function createRoleArea(deps: RoleAreaDeps): RoleArea {
  const { user, displayName, control, rolesControl, signal } = deps;
  const holder = createElement("div", { class: "upp-role", "data-testid": "upp-role" });
  let roleMenuOpen = false;
  let roleBusy = false;
  let lastMenuOpen = false;

  const closeRoleMenu = (focusButton: boolean): void => {
    roleMenuOpen = false;
    renderRole();
    if (focusButton) focusPickerButton(holder);
  };
  const menuKeys: RoleMenuKeys = { closeMenu: closeRoleMenu };

  const disableOptions = (): void => {
    for (const item of roleOptionsOf(holder)) item.setAttribute("aria-disabled", "true");
  };

  const chooseRole = async (role: string, current: string): Promise<void> => {
    if (roleBusy || control === undefined) return;
    if (role.toLowerCase() === current.toLowerCase()) {
      closeRoleMenu(true);
      return;
    }
    roleBusy = true;
    disableOptions();
    try {
      await control.change(role);
    } catch {
      // change() reports its own failures; the menu just closes.
    } finally {
      roleBusy = false;
    }
    if (deps.isOpen()) closeRoleMenu(true);
  };

  const addRole = async (roleId: number): Promise<void> => {
    if (roleBusy || rolesControl === undefined) return;
    roleBusy = true;
    disableOptions();
    try {
      await rolesControl.add(roleId);
    } catch {
      // add() reports its own failures; the menu just closes.
    } finally {
      roleBusy = false;
    }
    if (!deps.isOpen()) return;
    closeRoleMenu(true);
    // The last addable role went, so "+" is gone and focus would fall to the page.
    const popup = deps.getPopup();
    if (popup !== null && !holder.contains(document.activeElement)) popup.focus();
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

  /** Open the list on ArrowDown / ArrowUp from the trigger and focus an end. */
  const onTriggerKeydown = (e: KeyboardEvent): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    if (!roleMenuOpen) {
      roleMenuOpen = true;
      renderRole();
    }
    focusRoleOptionAt(holder, e.key === "ArrowDown" ? 0 : -1);
  };

  const buildChip = (chip: ProfileRoleChip, state: ProfileRolesState): HTMLElement => {
    const el = createElement("span", {
      class: "upp-role-badge upp-chip",
      role: "listitem",
      "data-role-id": String(chip.id),
    });
    const dot = createElement("span", { class: "upp-role-dot" });
    dot.style.background = chip.color ?? roleColorVar(chip.name.toLowerCase());
    appendChildren(el, dot, createElement("span", {}, chip.name));
    if (chip.removable && state.chips.length > 1) {
      el.appendChild(buildChipRemoveButton(chip, (id) => void removeRole(id), signal));
    }
    return el;
  };

  const buildAddButton = (): HTMLElement => {
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
        if (roleMenuOpen) focusRoleOptionAt(holder, 0);
        else focusPickerButton(holder);
      },
      { signal },
    );
    plus.addEventListener("keydown", onTriggerKeydown, { signal });
    return plus;
  };

  /** The chips for every held role, then the "+" when a role can be added. */
  const buildChipList = (state: ProfileRolesState): HTMLElement => {
    const list = createElement("div", {
      class: "upp-chips",
      role: "list",
      "aria-label": requestsText("profile.role.list"),
      "data-testid": "upp-chips",
    });
    for (const chip of state.chips) list.appendChild(buildChip(chip, state));
    if (state.addable.length > 0) {
      list.appendChild(buildAddButton());
    } else {
      roleMenuOpen = false;
    }
    return list;
  };

  const buildAddMenu = (state: ProfileRolesState): HTMLElement => {
    const menu = buildRoleMenu(displayName);
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
    menu.addEventListener("keydown", (e: KeyboardEvent) => onMenuKeydown(e, holder, menuKeys), {
      signal,
    });
    return menu;
  };

  /** Chips for every held role, an x on those the viewer may remove (never on
   *  the last one), and a "+" listing the roles that can be added. */
  const renderChips = (state: ProfileRolesState): void => {
    const popup = deps.getPopup();
    if (popup === null || rolesControl === undefined) return;
    const hadFocus = holder.contains(document.activeElement);
    const focusedRole = focusedRoleIn(holder);
    holder.replaceChildren();
    holder.appendChild(buildChipList(state));

    if (roleMenuOpen) {
      holder.appendChild(buildAddMenu(state));
      refocusRole(holder, focusedRole);
    } else if (hadFocus && !holder.contains(document.activeElement)) {
      // The control that held focus went away (a chip was removed): keep
      // focus in the card.
      popup.focus();
    }
  };

  const onPickerClick = (): void => {
    roleMenuOpen = !roleMenuOpen;
    renderRole();
    if (!roleMenuOpen) {
      focusPickerButton(holder);
      return;
    }
    const items = roleOptionsOf(holder);
    const checked = items.findIndex((i) => i.getAttribute("aria-checked") === "true");
    focusRoleOptionAt(holder, checked >= 0 ? checked : 0);
  };

  const buildPickerButton = (state: ProfileRoleState): HTMLElement => {
    const { label, roleDot, roleLabel } = buildRoleLabel(state);
    const btn = createElement("button", {
      class: "upp-role-badge upp-role-btn",
      type: "button",
      "aria-haspopup": "menu",
      "aria-expanded": String(roleMenuOpen),
      "aria-label": requestsText("profile.role.change", { role: label }),
      "data-testid": "upp-role-btn",
    });
    appendChildren(btn, roleDot, roleLabel, createIcon("chevron-down", 12));
    btn.addEventListener("click", onPickerClick, { signal });
    btn.addEventListener("keydown", onTriggerKeydown, { signal });
    return btn;
  };

  const buildChoiceMenu = (state: ProfileRoleState, choices: readonly string[]): HTMLElement => {
    const menu = buildRoleMenu(displayName);
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
    menu.addEventListener("keydown", (e: KeyboardEvent) => onMenuKeydown(e, holder, menuKeys), {
      signal,
    });
    return menu;
  };

  /** The read-only badge, for a viewer who may not change this role. */
  const renderPlainBadge = (
    state: ProfileRoleState,
    popup: HTMLDivElement,
    hadFocus: boolean,
  ): void => {
    roleMenuOpen = false;
    const { roleDot, roleLabel } = buildRoleLabel(state);
    const badge = createElement("span", { class: "upp-role-badge" });
    appendChildren(badge, roleDot, roleLabel);
    holder.appendChild(badge);
    // The picker went away (a role changed under it): keep focus in the card.
    if (hadFocus) popup.focus();
  };

  const renderRoleContent = (): void => {
    const popup = deps.getPopup();
    if (popup === null) return;
    if (rolesControl !== undefined) {
      renderChips(rolesControl.read());
      return;
    }
    const state: ProfileRoleState = control?.read() ?? { role: user.role, choices: null };
    const focusedRole = focusedRoleIn(holder);
    const hadFocus = holder.contains(document.activeElement);
    holder.replaceChildren();

    const choices = state.choices;
    if (choices === null || control === undefined) {
      renderPlainBadge(state, popup, hadFocus);
      return;
    }
    holder.appendChild(buildPickerButton(state));
    if (roleMenuOpen) {
      holder.appendChild(buildChoiceMenu(state, choices));
      refocusRole(holder, focusedRole);
    }
  };

  /** Re-render the role area; when the list opened or closed the card's height
   *  changed, so it is placed again to stay inside the window. */
  function renderRole(): void {
    renderRoleContent();
    const popup = deps.getPopup();
    if (popup !== null && roleMenuOpen !== lastMenuOpen) {
      lastMenuOpen = roleMenuOpen;
      deps.place(popup);
    }
  }

  return {
    holder,
    render: renderRole,
    closeMenuOnOutsidePress(target: Node): void {
      if (roleMenuOpen && !holder.contains(target)) closeRoleMenu(false);
    },
  };
}
