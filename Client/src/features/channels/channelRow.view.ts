/**
 * What a text or announcement channel row and a category group draw, from
 * plain-data models and nothing else.
 *
 * A model is the drawn values after formatting: the resolved flags and the
 * count the badge shows. `reconcileModels` derives a row's signature from its
 * model, so a row cannot draw a value its model does not carry. This module
 * imports no store and binds no handler; `channelRowModel.ts` builds the
 * models and the sidebar binds the click, context menu and drag handlers.
 *
 * The DOM is the one `ChannelSidebar.ts` drew before the row models were split out, class for class and
 * attribute for attribute: sidebar.css, the sidebar unit suite and the channel
 * e2e specs select on it. The roving `tabindex="0"` is the navigation's, set
 * after every draw; it is never a model field.
 */

import { createElement, appendChildren } from "../../lib/dom";
import { createIcon } from "../../lib/icons";
import { shellText } from "../../i18n/shell";

/** What the signed-in user's role may do to channels, decided when a row's
 *  handlers are bound. Not drawn: a change rebinds the row. */
export type ChannelAccess = {
  /** MANAGE_CHANNELS, with the legacy owner/admin fallback. */
  readonly manageChannels: boolean;
  /** MANAGE_MESSAGES, with no legacy fallback (Purge). */
  readonly manageMessages: boolean;
  /** MANAGE_INVITES, with the legacy owner/admin fallback. */
  readonly manageInvites: boolean;
};

export type TextChannelRowModel = {
  readonly kind: "text" | "announcement" | "forum";
  /** Row key; drawn as `data-channel-id` and in the test ids. */
  readonly channelId: number;
  readonly name: string;
  readonly nsfw: boolean;
  readonly private: boolean;
  /** The channel being viewed: the `active` class and `aria-current`. */
  readonly active: boolean;
  /** Looks unread: the `unread` class. A muted channel is quiet unless mentioned. */
  readonly unread: boolean;
  /** The mention badge's count; 0 draws none. */
  readonly mentionCount: number;
  readonly muted: boolean;
  /** Drawn as `channel-draggable` and `data-drag-channel-id`. */
  readonly draggable: boolean;
  /** Not drawn: the drag and Move Up/Down handlers capture the group's order at
   *  bind time, so a reorder must rebind. */
  readonly orderIds: string;
  /** Not drawn: decides which menu entries the row binds. */
  readonly access: ChannelAccess;
};

/**
 * A followed thread under its parent's row: indented, thread glyph,
 * the name bold when unread and a mention badge. Not draggable, and keyed by
 * the thread id apart from channel ids.
 */
export type ThreadRowModel = {
  readonly kind: "thread";
  readonly threadId: number;
  readonly parentId: number;
  readonly name: string;
  /** The thread open in the side panel: the `active` class. */
  readonly active: boolean;
  /** Looks unread: the `unread` class (a muted parent is quiet unless mentioned). */
  readonly unread: boolean;
  readonly mentionCount: number;
  readonly muted: boolean;
};

/** The "N more" row after a parent's first five followed threads. */
export type ThreadMoreRowModel = {
  readonly kind: "threadMore";
  readonly parentId: number;
  readonly count: number;
};

/** A category's header; `name` null is the uncategorized group, which draws
 *  no header. */
export type CategoryGroupModel = {
  /** The group key (`cat:<id>` for a real category), drawn as `data-category-key`; null is the uncategorized group. */
  readonly key: string | null;
  /** The category's name, drawn as `data-category`. */
  readonly name: string | null;
  /** The category's id (0 when it is not a real category), drawn as `data-category-id`. */
  readonly categoryId: number;
  readonly label: string;
  readonly collapsed: boolean;
  /** The header's "+" button. */
  readonly showCreate: boolean;
  /** A real category a manager may drag to reorder: the `category-draggable` class. */
  readonly draggable: boolean;
};

/**
 * The marker on an age-restricted channel row.
 *
 * A glyph plus a title rather than a coloured name: the flag is information
 * about the channel, and recolouring the name would collide with the unread
 * and mention states the row already encodes that way.
 */
export function nsfwIndicator(channelId: number): HTMLSpanElement {
  const badge = createElement("span", {
    class: "ch-nsfw",
    "data-testid": `channel-nsfw-${channelId}`,
    "aria-label": shellText("channel.ageRestricted"),
  });
  badge.title = shellText("channel.ageRestrictedTitle");
  badge.appendChild(createIcon("shield-alert", 13));
  return badge;
}

/**
 * The lock over the bottom-right of a private channel's type glyph, as Discord
 * marks one. A sibling of the glyph rather than a child: the glyph span is
 * aria-hidden, and the lock must stay announced. Positioned by CSS against the
 * row, so it sits alongside the nsfw marker and the capacity badge.
 */
export function privateIndicator(channelId: number): HTMLSpanElement {
  const label = shellText("channel.private");
  const badge = createElement("span", {
    class: "ch-lock",
    "data-testid": `channel-private-${channelId}`,
    role: "img",
    "aria-label": label,
  });
  badge.title = label;
  badge.appendChild(createIcon("lock", 9));
  return badge;
}

/** The mention badge: it counts the mentions, not the messages. Shared by the
 *  text row and the voice row, so both draw the same markup. */
export function mentionBadge(channelId: number, count: number): HTMLSpanElement {
  const badge = createElement(
    "span",
    { class: "mention-badge", "data-testid": `channel-mentions-${channelId}` },
    String(count),
  );
  badge.title = shellText("channel.mentions", { count });
  return badge;
}

/** Draw one text or announcement row, without handlers. */
export function drawTextChannelRow(model: TextChannelRowModel): HTMLDivElement {
  const classes = ["channel-item"];
  if (model.active) classes.push("active");
  if (model.unread) classes.push("unread");
  if (model.mentionCount > 0) classes.push("mentioned");
  if (model.muted) classes.push("muted");
  if (model.draggable) classes.push("channel-draggable");

  const item = createElement("div", {
    class: classes.join(" "),
    "data-testid": `channel-${model.channelId}`,
    // Roving list item: reachable by Tab once, then arrow-stepped.
    role: "link",
    tabindex: "-1",
  });
  item.dataset.channelId = String(model.channelId);
  item.setAttribute("aria-current", model.active ? "page" : "false");
  // The pill is drawn in CSS only, so name the unread state for screen
  // readers; a mention announces itself through its badge.
  if (model.unread && model.mentionCount === 0) {
    item.setAttribute("aria-description", shellText("channel.unread"));
  }
  if (model.draggable) item.dataset.dragChannelId = String(model.channelId);

  const prefix = createElement("span", { class: "ch-icon", "aria-hidden": "true" });
  if (model.kind === "announcement") {
    prefix.appendChild(createIcon("megaphone", 16));
  } else if (model.kind === "forum") {
    prefix.appendChild(createIcon("messages-square", 16));
  } else {
    prefix.textContent = "#";
  }
  appendChildren(item, prefix, createElement("span", { class: "ch-name" }, model.name));

  // Age-restricted marker. Next to the name rather than replacing the "#", so
  // the channel still reads as a channel and the mark is visible whether or
  // not the reader has already accepted the gate this session.
  if (model.nsfw) item.appendChild(nsfwIndicator(model.channelId));
  if (model.private) item.appendChild(privateIndicator(model.channelId));

  if (model.mentionCount > 0) item.appendChild(mentionBadge(model.channelId, model.mentionCount));
  return item;
}

/** Draw one followed-thread row, without handlers. */
export function drawThreadRow(model: ThreadRowModel): HTMLDivElement {
  const classes = ["channel-item", "thread-item"];
  if (model.active) classes.push("active");
  if (model.unread) classes.push("unread");
  if (model.mentionCount > 0) classes.push("mentioned");
  if (model.muted) classes.push("muted");
  const item = createElement("div", {
    class: classes.join(" "),
    "data-testid": `thread-row-${model.threadId}`,
    role: "link",
    tabindex: "-1",
  });
  item.dataset.threadId = String(model.threadId);
  item.dataset.parentId = String(model.parentId);
  item.setAttribute("aria-current", model.active ? "page" : "false");
  if (model.unread && model.mentionCount === 0) {
    item.setAttribute("aria-description", shellText("channel.unread"));
  }
  const prefix = createElement("span", { class: "ch-icon", "aria-hidden": "true" });
  prefix.appendChild(createIcon("message-square", 14));
  appendChildren(item, prefix, createElement("span", { class: "ch-name" }, model.name));
  if (model.mentionCount > 0) {
    const badge = mentionBadge(model.threadId, model.mentionCount);
    badge.setAttribute("data-testid", `thread-mentions-${model.threadId}`);
    item.appendChild(badge);
  }
  return item;
}

/** Draw a parent's "N more" row, without handlers. */
export function drawThreadMoreRow(model: ThreadMoreRowModel): HTMLDivElement {
  const item = createElement("div", {
    class: "channel-item thread-item thread-more",
    "data-testid": `thread-more-${model.parentId}`,
    role: "link",
    tabindex: "-1",
  });
  item.dataset.moreParentId = String(model.parentId);
  appendChildren(
    item,
    createElement("span", { class: "ch-icon", "aria-hidden": "true" }),
    createElement(
      "span",
      { class: "ch-name" },
      shellText("channel.threadsMore", { count: model.count }),
    ),
  );
  return item;
}

/**
 * Draw one category group, without handlers: the group `div`, its header (none
 * for the uncategorized group) and an empty `.category-channels-container`
 * the sidebar fills with rows.
 */
export function drawCategoryGroup(model: CategoryGroupModel): HTMLDivElement {
  const group = createElement("div", {});
  if (model.name !== null) {
    const headerClasses = ["category"];
    if (model.collapsed) headerClasses.push("collapsed");
    if (model.draggable) headerClasses.push("category-draggable");
    const header = createElement("div", { class: headerClasses.join(" ") });
    header.dataset.category = model.name;
    if (model.key !== null) header.dataset.categoryKey = model.key;
    if (model.categoryId > 0) header.dataset.categoryId = String(model.categoryId);
    // Unique per category even when two names slug alike (a rename can make one).
    const labelId = `category-name-${model.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}${
      model.categoryId > 0 ? `-${model.categoryId}` : ""
    }`;

    // The arrow is the keyboard-operated collapse control; the header div
    // itself keeps its mouse click handler. A real <button> here (rather
    // than making the whole header a button) keeps the header's own "+" from
    // being an interactive element nested inside another one. The label
    // names the arrow (aria-labelledby), so no second copy of the category
    // name is needed.
    const label = createElement("span", { class: "category-name", id: labelId }, model.label);
    const arrow = createElement("button", {
      type: "button",
      class: "category-arrow",
      "aria-expanded": model.collapsed ? "false" : "true",
      "aria-labelledby": labelId,
    });
    arrow.appendChild(createIcon(model.collapsed ? "chevron-right" : "chevron-down", 12));
    appendChildren(header, arrow, label);

    if (model.showCreate) {
      header.appendChild(
        createElement(
          "button",
          {
            type: "button",
            class: "category-add-btn",
            title: shellText("channel.create"),
            "aria-label": shellText("channel.create"),
            "data-testid": `create-channel-${model.name.toLowerCase().replace(/\s+/g, "-")}`,
          },
          "+",
        ),
      );
    }
    group.appendChild(header);
  }
  // Built even when collapsed: the joined voice channel stays visible there,
  // and a later join or leave reconciles this container in place.
  group.appendChild(createElement("div", { class: "category-channels-container" }));
  return group;
}
