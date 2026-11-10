/** The self profile card's public shapes and the state its parts share while open. */

import type { Disposable } from "@lib/disposable";
import type { UserStatus } from "@lib/types";

export interface SelfProfileCardOptions {
  /** The button that opens the card; the card anchors above it and hands
   *  focus back to it. */
  readonly trigger: HTMLElement;
  /** Whether a status can be sent right now (socket live, presence sender). */
  readonly canSetStatus: () => boolean;
  /** The authoritative current custom status ("" for none). */
  readonly getCustomStatus: () => string;
  /** When the custom status clears itself (RFC 3339), null for never. The
   *  server only tells the owner; the card never runs its own clearing timer. */
  readonly getCustomStatusExpiresAt: () => string | null;
  /** `durationMs` is set for a timed Idle, Do Not Disturb or Invisible: the
   *  owner saves the status and then the timer that reverts it to Online. */
  readonly onStatusChange: (status: UserStatus, durationMs?: number) => void;
  /** `expiresInSeconds` is the "Clear after" choice (60..604800), left out for
   *  "Don't clear" and for clearing the text. */
  readonly onCustomStatusChange: (text: string, expiresInSeconds?: number) => void;
}

export interface SelfProfileCard {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  /** Close without restoring focus; for the owner's teardown. */
  destroy(): void;
}

/** What one open card's parts share. The card is built per open, so every
 *  field belongs to that open; `isCurrent` is false once it has closed. */
export interface CardSession {
  readonly options: SelfProfileCardOptions;
  readonly disposable: Disposable;
  readonly signal: AbortSignal;
  readonly card: HTMLDivElement;
  readonly close: () => void;
  /** True while this card is the one on screen: a late callback must not act. */
  readonly isCurrent: () => boolean;
  enabled: boolean;
  status: UserStatus;
  lastCommittedCustom: string;
}
