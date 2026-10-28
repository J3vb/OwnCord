/**
 * GroupDmMemberPanel -- right-side panel listing the members of a group DM
 * (WP 3B-11a): you plus everyone else, a crown on the owner, Add People in the
 * header, and, for the owner, Remove From Group / Make Group Owner on every
 * other member (right-click, the menu key, or the ⋯ button).
 *
 * Presentational: the page controller hands it a `GroupPanelView` built from
 * the live stores and calls `update` when they change. It runs no requests; the
 * actions it offers are callbacks.
 *
 * A11y: role="complementary", each member is a button that opens their
 * profile, Escape closes the panel when focus is inside it.
 */

import { isImeCommit } from "@lib/ime";
import { Disposable } from "@lib/disposable";
import { dialogOpen } from "@lib/dialogOpen";
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { showContextMenu, openMenuOnKeyboard } from "@lib/context-menu";
import { createConfirmModal } from "@lib/confirmModal";
import type { MountableComponent } from "@lib/safe-render";
import type { UserStatus } from "@lib/types";
import { createAvatarElement, pickAvatarColor } from "./message-list/avatar";
import type { GroupMemberView, GroupPanelView } from "../features/direct-messages/groupMembers";
import { groupDmText } from "../i18n/groupDm";
import { statusLabel } from "../i18n/shell";

export interface GroupDmMemberPanelOptions {
  readonly view: GroupPanelView;
  readonly onClose: () => void;
  /** Add People was pressed (offered only while `view.canAdd`). */
  readonly onAddPeople: () => void;
  /** A member was clicked: open their profile popup at (x, y). */
  readonly onOpenProfile: (member: GroupMemberView, x: number, y: number) => void;
  /** Owner action, already confirmed by the panel; `channelId` is the group it was asked for. */
  readonly onRemove: (channelId: number, member: GroupMemberView) => void;
  /** Owner action, already confirmed by the panel; `channelId` is the group it was asked for. */
  readonly onMakeOwner: (channelId: number, member: GroupMemberView) => void;
  /** Move focus to the panel on mount (the user opened it). Default true. */
  readonly focus?: boolean;
}

export type GroupDmMemberPanelComponent = MountableComponent & {
  readonly isOpen: () => boolean;
  /** Repaint from a fresher view (members added or removed, owner changed). */
  readonly update: (view: GroupPanelView) => void;
};

function statusColor(status: string): string {
  switch (status) {
    case "online":
      return "var(--green)";
    case "idle":
      return "var(--yellow)";
    case "dnd":
      return "var(--red)";
    default:
      return "var(--text-micro)";
  }
}

function asUserStatus(status: string): UserStatus {
  return status === "online" || status === "idle" || status === "dnd" ? status : "offline";
}

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The owner's crown (Lucide). Built here rather than added to the shared icon
 * set so its path data loads with this lazy panel, not with the main page.
 */
function createCrownIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({
    viewBox: "0 0 24 24",
    width: "14",
    height: "14",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "aria-hidden": "true",
  })) {
    svg.setAttribute(k, v);
  }
  const body = document.createElementNS(SVG_NS, "path");
  body.setAttribute(
    "d",
    "M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z",
  );
  const base = document.createElementNS(SVG_NS, "path");
  base.setAttribute("d", "M5 21h14");
  svg.append(body, base);
  return svg;
}

interface ConfirmSpec {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly danger: boolean;
  readonly testId: string;
}

/** Ask before an owner action; Cancel is focused first, Escape and the backdrop cancel. */
function confirmOwnerAction(
  spec: ConfirmSpec,
  stillValid: () => boolean,
  onConfirm: () => void,
): void {
  createConfirmModal({
    title: spec.title,
    titleId: `${spec.testId}-title`,
    body: createElement("p", {}, spec.body),
    confirmLabel: spec.confirmLabel,
    cancelLabel: groupDmText("cancel"),
    tone: spec.danger ? "danger" : "primary",
    testId: spec.testId,
    confirmTestId: `${spec.testId}-confirm`,
    cancelTestId: `${spec.testId}-cancel`,
    onConfirm: () => {
      // The group may have changed while the dialog was open: send nothing
      // unless you still own it and the target is still in it.
      if (stillValid()) onConfirm();
    },
  });
}

export function createGroupDmMemberPanel(
  options: GroupDmMemberPanelOptions,
): GroupDmMemberPanelComponent {
  const disposable = new Disposable();
  const { signal } = disposable;
  let view = options.view;
  let panel: HTMLElement | null = null;
  let body: HTMLDivElement | null = null;
  let bodyOwner: Disposable | null = null;
  let open = false;

  /** The label a confirm dialog names the group by. */
  function groupLabel(): string {
    if (view.groupName !== "") return view.groupName;
    return view.members
      .filter((m) => !m.isSelf)
      .map((m) => m.name)
      .join(", ");
  }

  /** The confirm's last look before sending: still the owner of the same group, target still in it. */
  function stillCanManage(channelId: number, targetId: number): boolean {
    return (
      view.channelId === channelId &&
      view.canManage &&
      view.members.some((m) => m.id === targetId && !m.isSelf)
    );
  }

  function askRemove(member: GroupMemberView): void {
    const channelId = view.channelId;
    confirmOwnerAction(
      {
        title: groupDmText("removeTitle", { name: member.name }),
        body: groupDmText("removeBody", { name: member.name, group: groupLabel() }),
        confirmLabel: groupDmText("removeConfirm"),
        danger: true,
        testId: "group-remove-confirm",
      },
      () => stillCanManage(channelId, member.id),
      () => options.onRemove(channelId, member),
    );
  }

  function askMakeOwner(member: GroupMemberView): void {
    const channelId = view.channelId;
    confirmOwnerAction(
      {
        title: groupDmText("ownerTitle", { name: member.name }),
        body: groupDmText("ownerBody", { name: member.name }),
        confirmLabel: groupDmText("ownerConfirm"),
        danger: false,
        testId: "group-owner-confirm",
      },
      () => stillCanManage(channelId, member.id),
      () => options.onMakeOwner(channelId, member),
    );
  }

  /**
   * The open owner menu, if any. It belongs to the panel, not to a rebuild of
   * the list, so a repaint (a new message in the group, a presence change)
   * leaves it open; it closes when its member leaves or the owner role moves.
   */
  let menu: { readonly memberId: number; readonly owner: Disposable } | null = null;

  function closeMenu(): void {
    const current = menu;
    menu = null;
    current?.owner.destroy();
  }

  function openMemberMenu(member: GroupMemberView, x: number, y: number): void {
    closeMenu();
    const owner = new Disposable();
    const mine = { memberId: member.id, owner };
    menu = mine;
    showContextMenu({
      x,
      y,
      signal: owner.signal,
      className: "group-member-menu",
      onClosed: () => {
        if (menu === mine) menu = null;
      },
      items: [
        {
          label: groupDmText("makeOwner"),
          testId: `group-make-owner-${member.id}`,
          onClick: () => askMakeOwner(member),
        },
        {
          label: groupDmText("removeMember"),
          danger: true,
          testId: `group-remove-${member.id}`,
          onClick: () => askRemove(member),
        },
      ],
    });
  }

  function buildRow(member: GroupMemberView, rowSignal: AbortSignal): HTMLElement {
    const label = member.isSelf ? groupDmText("self", { name: member.name }) : member.name;
    const row = createElement("div", {
      class: "member-item group-member-item",
      "data-testid": `group-member-row-${member.id}`,
      role: "listitem",
    });
    // A real button for the name: opens the profile. The actions button below
    // is its sibling, never nested in it.
    const main = createElement("button", {
      type: "button",
      class: "gm-main",
      "data-testid": `group-member-${member.id}`,
      "aria-haspopup": "dialog",
      "aria-label": member.isOwner ? `${label}, ${groupDmText("ownerBadge")}` : label,
    });
    const avatar = createAvatarElement(
      { username: member.username, displayName: member.name, avatar: member.avatar },
      { className: "mi-avatar", background: pickAvatarColor(member.username), decorative: true },
    );
    avatar.appendChild(
      createElement("div", {
        class: "mi-status",
        style: `background: ${statusColor(member.status)}`,
        title: statusLabel(asUserStatus(member.status)),
      }),
    );
    const name = createElement("span", { class: "mi-name" }, label);
    appendChildren(main, avatar, name);
    if (member.isOwner) {
      const crown = createElement("span", {
        class: "gm-crown",
        title: groupDmText("ownerBadge"),
        "aria-hidden": "true",
        "data-testid": `group-owner-${member.id}`,
      });
      crown.appendChild(createCrownIcon());
      main.appendChild(crown);
    }
    row.appendChild(main);

    main.addEventListener(
      "click",
      (e) => {
        // A keyboard activation has no pointer position: anchor to the button.
        if (e.detail === 0) {
          const rect = main.getBoundingClientRect();
          options.onOpenProfile(member, rect.left, rect.top);
        } else {
          options.onOpenProfile(member, e.clientX, e.clientY);
        }
      },
      { signal: rowSignal },
    );

    // Owner actions: on other members only. Everyone else gets no menu at all.
    if (view.canManage && !member.isSelf) {
      row.addEventListener(
        "contextmenu",
        (e) => {
          e.preventDefault();
          openMemberMenu(member, e.clientX, e.clientY);
        },
        { signal: rowSignal },
      );
      openMenuOnKeyboard(main, (x, y) => openMemberMenu(member, x, y), rowSignal);
      const more = createElement("button", {
        type: "button",
        class: "gm-more",
        title: groupDmText("moreActions", { name: member.name }),
        "aria-label": groupDmText("moreActions", { name: member.name }),
        "aria-haspopup": "menu",
        "data-testid": `group-member-actions-${member.id}`,
      });
      more.appendChild(createIcon("ellipsis", 16));
      more.addEventListener(
        "click",
        () => {
          const rect = more.getBoundingClientRect();
          openMemberMenu(member, rect.left, rect.bottom);
        },
        { signal: rowSignal },
      );
      row.appendChild(more);
    }
    return row;
  }

  function buildBody(): HTMLDivElement {
    bodyOwner?.destroy();
    bodyOwner = new Disposable();
    const rowSignal = bodyOwner.signal;
    const content = createElement("div", { class: "gm-body" });
    const head = createElement("div", { class: "gm-head" });
    head.appendChild(
      createElement(
        "div",
        { class: "gm-heading", "data-testid": "group-member-count" },
        groupDmText("membersHeading", { count: view.members.length }),
      ),
    );
    if (view.canAdd) {
      const add = createElement("button", {
        type: "button",
        class: "gm-add",
        "data-testid": "group-add-people",
      });
      add.appendChild(createIcon("user-plus", 16));
      add.appendChild(createElement("span", {}, groupDmText("addPeople")));
      add.addEventListener("click", () => options.onAddPeople(), { signal: rowSignal });
      head.appendChild(add);
    }
    content.appendChild(head);
    const list = createElement("div", { class: "gm-list", role: "list" });
    for (const member of view.members) list.appendChild(buildRow(member, rowSignal));
    content.appendChild(list);
    return content;
  }

  function mount(container: Element): void {
    open = true;
    panel = createElement("div", {
      class: "dm-profile-sidebar group-member-panel",
      role: "complementary",
      "aria-label": groupDmText("panelLabel"),
      tabindex: "-1",
      "data-testid": "group-member-panel",
    });
    const closeBtn = createElement("button", {
      class: "dps-close",
      type: "button",
      "aria-label": groupDmText("close"),
      "data-testid": "group-panel-close",
    });
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => options.onClose(), { signal });
    panel.appendChild(closeBtn);
    body = buildBody();
    panel.appendChild(body);
    container.appendChild(panel);
    if (options.focus !== false) panel.focus();

    // Escape closes the panel only for a key meant for it: a dialog on top or
    // a handler that already used the key owns it, and with focus outside the
    // panel (the composer) Escape is not this panel's.
    let escapeTaken = false;
    window.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key === "Escape" && !isImeCommit(e)) escapeTaken = dialogOpen();
      },
      { capture: true, signal },
    );
    document.addEventListener(
      "keydown",
      (e: KeyboardEvent) => {
        if (e.key !== "Escape" || isImeCommit(e) || !open) return;
        if (escapeTaken || e.defaultPrevented) return;
        if (panel === null || !panel.contains(document.activeElement)) return;
        e.preventDefault();
        options.onClose();
      },
      { signal },
    );
  }

  let painted = JSON.stringify(options.view);

  function update(next: GroupPanelView): void {
    view = next;
    if (panel === null || body === null) return;
    // Nothing the panel draws has changed (a new message or an unread count
    // replaced the channel object): keep the DOM, the focus and any open menu.
    const key = JSON.stringify(next);
    if (key === painted) return;
    painted = key;

    const active = document.activeElement;
    const focusedId =
      active instanceof HTMLElement && body.contains(active) ? active.dataset["testid"] : undefined;
    const fresh = buildBody();
    body.replaceWith(fresh);
    body = fresh;

    if (menu !== null) {
      const id = menu.memberId;
      if (!next.canManage || !next.members.some((m) => m.id === id && !m.isSelf)) closeMenu();
    }
    if (focusedId !== undefined) {
      // Same control if it survives, else the same member's profile button,
      // else the panel (the member is gone).
      const memberId = /(\d+)$/.exec(focusedId)?.[1];
      const target =
        fresh.querySelector<HTMLElement>(`[data-testid="${focusedId}"]`) ??
        (memberId === undefined
          ? null
          : fresh.querySelector<HTMLElement>(`[data-testid="group-member-${memberId}"]`));
      (target ?? panel).focus();
    }
  }

  function destroy(): void {
    open = false;
    disposable.destroy();
    closeMenu();
    bodyOwner?.destroy();
    bodyOwner = null;
    panel?.remove();
    panel = null;
    body = null;
  }

  return { mount, destroy, isOpen: () => open, update };
}
