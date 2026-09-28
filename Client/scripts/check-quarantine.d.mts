// Types for the Playwright configs, which import quarantineGrepInvert from the
// .mjs guard module. Kept a declaration file rather than a second
// implementation, so the config and the guard cannot diverge.

export interface QuarantineEntry {
  /** Path relative to Client/, e.g. tests/e2e/native/native-extra.spec.ts. */
  file: string;
  /** The test title, exactly as it appears in the spec. */
  title: string;
  /** Why it is quarantined and what removing the entry waits on. */
  reason: string;
  /** Who owns the follow-up (a lane or a GitHub login). */
  owner: string;
  /** ISO date the entry was added. */
  added: string;
  /** ISO date after which the guard fails until the entry is renewed or removed. */
  expires: string;
}

/** RegExp matching every quarantined test, or undefined for an empty list. */
export function quarantinePattern(entries: readonly QuarantineEntry[]): RegExp | undefined;

/** Playwright `grepInvert` value: the entries, or undefined when OWNCORD_FLAKES=1. */
export function quarantineGrepInvert(env?: { OWNCORD_FLAKES?: string }): RegExp | undefined;
