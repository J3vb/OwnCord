/**
 * The tray's presence picker. Added in B7-5: the tray menu emits the chosen
 * status from the native host and `main.ts` applies it. The payload is
 * handed over unvalidated, exactly as the native host sent it — checking it
 * and mapping the tray's legacy "offline" to "invisible" is behaviour, and
 * stays in `main.ts`.
 *
 * Deliberately one named subscription, shaped like `SocketConnection`'s,
 * not a general by-name event bus: a bus through the seam would let any
 * caller reach any native event.
 */
export interface TrayStatus {
  /** Subscribe to status picks from the tray. Returns the unsubscribe. */
  onStatusChange(handler: (status: string) => void): () => void;
}
