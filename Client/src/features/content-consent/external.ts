/**
 * External-content consent (B9-8, Q3): nothing a message author links to is
 * fetched from this machine until the viewer has agreed to it on this server.
 *
 * One choice per server profile, kept with the client preferences: "auto"
 * loads every preview and image on that server; "ask" loads an item only when
 * the viewer activates it. No choice yet means every item stays concealed,
 * and activating one asks for the choice first. Rendering, hover, focus and
 * observers never admit anything.
 *
 * The admission check sits in front of every broker call (attachments.ts), so
 * a render path that forgot to ask still fetches nothing. This grant is
 * separate from NSFW consent (./nsfw.ts) and Message Request trust: neither
 * reads it, and it satisfies neither.
 */

import { loadPref, savePref } from "@lib/preferences";

export type ExternalConsentChoice = "auto" | "ask";

/** The preference key; its value maps a server host to its choice. */
export const EXTERNAL_CONSENT_PREF = "externalContentConsent";

/** Admission key for the GIF picker, which is one item as a whole. */
export const GIF_PICKER_ITEM = "gif-picker";

let scope = "";
/** Items admitted one by one this session ("ask"), keyed like the broker
 *  cache: `url:<url>`, `handle:<handle>` or a named item. */
const admitted = new Set<string>();
/** Bumped whenever the admitted items are forgotten, so a dialog answered
 *  after a teardown, server switch or reset admits and records nothing. */
let generation = 0;

function forget(): void {
  admitted.clear();
  generation++;
}

function choices(): Record<string, unknown> {
  return loadPref<Record<string, unknown>>(EXTERNAL_CONSENT_PREF, {});
}

/** Point the consent at the server now being shown (its normalised host). */
export function setExternalConsentScope(host: string): void {
  if (host === scope) return;
  scope = host;
  forget();
}

/** This server's choice, or null when the viewer has not made one. */
export function externalConsentChoice(): ExternalConsentChoice | null {
  const all = choices();
  const choice = Object.hasOwn(all, scope) ? all[scope] : null;
  return choice === "auto" || choice === "ask" ? choice : null;
}

export function setExternalConsentChoice(choice: ExternalConsentChoice): void {
  savePref(EXTERNAL_CONSENT_PREF, { ...choices(), [scope]: choice });
}

/** Forget every server's choice and every admitted item. */
export function resetExternalConsent(): void {
  forget();
  savePref(EXTERNAL_CONSENT_PREF, {});
}

/** Forget items admitted one by one (a page teardown). */
export function forgetAdmittedItems(): void {
  forget();
}

/** Whether `key` may be fetched: the server is on "auto", or the viewer
 *  activated this item. */
export function externalAllowed(key: string): boolean {
  return externalConsentChoice() === "auto" || admitted.has(key);
}

/** Admit `child` (a fetch an admitted item needs, such as its thumbnail or
 *  preview image) — only when `parent` is itself allowed. */
export function admitDerived(parent: string, child: string): void {
  if (externalAllowed(parent)) admitted.add(child);
}

/** The viewer activated `key`: ask for this server's choice first if there
 *  is none. Resolves whether the item is now admitted. */
export async function requestExternalItem(key: string): Promise<boolean> {
  if (externalConsentChoice() === null) {
    const asked = generation;
    const { askExternalConsent } = await import("./externalDialog");
    const choice = await askExternalConsent();
    if (choice === null || asked !== generation) return false;
    admitted.add(key);
    setExternalConsentChoice(choice);
    return true;
  }
  admitted.add(key);
  return true;
}
