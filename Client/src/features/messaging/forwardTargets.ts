/**
 * Where a message can be forwarded: the pure half of the Forward
 * picker. It reads the channel, DM and block stores and writes none, so the
 * picker can call it on every store change.
 *
 * A target is a text or announcement channel the viewer can post in, or a DM
 * they can write to. The server refuses anything else, so offering it would
 * only produce a failed row. A source in a labelled (NSFW) channel may go only
 * to another labelled channel the viewer has acknowledged: the server refuses a
 * DM or an unlabelled channel (FORBIDDEN) and withholds an unacknowledged one.
 * A source with files is copied into the target, which needs ATTACH_FILES in a
 * channel (a DM is exempt, as on the server). Archived channels never appear:
 * the server folds archived into `can_send`, so `canSend` already excludes them.
 */

import { Permission } from "@lib/types";
import { hasPermission, permissionsForMemberIn } from "@lib/permissions";
import { authStore } from "@stores/auth.store";
import { channelsStore, type Channel } from "@stores/channels.store";
import { blocksStore, dmComposerBlockReason } from "@stores/blocks.store";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { createElement } from "@lib/dom";
import { createIcon } from "@lib/icons";

/** The picker's cap; the server takes one target per frame, so this only bounds the burst. */
export const MAX_FORWARD_TARGETS = 5;

export interface ForwardTarget {
  readonly id: number;
  readonly name: string;
  readonly kind: "text" | "announcement" | "dm";
  readonly category: string | null;
}

/** Whether the source channel is labelled age-restricted. A DM never is. */
export function isLabelledSource(sourceChannelId: number): boolean {
  return channelsStore.getState().channels.get(sourceChannelId)?.nsfw === true;
}

/** Whether the viewer may attach files: the role's bits, since the client has no
 *  per-channel overrides. Only matters when the source message has files. */
function canAttachFiles(sourceHasFiles: boolean): boolean {
  // The client has the role's bits, not per-channel overrides: this only hides the
  // channels that would certainly refuse; an override the server denies is a failed row.
  const me = authStore.getState().user;
  const role = me?.role;
  const perms =
    role === undefined || role === null
      ? null
      : permissionsForMemberIn(channelsStore.getState().roles, me?.role_ids, role);
  // An unknown role (before `ready`, an older server) hides nothing: the server decides.
  return !sourceHasFiles || perms === null || hasPermission(perms, Permission.ATTACH_FILES);
}

/** The target kind of `ch` when it may be offered, or null. */
function forwardKind(
  ch: Channel,
  labelledOnly: boolean,
  canAttach: boolean,
): "text" | "announcement" | null {
  if (ch.type !== "text" && ch.type !== "announcement") return null;
  if (!ch.canSend || !canAttach) return null;
  // Withheld until acknowledged, so the sender could not even see the result.
  if (ch.nsfw && ch.nsfwAcknowledged !== true) return null;
  if (labelledOnly && !ch.nsfw) return null;
  return ch.type;
}

/** The channels a message can go to, in position order. */
function channelTargets(labelledOnly: boolean, canAttach: boolean): ForwardTarget[] {
  const targets: ForwardTarget[] = [];
  const channels = [...channelsStore.getState().channels.values()].toSorted(
    (a, b) => a.position - b.position,
  );
  for (const ch of channels) {
    const kind = forwardKind(ch, labelledOnly, canAttach);
    if (kind === null) continue;
    targets.push({ id: ch.id, name: ch.name, kind, category: ch.category });
  }
  return targets;
}

/** The DMs the viewer can write to, in list order. */
function dmTargets(): ForwardTarget[] {
  const targets: ForwardTarget[] = [];
  const blocks = blocksStore.getState();
  for (const dm of dmStore.getState().channels) {
    // Block gating is 1:1 only; the server exempts group DMs.
    if (!dm.isGroup && dmComposerBlockReason(blocks, dm.recipient.id) !== null) continue;
    targets.push({ id: dm.channelId, name: dmDisplayName(dm), kind: "dm", category: null });
  }
  return targets;
}

/** Every target the viewer can forward a message from `sourceChannelId` to, in list order. */
export function listForwardTargets(
  sourceChannelId: number,
  sourceHasFiles = false,
): readonly ForwardTarget[] {
  const labelledOnly = isLabelledSource(sourceChannelId);
  const targets = channelTargets(labelledOnly, canAttachFiles(sourceHasFiles));
  if (labelledOnly) return targets;
  return [...targets, ...dmTargets()];
}

/**
 * Narrow `targets` by a typed query: names starting with it first, then names
 * containing it, each tier keeping the list order. An empty query keeps all.
 */
export function filterForwardTargets(
  targets: readonly ForwardTarget[],
  query: string,
): readonly ForwardTarget[] {
  const q = query.trim().toLowerCase();
  if (q === "") return targets;
  const prefix: ForwardTarget[] = [];
  const inner: ForwardTarget[] = [];
  for (const t of targets) {
    const name = t.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(t);
    else if (name.includes(q)) inner.push(t);
  }
  return [...prefix, ...inner];
}

/**
 * The selection after toggling `id`: removed if picked, added if there is room,
 * unchanged at the cap. Returns the same array when nothing changed.
 */
export function toggleForwardTarget(selected: readonly number[], id: number): readonly number[] {
  if (selected.includes(id)) return selected.filter((x) => x !== id);
  return selected.length >= MAX_FORWARD_TARGETS ? selected : [...selected, id];
}

/** Drop picked ids that are no longer offered (a channel lost its SEND bit, a DM closed). */
export function pruneSelection(
  selected: readonly number[],
  targets: readonly ForwardTarget[],
): readonly number[] {
  const offered = new Set(targets.map((t) => t.id));
  const kept = selected.filter((id) => offered.has(id));
  return kept.length === selected.length ? selected : kept;
}

/** A target line's icon, name and (when it has one) category, as the forward and share pickers draw them. */
export function targetRowParts(t: ForwardTarget): HTMLElement[] {
  const icon = createElement("span", { class: "quick-switcher__icon" });
  icon.appendChild(
    createIcon(t.kind === "dm" ? "user" : t.kind === "announcement" ? "megaphone" : "hash", 14),
  );
  const parts = [icon, createElement("span", { class: "quick-switcher__name" }, t.name)];
  if (t.category !== null) {
    parts.push(createElement("span", { class: "quick-switcher__category" }, t.category));
  }
  return parts;
}
