/**
 * MemberList component — shows server members grouped by role with online status.
 * Subscribes to membersStore for reactive updates.
 */

import { createElement, appendChildren, clearChildren, setText } from "@lib/dom";
import type { MountableComponent } from "@lib/safe-render";
import { membersStore, type Member } from "@stores/members.store";
import type { UserStatus } from "@lib/types";

/** Ordered role groups with display names and CSS color variables. */
const ROLE_GROUPS: readonly {
  readonly role: string;
  readonly label: string;
  readonly colorVar: string;
}[] = [
  { role: "owner", label: "OWNER", colorVar: "var(--role-owner, #e74c3c)" },
  { role: "admin", label: "ADMIN", colorVar: "var(--role-admin, #f39c12)" },
  { role: "moderator", label: "MODERATOR", colorVar: "var(--role-mod, #2ecc71)" },
  { role: "member", label: "MEMBER", colorVar: "var(--role-member, #949ba4)" },
] as const;

/** Status priority for sorting: lower = higher priority (shown first). */
function statusPriority(status: UserStatus): number {
  switch (status) {
    case "online": return 0;
    case "idle": return 1;
    case "dnd": return 2;
    case "offline": return 3;
  }
}

function statusColor(status: UserStatus): string {
  switch (status) {
    case "online": return "var(--green)";
    case "idle": return "var(--yellow)";
    case "dnd": return "var(--red)";
    case "offline": return "var(--text-micro)";
  }
}

function createMemberItem(member: Member, colorVar: string): HTMLDivElement {
  const item = createElement("div", {
    class: member.status === "offline" ? "member-item offline" : "member-item",
    "data-testid": `member-${member.id}`,
  });

  const initial = member.username.charAt(0).toUpperCase() || "?";
  const avatar = createElement(
    "div",
    { class: "mi-avatar", style: `background: ${colorVar}` },
    initial,
  );

  const statusDot = createElement("div", {
    class: "mi-status",
    style: `background: ${statusColor(member.status)}`,
  });
  avatar.appendChild(statusDot);

  const name = createElement(
    "span",
    { class: "mi-name", style: `color: ${colorVar}` },
  );
  setText(name, member.username);

  appendChildren(item, avatar, name);
  return item;
}

function renderList(root: HTMLDivElement): void {
  clearChildren(root);

  const state = membersStore.getState();
  const allMembers = Array.from(state.members.values());

  for (const group of ROLE_GROUPS) {
    const groupMembers = allMembers
      .filter((m) => m.role === group.role)
      .sort((a, b) => statusPriority(a.status) - statusPriority(b.status));

    if (groupMembers.length === 0) continue;

    const header = createElement(
      "div",
      { class: "member-role-group" },
      `${group.label} \u2014 ${groupMembers.length}`,
    );
    root.appendChild(header);

    for (const member of groupMembers) {
      root.appendChild(createMemberItem(member, group.colorVar));
    }
  }
}

export function createMemberList(): MountableComponent {
  const ac = new AbortController();
  let root: HTMLDivElement | null = null;
  let unsubscribe: (() => void) | null = null;

  function mount(container: Element): void {
    root = createElement("div", { class: "member-list", "data-testid": "member-list" });
    renderList(root);

    unsubscribe = membersStore.subscribe(() => {
      if (root !== null) {
        renderList(root);
      }
    });

    container.appendChild(root);
  }

  function destroy(): void {
    ac.abort();
    if (unsubscribe !== null) {
      unsubscribe();
      unsubscribe = null;
    }
    if (root !== null) {
      root.remove();
      root = null;
    }
  }

  return { mount, destroy };
}
