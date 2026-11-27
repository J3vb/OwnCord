/**
 * The phone layout's gate: a touch screen that is narrow (a phone upright) or
 * short (a phone on its side, which is wider than a tablet in portrait but
 * has no room to spare). The CSS phone media queries repeat this text and
 * `tests/unit/phone-query-css.test.ts` fails when one of them differs, so
 * change both together.
 */
export const PHONE_LAYOUT_QUERY =
  "(pointer: coarse) and (max-width: 899px), (pointer: coarse) and (max-height: 499px)";

export function isPhoneLayout(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(PHONE_LAYOUT_QUERY).matches;
}
