// Pieces of the server rail that need no per-rail state: its icons, drop zone
// maths, round action buttons and the DM icons under Home.
import { appendChildren, createElement } from "@lib/dom";
import { type ItemRef } from "@lib/prefs/serverRailLayout";
import { uiStore } from "@stores/ui.store";
import { dmDisplayName, dmStore, type DmChannel } from "@stores/dm.store";
import { dmUnreadCount } from "@lib/dmUnread";
import { createAvatarElement, pickAvatarColor } from "../profiles/avatar";
import { formatBadgeCount } from "@lib/text/formatting";
import { serverRailText } from "../../i18n/serverRail";

export type DropZone = "before" | "after" | "into";

const SVG_NS = "http://www.w3.org/2000/svg";

// Lucide paths, kept here rather than in lib/icons so they stay out of the
// startup closure (lib/icons is imported eagerly).
const RAIL_ICON_PATHS = {
  plus: ["M5 12h14", "M12 5v14"],
  compass: [
    "M22 12a10 10 0 1 1-20 0a10 10 0 0 1 20 0z",
    "m16.24 7.76-1.804 5.411a2 2 0 0 1-1.265 1.265L7.76 16.24l1.804-5.411a2 2 0 0 1 1.265-1.265z",
  ],
  folder: [
    "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z",
  ],
  server: [
    "M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z",
    "M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z",
    "M6 6h.01",
    "M6 18h.01",
  ],
  phone: [
    "M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z",
  ],
} as const;

export function railIcon(name: keyof typeof RAIL_ICON_PATHS): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of [
    ["viewBox", "0 0 24 24"],
    ["width", "24"],
    ["height", "24"],
    ["fill", "none"],
    ["stroke", "currentColor"],
    ["stroke-width", "2"],
    ["stroke-linecap", "round"],
    ["stroke-linejoin", "round"],
    ["aria-hidden", "true"],
    ["data-icon", name],
  ] as const) {
    svg.setAttribute(k, v);
  }
  svg.classList.add("icon");
  for (const d of RAIL_ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

export const FALLBACK_COLOR = "var(--accent)";
export const COLOR_NAME_KEYS = [
  "color.blurple",
  "color.green",
  "color.amber",
  "color.red",
  "color.pink",
  "color.grey",
] as const;

export function defaultFolderId(): string {
  return `f-${globalThis.crypto.randomUUID()}`;
}

export function atDmMode(): boolean {
  return uiStore.getState().sidebarMode === "dms";
}

export function zoneOf(e: DragEvent, el: HTMLElement, allowInto: boolean): DropZone {
  const rect = el.getBoundingClientRect();
  if (rect.height === 0) return allowInto ? "into" : "after";
  const y = (e.clientY - rect.top) / rect.height;
  if (allowInto) {
    if (y < 0.25) return "before";
    if (y > 0.75) return "after";
    return "into";
  }
  return y < 0.5 ? "before" : "after";
}

export function sameItem(a: ItemRef, b: ItemRef): boolean {
  if (a.kind === "server" && b.kind === "server") return a.host === b.host;
  if (a.kind === "folder" && b.kind === "folder") return a.id === b.id;
  return false;
}

export function roundButton(
  cls: string,
  testId: string,
  label: string,
  icon: "plus" | "compass",
  onClick: () => void,
): HTMLElement {
  const btn = createElement("button", {
    type: "button",
    class: `server-rail-btn server-rail-action ${cls}`,
    title: label,
    "aria-label": label,
    "data-testid": testId,
  });
  btn.appendChild(railIcon(icon));
  btn.addEventListener("click", onClick);
  return btn;
}

/** One DM icon under Home: unread badge, or the call badge while its call is the current one. */
export function dmItem(
  dm: DmChannel,
  inCall: boolean,
  onOpenDm: ((dm: DmChannel) => void) | undefined,
): HTMLElement {
  const name = dmDisplayName(dm);
  const count = dmUnreadCount(dm);
  const label = inCall
    ? count > 0
      ? serverRailText("dmCallUnread", { name, count })
      : serverRailText("dmCall", { name })
    : serverRailText("dmUnread", { name, count });
  const wrapper = createElement("div", { class: "server-rail-item" });
  const btn = createElement("button", {
    type: "button",
    class: "server-rail-btn server-rail-dm",
    title: inCall ? serverRailText("dmCall", { name }) : name,
    "aria-label": label,
    "data-testid": inCall ? "server-rail-dm-call" : "server-rail-dm",
    "data-channel-id": String(dm.channelId),
  });
  const subject = dm.isGroup
    ? { username: name, avatar: dm.icon ?? null }
    : { username: dm.recipient.username, avatar: dm.recipient.avatar };
  btn.appendChild(
    createAvatarElement(subject, {
      className: "server-rail-dm-avatar",
      background: pickAvatarColor(subject.username),
      decorative: true,
    }),
  );
  btn.addEventListener("click", () => {
    const live = dmStore.getState().channels.find((c) => c.channelId === dm.channelId);
    onOpenDm?.(live ?? dm);
  });
  if (inCall) {
    // The call outranks an unread count: the badge says why the icon is there.
    const callBadge = createElement("span", {
      class: "server-rail-call-badge",
      "aria-hidden": "true",
    });
    callBadge.appendChild(railIcon("phone"));
    appendChildren(wrapper, btn, callBadge);
    return wrapper;
  }
  const badge = createElement(
    "span",
    { class: "server-rail-badge", "aria-hidden": "true" },
    formatBadgeCount(count),
  );
  appendChildren(wrapper, btn, badge);
  return wrapper;
}

/** Home's name: its unread DMs and waiting requests, each said apart. */
export function homeLabel(unread: number, requests: number): string {
  if (requests === 0) {
    return unread === 0 ? serverRailText("home") : serverRailText("homeUnread", { count: unread });
  }
  return unread === 0
    ? serverRailText("homeRequests", { count: requests })
    : serverRailText("homeUnreadRequests", { count: requests, unread });
}
