/**
 * Member list layout prefs (3C-6a). Pure helpers over `lib/prefs/preferences`; the
 * right-hand column and the Appearance setting that read them arrive in 3C-6b.
 * Kept eager and tiny: nothing here imports a store or a component.
 */

import { loadPref } from "../../lib/prefs/preferences";

/** Where the member list sits: beside the chat or under the channels. */
export type MemberLayout = "right" | "left";

export const MEMBER_LAYOUT_PREF = "memberListLayout";
export const MEMBER_OPEN_PREF = "memberListOpen";
export const MEMBER_WIDTH_PREF = "memberListWidth";

export const MEMBER_WIDTH_MIN = 200;
export const MEMBER_WIDTH_MAX = 360;
export const MEMBER_WIDTH_DEFAULT = 240;

/** The stored layout. Only a stored `"left"` reads as left; a missing or
 *  invalid value reads as `"right"` (the default since 3C-6c). */
export function loadMemberLayout(): MemberLayout {
  return loadPref<string>(MEMBER_LAYOUT_PREF, "right") === "left" ? "left" : "right";
}

/** Clamp a column width to 200-360 px, rounded; NaN or a non-number gives the
 *  240 px default. */
export function clampMemberWidth(width: number): number {
  if (typeof width !== "number" || Number.isNaN(width)) return MEMBER_WIDTH_DEFAULT;
  return Math.round(Math.min(MEMBER_WIDTH_MAX, Math.max(MEMBER_WIDTH_MIN, width)));
}
