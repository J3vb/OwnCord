/**
 * No-seam: `nativePersistence` (`lib/pendingMessages.ts`) is a private
 * module-level object, not an exported function — there is nothing to bind a
 * legacy suite against yet. The suite lands with the seam in B7-4.
 *
 * Member for member the same shape as `PendingMessagePersistence`
 * (`lib/pendingMessages.ts`) — rule 4: B7-4 deletes that local interface and
 * imports this one instead.
 */

/** Re-declared, structurally identical to `PendingMessageOwner`
 *  (`lib/pendingMessages.ts`). */
export interface PendingMessageOwner {
  readonly host: string;
  readonly userId: number;
}

export interface PendingMessageStore {
  load(owner: PendingMessageOwner): Promise<string | null>;
  save(owner: PendingMessageOwner, value: string): Promise<void>;
  delete(owner: PendingMessageOwner): Promise<void>;
}
