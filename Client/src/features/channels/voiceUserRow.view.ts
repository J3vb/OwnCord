/**
 * What a voice participant's row draws, from a plain-data model and nothing
 * else: the resolved name, each tooltip with its fingerprint or safety number
 * already in it, a boolean per icon. `reconcileModels` derives a row's
 * signature from its model, so the row cannot draw a value its model does not
 * carry. This module imports no store and binds no handler; `voiceRowModel.ts`
 * builds the models and the sidebar binds the handlers.
 *
 * The DOM is the one `ChannelSidebar.ts`'s `renderVoiceChannelItem` drew
 * before the row models were split out, class for class and attribute for
 * attribute: sidebar.css, the sidebar unit suite and the voice e2e specs select
 * on it. The channel row is `voiceRow.view.ts`, which re-exports this module.
 */

import { createElement } from "../../lib/dom";
import { createIcon, type IconName } from "../../lib/icons";
import { shellText } from "../../i18n/shell";
import type { createAvatarElement } from "../profiles/avatar";
import { treeItemAttrs } from "./channelRow.view";

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

/** A tree row's second line: what the person plays or listens to. `text` is
 *  already worded ("Playing Hades II", "Listening to Spotify"). A type alias,
 *  not an interface, so a model holding it still satisfies `RowModel`. */
export type VoiceActivityModel = {
  readonly text: string;
  readonly icon: IconName;
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
  /** Shares music: a music note beside the name. Absent reads as false. */
  readonly music?: boolean;
  /** Mute music is on for a member who shares: the note is dimmed. */
  readonly musicMuted?: boolean;
  /** The Listen pill after the note: "on" while you listen to this member
   *  (drawn as Listening). Absent draws none. */
  readonly listen?: "off" | "on";
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
  /** The second line of a tree row; set only in tree mode, null or absent
   *  when the person has no game or song. Not a patch field: a change
   *  rebuilds the row. */
  readonly activity?: VoiceActivityModel | null;
};

/** The fields `patchVoiceUserRow` changes in place. */
export const VOICE_USER_PATCH_FIELDS = ["speaking"] as const;

function iconSpan(cls: string, icon: IconName): HTMLSpanElement {
  const span = createElement("span", { class: cls });
  span.appendChild(createIcon(icon, 14));
  return span;
}

/** The note beside a member who shares music, dimmed while you muted it. */
function musicNote(muted: boolean): HTMLElement {
  const note = iconSpan("vu-status vu-music", "music");
  note.title = shellText(muted ? "channel.sharingMusicMuted" : "channel.sharingMusic");
  note.classList.toggle("vu-music--muted", muted);
  return note;
}

/** The pill that starts or stops listening to a member's music. */
function listenPill(model: VoiceUserRowModel, tree: boolean): HTMLElement {
  const on = model.listen === "on";
  const pill = createElement("button", {
    type: "button",
    class: on ? "vu-listen vu-listen--on" : "vu-listen",
    "aria-pressed": String(on),
    "aria-label": shellText(on ? "channel.stopListeningTo" : "channel.listenTo", {
      name: model.name,
    }),
    "data-testid": `voice-listen-${model.userId}`,
  });
  // One Tab stop for the tree: the row's menu is the keyboard route to Listen.
  if (tree) pill.tabIndex = -1;
  pill.appendChild(createIcon(on ? "audio-lines" : "headphones", 12));
  pill.appendChild(
    createElement("span", {}, shellText(on ? "channel.listening" : "channel.listen")),
  );
  return pill;
}

/** The note beside a sharer, and the Listen pill after it. */
function appendMusic(row: HTMLElement, model: VoiceUserRowModel, tree: boolean): void {
  if (model.music === true) row.appendChild(musicNote(model.musicMuted === true));
  if (model.listen !== undefined) row.appendChild(listenPill(model, tree));
}

/** The camera and screen icons, and the per-person LIVE tag (a tree hides it: the channel row shows LIVE). */
function appendMediaIcons(row: HTMLElement, model: VoiceUserRowModel): void {
  if (model.camera) row.appendChild(iconSpan("vu-status", "camera"));
  if (model.live) {
    row.appendChild(iconSpan("vu-status", "monitor"));
    row.appendChild(createElement("span", { class: "vu-live-badge" }, shellText("channel.live")));
  }
}

/** The mute or deafen icon, and the one for a member muted for this client only. */
function appendMuteIcons(row: HTMLElement, model: VoiceUserRowModel): void {
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
}

/** The E2EE badges: your own session fingerprint, or a peer's identity verification. */
function appendVerifyBadges(row: HTMLElement, model: VoiceUserRowModel): void {
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
    // A blocked peer's shield opens the re-trust prompt, any other with an
    // identity key their trusted keys (both bound by the sidebar).
    if (
      model.verify.cls === "mismatch" ||
      model.verify.cls === "verified" ||
      model.verify.cls === "changed"
    ) {
      badge.style.cursor = "pointer";
    }
    row.appendChild(badge);
  }
}

/**
 * Draw one participant row, without handlers. `speaking` is the last class so
 * the patch's toggle lands where a fresh draw puts it, and a patch keeps any
 * class another module set on the live row (dragMove's `dragging`). In a tree
 * the row is a child item and your own name carries `vu-self`.
 */
export function drawVoiceUserRow(
  model: VoiceUserRowModel,
  createAvatar: CreateAvatar,
  tree = false,
): HTMLDivElement {
  const classes = ["voice-user-item"];
  if (model.draggable) classes.push("voice-user-draggable");
  if (model.speaking) classes.push("speaking");
  const row = createElement("div", {
    class: classes.join(" "),
    "data-voice-uid": String(model.userId),
  });
  // Every row is focusable (A11Y-01): Enter/Space does what a click does. In a
  // tree it is a child item, and the tree keys promote the one Tab stop.
  if (tree) {
    for (const [attr, value] of Object.entries(treeItemAttrs("child")))
      row.setAttribute(attr, value);
  } else {
    row.tabIndex = 0;
    row.setAttribute("role", "button");
  }

  const avatar = createAvatar(
    { username: model.avatarName, avatar: model.avatarUrl },
    { className: "vu-avatar", background: model.avatarColor },
  );
  // The name follows, so the avatar's initial would only repeat it.
  avatar.setAttribute("aria-hidden", "true");
  row.appendChild(avatar);
  // Your own name is the one the tree colours (no "(you)" text is added).
  const nameClass = tree && model.self ? "vu-name vu-self" : "vu-name";
  row.appendChild(nameWithActivity(model, nameClass));

  appendMusic(row, model, tree);
  appendMediaIcons(row, model);
  appendMuteIcons(row, model);
  appendVerifyBadges(row, model);

  row.style.cursor = "pointer";
  return row;
}

/** The name and, under it, what the person is doing: `.vu-text` holds both so
 *  the second line indents to the name and truncates before it does. */
function nameWithActivity(model: VoiceUserRowModel, nameClass: string): HTMLElement {
  const name = createElement("span", { class: nameClass }, model.name);
  if (model.activity == null) return name;
  const line = createElement("span", {
    class: "vu-activity",
    "data-testid": `voice-activity-${model.userId}`,
  });
  const icon = createIcon(model.activity.icon, 12);
  icon.setAttribute("aria-hidden", "true");
  line.appendChild(icon);
  line.appendChild(
    createElement(
      "span",
      { class: "vu-activity-text", title: model.activity.text },
      model.activity.text,
    ),
  );
  const text = createElement("span", { class: "vu-text" });
  text.appendChild(name);
  text.appendChild(line);
  return text;
}

/** Bring a drawn participant row to `next`; only `VOICE_USER_PATCH_FIELDS` differ. */
export function patchVoiceUserRow(el: Element, next: VoiceUserRowModel): void {
  el.classList.toggle("speaking", next.speaking);
}
