/**
 * What a voice channel row draws, from plain-data models and nothing else
 * (its participant rows are `voiceUserRow.view.ts`, re-exported here).
 *
 * A model is the drawn values after formatting: the resolved name, each
 * tooltip with its fingerprint or safety number already in it, the capacity
 * label, a boolean per icon. `reconcileModels` derives a row's signature from
 * its model, so the row cannot draw a value its model does not carry. This
 * module imports no store and binds no handler; `voiceRowModel.ts` builds the
 * models from a state snapshot and the sidebar binds the handlers.
 *
 * The DOM is the one `ChannelSidebar.ts`'s `renderVoiceChannelItem` drew
 * before the row models were split out, class for class and attribute for attribute: sidebar.css, the
 * sidebar unit suite and the voice e2e specs select on it.
 */

import { createElement, appendChildren, setText } from "../../lib/dom";
import { createIcon } from "../../lib/icons";
import { shellText } from "../../i18n/shell";
import {
  mentionBadge,
  nsfwIndicator,
  passwordIndicator,
  privateIndicator,
  treeItemAttrs,
} from "./channelRow.view";

// The participant row moved to its own module; importers of this one keep working.
export {
  VOICE_USER_PATCH_FIELDS,
  drawVoiceUserRow,
  patchVoiceUserRow,
  type VoiceAudioModel,
  type VoiceUserRowModel,
  type VoiceVerifyModel,
} from "./voiceUserRow.view";

/** A voice channel's own row (the wrapper's `.channel-item` and the timeout
 *  notice), without its participant list. */
export type VoiceChannelChromeModel = {
  readonly channelId: number;
  readonly name: string;
  readonly nsfw: boolean;
  readonly private: boolean;
  /** Joining asks for a password: drawn as a lock beside the name. */
  readonly passwordProtected: boolean;
  /** The server's AFK channel: marked with a moon and an "AFK" label. */
  readonly afk: boolean;
  /** The local user is in this channel: drawn as `active`. */
  readonly joined: boolean;
  /** Why a click does nothing now (socket down, timed out); null when it works. */
  readonly frozenReason: string | null;
  /** The timeout notice under the row; null when there is none or when joined. */
  readonly timeoutReason: string | null;
  /** "3/5" and its tooltip for a channel with a user limit, else null. */
  readonly capacity: { readonly label: string; readonly title: string } | null;
  /** The mention badge's count; 0 draws none. Unread is never drawn here. */
  readonly mentionCount: number;
  /** Someone in the channel shares a screen: a LIVE tag on the row. Only a tree
   *  sets it, and an absent field reads as false. */
  readonly live?: boolean;
};

/** The fields `patchVoiceChannelChrome` changes in place. */
export const VOICE_CHROME_PATCH_FIELDS = [
  "passwordProtected",
  "afk",
  "joined",
  "live",
  "frozenReason",
  "timeoutReason",
  "capacity",
  "mentionCount",
] as const;

function drawCapacity(
  channelId: number,
  capacity: NonNullable<VoiceChannelChromeModel["capacity"]>,
): HTMLSpanElement {
  const badge = createElement(
    "span",
    { class: "ch-capacity", "data-testid": `channel-capacity-${channelId}` },
    capacity.label,
  );
  badge.title = capacity.title;
  return badge;
}

/** The moon and "AFK" on the server's AFK channel; a readout, the server owns
 *  the flag. The glyph is decorative, the text names it. */
function drawAfk(channelId: number): HTMLSpanElement {
  const badge = createElement("span", {
    class: "ch-afk",
    "data-testid": `channel-afk-${channelId}`,
  });
  const glyph = createElement("span", { "aria-hidden": "true" });
  glyph.appendChild(createIcon("moon", 11));
  appendChildren(badge, glyph, createElement("span", {}, shellText("channel.afk")));
  badge.title = shellText("channel.afkTitle");
  return badge;
}

/** LIVE on the row of a channel where someone shares a screen (a tree hides the per-person tag). */
function drawLive(channelId: number): HTMLSpanElement {
  return createElement(
    "span",
    { class: "ch-live", "data-testid": `channel-live-${channelId}` },
    shellText("channel.live"),
  );
}

function drawRestriction(channelId: number, reason: string): HTMLDivElement {
  return createElement(
    "div",
    { class: "ch-restriction", "data-testid": `voice-timeout-${channelId}` },
    reason,
  );
}

/** The `.channel-item` classes for a state, in draw order. */
function chromeClasses(model: VoiceChannelChromeModel): string[] {
  const classes = ["channel-item", "voice"];
  if (model.joined) classes.push("active");
  if (model.frozenReason !== null) classes.push("disabled");
  return classes;
}

/**
 * Draw a voice channel's wrapper: the `.channel-item` row and, when timed out,
 * the `.ch-restriction` notice. No handlers and no participant list; the
 * sidebar appends `.voice-users-list` after them.
 */
export function drawVoiceChannelChrome(
  model: VoiceChannelChromeModel,
  tree = false,
): HTMLDivElement {
  const wrapper = createElement("div", {});
  const item = createElement("div", {
    class: chromeClasses(model).join(" "),
    "data-testid": `channel-${model.channelId}`,
    // Roving list item: reachable by Tab once, then arrow-stepped.
    ...(tree ? treeItemAttrs("row") : { role: "button", tabindex: "-1" }),
  });
  item.dataset.channelId = String(model.channelId);
  if (model.frozenReason !== null) {
    item.title = model.frozenReason;
    item.setAttribute("aria-disabled", "true");
  }

  const prefix = createElement("span", { class: "ch-icon", "aria-hidden": "true" });
  prefix.appendChild(createIcon("volume-2", 16));
  appendChildren(item, prefix, createElement("span", { class: "ch-name" }, model.name));
  if (model.nsfw) item.appendChild(nsfwIndicator(model.channelId));
  if (model.private) item.appendChild(privateIndicator(model.channelId));
  if (model.passwordProtected) item.appendChild(passwordIndicator(model.channelId));
  if (model.afk) item.appendChild(drawAfk(model.channelId));
  if (model.live === true) item.appendChild(drawLive(model.channelId));
  if (model.capacity !== null) item.appendChild(drawCapacity(model.channelId, model.capacity));
  if (model.mentionCount > 0) item.appendChild(mentionBadge(model.channelId, model.mentionCount));

  wrapper.appendChild(item);
  if (model.timeoutReason !== null) {
    wrapper.appendChild(drawRestriction(model.channelId, model.timeoutReason));
  }
  return wrapper;
}

/** Put `drawn` before `later`, the first badge a fresh draw puts after it, else last. */
function insertBefore(item: HTMLElement, drawn: Element, later: Element | null): void {
  if (later === null) item.appendChild(drawn);
  else later.before(drawn);
}

function patchChromeRow(item: HTMLElement, next: VoiceChannelChromeModel): void {
  const own = new Set(["channel-item", "voice", "active", "disabled"]);
  const foreign = Array.from(item.classList).filter((c) => !own.has(c));
  const classes = [...chromeClasses(next), ...foreign].join(" ");
  if (item.className !== classes) item.className = classes;

  if (next.frozenReason === null) {
    item.removeAttribute("title");
    item.removeAttribute("aria-disabled");
  } else {
    item.title = next.frozenReason;
    item.setAttribute("aria-disabled", "true");
  }
}

function patchPasswordBadge(item: HTMLElement, next: VoiceChannelChromeModel): void {
  const lockBadge = item.querySelector(":scope > .ch-password");
  if (!next.passwordProtected) {
    lockBadge?.remove();
  } else if (lockBadge === null) {
    // Before the afk, capacity and mention badges, as a fresh draw orders them.
    insertBefore(
      item,
      passwordIndicator(next.channelId),
      item.querySelector(
        ":scope > .ch-afk, :scope > .ch-live, :scope > .ch-capacity, :scope > .mention-badge",
      ),
    );
  }
}

function patchAfkBadge(item: HTMLElement, next: VoiceChannelChromeModel): void {
  const afkBadge = item.querySelector(":scope > .ch-afk");
  if (!next.afk) {
    afkBadge?.remove();
  } else if (afkBadge === null) {
    // Before the capacity and mention badges, as a fresh draw orders them.
    insertBefore(
      item,
      drawAfk(next.channelId),
      item.querySelector(":scope > .ch-live, :scope > .ch-capacity, :scope > .mention-badge"),
    );
  }
}

function patchLiveBadge(item: HTMLElement, next: VoiceChannelChromeModel): void {
  const badge = item.querySelector(":scope > .ch-live");
  if (next.live !== true) {
    badge?.remove();
  } else if (badge === null) {
    // Before the capacity and mention badges, as a fresh draw orders them.
    insertBefore(
      item,
      drawLive(next.channelId),
      item.querySelector(":scope > .ch-capacity, :scope > .mention-badge"),
    );
  }
}

function patchCapacityBadge(item: HTMLElement, next: VoiceChannelChromeModel): void {
  const badge = item.querySelector(":scope > .ch-capacity");
  if (next.capacity === null) {
    badge?.remove();
  } else if (badge === null) {
    // Before the mention badge, which a fresh draw puts last.
    insertBefore(
      item,
      drawCapacity(next.channelId, next.capacity),
      item.querySelector(":scope > .mention-badge"),
    );
  } else {
    if (badge.textContent !== next.capacity.label) setText(badge, next.capacity.label);
    badge.setAttribute("title", next.capacity.title);
  }
}

function patchMentionBadge(item: HTMLElement, next: VoiceChannelChromeModel): void {
  const mentionEl = item.querySelector<HTMLElement>(":scope > .mention-badge");
  if (next.mentionCount === 0) {
    mentionEl?.remove();
  } else if (mentionEl === null) {
    item.appendChild(mentionBadge(next.channelId, next.mentionCount));
  } else if (mentionEl.textContent !== String(next.mentionCount)) {
    mentionEl.replaceWith(mentionBadge(next.channelId, next.mentionCount));
  }
}

/** Directly after the row: the participant list, when present, follows it. */
function patchTimeoutNotice(
  wrapper: Element,
  item: HTMLElement,
  next: VoiceChannelChromeModel,
): void {
  const notice = wrapper.querySelector(":scope > .ch-restriction");
  if (next.timeoutReason === null) {
    notice?.remove();
  } else if (notice === null) {
    item.after(drawRestriction(next.channelId, next.timeoutReason));
  } else if (notice.textContent !== next.timeoutReason) {
    setText(notice, next.timeoutReason);
  }
}

/**
 * Bring a drawn wrapper to `next`; only `VOICE_CHROME_PATCH_FIELDS` differ.
 * Classes other modules add to the row (a drop indicator) are kept, and
 * `tabindex` is left to the roving navigation that owns it.
 */
export function patchVoiceChannelChrome(wrapper: Element, next: VoiceChannelChromeModel): void {
  const item = wrapper.querySelector<HTMLElement>(":scope > .channel-item");
  if (item === null) return;
  patchChromeRow(item, next);
  patchPasswordBadge(item, next);
  patchAfkBadge(item, next);
  patchLiveBadge(item, next);
  patchCapacityBadge(item, next);
  patchMentionBadge(item, next);
  patchTimeoutNotice(wrapper, item, next);
}
