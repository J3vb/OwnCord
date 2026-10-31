/**
 * What a voice channel row and its participant rows draw, from plain-data
 * models and nothing else.
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
import { createIcon, type IconName } from "../../lib/icons";
import { shellText } from "../../i18n/shell";
import type { createAvatarElement } from "../profiles/avatar";
import {
  mentionBadge,
  nsfwIndicator,
  passwordIndicator,
  privateIndicator,
} from "./channelRow.view";

/** The avatar drawer, injected: a feature reaches the UI layer only lazily. */
export type CreateAvatar = typeof createAvatarElement;

/** The one mute or deafen icon a participant shows: deafen wins over mute. */
export type VoiceAudioModel = {
  readonly icon: "mic-off" | "headphones-off";
  /** A moderator imposed it: drawn with `vu-server-muted`. */
  readonly server: boolean;
  /** The tooltip; null draws no title (an ordinary self-mute). */
  readonly title: string | null;
};

/** A peer's E2EE identity badge exactly as drawn. `cls` is the verification
 *  status and is the badge's class, so a stale or wrong status cannot hide
 *  behind an equal icon. */
export type VoiceVerifyModel = {
  readonly cls: "verified" | "changed" | "unverified" | "mismatch" | "unknown";
  readonly icon: IconName;
  readonly color: string;
  readonly title: string;
};

export type VoiceUserRowModel = {
  /** Row key; drawn as `data-voice-uid`. */
  readonly userId: number;
  /** The name shown: display name, else username, else "Unknown". */
  readonly name: string;
  /** The name the avatar shows: its initial and the picture's alt text. */
  readonly avatarName: string;
  /** The letter avatar's background, from the username. */
  readonly avatarColor: string;
  readonly avatarUrl: string | null;
  /** Patch field: the speaking ring toggles in place. */
  readonly speaking: boolean;
  readonly camera: boolean;
  /** Screen share: the monitor icon and the LIVE badge. */
  readonly live: boolean;
  readonly audio: VoiceAudioModel | null;
  /** Muted for this client only. */
  readonly localMuted: boolean;
  /** The local user's own session fingerprint badge title; null for others. */
  readonly ownFingerprintTitle: string | null;
  /** Never a patch field and never defaulted: null when the snapshot holds no
   *  verification for this user, so an unverified peer never draws verified. */
  readonly verify: VoiceVerifyModel | null;
  /** Drawn as `voice-user-draggable`: the row can be dragged to move them. */
  readonly draggable: boolean;
  /** Not drawn: decides which handlers the sidebar binds to the row. */
  readonly self: boolean;
};

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
};

/** The fields `patchVoiceUserRow` changes in place. */
export const VOICE_USER_PATCH_FIELDS = ["speaking"] as const;

/** The fields `patchVoiceChannelChrome` changes in place. */
export const VOICE_CHROME_PATCH_FIELDS = [
  "passwordProtected",
  "afk",
  "joined",
  "frozenReason",
  "timeoutReason",
  "capacity",
  "mentionCount",
] as const;

function iconSpan(cls: string, icon: IconName): HTMLSpanElement {
  const span = createElement("span", { class: cls });
  span.appendChild(createIcon(icon, 14));
  return span;
}

/**
 * Draw one participant row, without handlers. `speaking` is the last class so
 * the patch's toggle lands where a fresh draw puts it, and a patch keeps any
 * class another module set on the live row (dragMove's `dragging`).
 */
export function drawVoiceUserRow(
  model: VoiceUserRowModel,
  createAvatar: CreateAvatar,
): HTMLDivElement {
  const classes = ["voice-user-item"];
  if (model.draggable) classes.push("voice-user-draggable");
  if (model.speaking) classes.push("speaking");
  const row = createElement("div", {
    class: classes.join(" "),
    "data-voice-uid": String(model.userId),
  });
  // Every row is focusable (A11Y-01): Enter/Space does what a click does.
  row.tabIndex = 0;
  row.setAttribute("role", "button");

  const avatar = createAvatar(
    { username: model.avatarName, avatar: model.avatarUrl },
    { className: "vu-avatar", background: model.avatarColor },
  );
  // The name follows, so the avatar's initial would only repeat it.
  avatar.setAttribute("aria-hidden", "true");
  row.appendChild(avatar);
  row.appendChild(createElement("span", { class: "vu-name" }, model.name));

  if (model.camera) row.appendChild(iconSpan("vu-status", "camera"));
  if (model.live) {
    row.appendChild(iconSpan("vu-status", "monitor"));
    row.appendChild(createElement("span", { class: "vu-live-badge" }, shellText("channel.live")));
  }

  // A moderator-imposed mute/deafen gets its own class and tooltip: the same
  // glyph would otherwise read as an ordinary self-mute.
  if (model.audio !== null) {
    const audio = iconSpan(
      model.audio.server ? "vu-muted vu-server-muted" : "vu-muted",
      model.audio.icon,
    );
    if (model.audio.title !== null) audio.title = model.audio.title;
    row.appendChild(audio);
  }

  if (model.localMuted) {
    const local = iconSpan("vu-muted vu-local-muted", "volume-x");
    local.title = shellText("channel.locallyMuted");
    row.appendChild(local);
  }

  // The local user's own session fingerprint: what a peer who sees
  // us as unverified compares against.
  if (model.ownFingerprintTitle !== null) {
    const own = createElement("span", { class: "vu-verify vu-session-fp" });
    own.style.color = "var(--text-muted, #949ba4)";
    own.title = model.ownFingerprintTitle;
    own.appendChild(createIcon("shield", 14));
    row.appendChild(own);
  }

  // E2EE identity verification badge (F3 TOFU). Absent until the peer's
  // announce resolves.
  if (model.verify !== null) {
    const badge = createElement("span", { class: `vu-verify ${model.verify.cls}` });
    badge.style.color = model.verify.color;
    badge.title = model.verify.title;
    badge.appendChild(createIcon(model.verify.icon, 14));
    // A blocked peer's shield opens the re-trust prompt (bound by the sidebar).
    if (model.verify.cls === "mismatch") badge.style.cursor = "pointer";
    row.appendChild(badge);
  }

  row.style.cursor = "pointer";
  return row;
}

/** Bring a drawn participant row to `next`; only `VOICE_USER_PATCH_FIELDS` differ. */
export function patchVoiceUserRow(el: Element, next: VoiceUserRowModel): void {
  el.classList.toggle("speaking", next.speaking);
}

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
export function drawVoiceChannelChrome(model: VoiceChannelChromeModel): HTMLDivElement {
  const wrapper = createElement("div", {});
  const item = createElement("div", {
    class: chromeClasses(model).join(" "),
    "data-testid": `channel-${model.channelId}`,
    // Roving list item: reachable by Tab once, then arrow-stepped.
    role: "button",
    tabindex: "-1",
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
  if (model.capacity !== null) item.appendChild(drawCapacity(model.channelId, model.capacity));
  if (model.mentionCount > 0) item.appendChild(mentionBadge(model.channelId, model.mentionCount));

  wrapper.appendChild(item);
  if (model.timeoutReason !== null) {
    wrapper.appendChild(drawRestriction(model.channelId, model.timeoutReason));
  }
  return wrapper;
}

/**
 * Bring a drawn wrapper to `next`; only `VOICE_CHROME_PATCH_FIELDS` differ.
 * Classes other modules add to the row (a drop indicator) are kept, and
 * `tabindex` is left to the roving navigation that owns it.
 */
export function patchVoiceChannelChrome(wrapper: Element, next: VoiceChannelChromeModel): void {
  const item = wrapper.querySelector<HTMLElement>(":scope > .channel-item");
  if (item === null) return;

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

  const lockBadge = item.querySelector(":scope > .ch-password");
  if (!next.passwordProtected) {
    lockBadge?.remove();
  } else if (lockBadge === null) {
    const drawn = passwordIndicator(next.channelId);
    // Before the afk, capacity and mention badges, as a fresh draw orders them.
    const later = item.querySelector(
      ":scope > .ch-afk, :scope > .ch-capacity, :scope > .mention-badge",
    );
    if (later === null) item.appendChild(drawn);
    else later.before(drawn);
  }

  const afkBadge = item.querySelector(":scope > .ch-afk");
  if (!next.afk) {
    afkBadge?.remove();
  } else if (afkBadge === null) {
    const drawn = drawAfk(next.channelId);
    // Before the capacity and mention badges, as a fresh draw orders them.
    const later = item.querySelector(":scope > .ch-capacity, :scope > .mention-badge");
    if (later === null) item.appendChild(drawn);
    else later.before(drawn);
  }

  const badge = item.querySelector(":scope > .ch-capacity");
  if (next.capacity === null) {
    badge?.remove();
  } else if (badge === null) {
    // Before the mention badge, which a fresh draw puts last.
    const cap = drawCapacity(next.channelId, next.capacity);
    const mention = item.querySelector(":scope > .mention-badge");
    if (mention === null) item.appendChild(cap);
    else mention.before(cap);
  } else {
    if (badge.textContent !== next.capacity.label) setText(badge, next.capacity.label);
    badge.setAttribute("title", next.capacity.title);
  }

  const mentionEl = item.querySelector<HTMLElement>(":scope > .mention-badge");
  if (next.mentionCount === 0) {
    mentionEl?.remove();
  } else if (mentionEl === null) {
    item.appendChild(mentionBadge(next.channelId, next.mentionCount));
  } else if (mentionEl.textContent !== String(next.mentionCount)) {
    mentionEl.replaceWith(mentionBadge(next.channelId, next.mentionCount));
  }

  // Directly after the row: the participant list, when present, follows it.
  const notice = wrapper.querySelector(":scope > .ch-restriction");
  if (next.timeoutReason === null) {
    notice?.remove();
  } else if (notice === null) {
    item.after(drawRestriction(next.channelId, next.timeoutReason));
  } else if (notice.textContent !== next.timeoutReason) {
    setText(notice, next.timeoutReason);
  }
}
