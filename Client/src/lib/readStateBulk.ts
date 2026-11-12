// The paced queue behind "Mark Server as Read": one mark_read per channel, in
// bursts the server's budget honours. Owns the queue and its timer and no
// store; readState.ts resets it with the sender and hands in what it needs.

/** What the queue needs from readState.ts, so it holds no store itself. */
export interface MarkAllDeps {
  /** Mark one channel read now: clears its badge and sends its `mark_read`. */
  readonly markOne: (channelId: number) => void;
  /** Unread plus mention total for a channel or DM; 0 when unknown. */
  readonly unreadTotal: (channelId: number) => number;
}

/**
 * The server's `mark_read` handler has its own 5-per-second-per-user budget,
 * separate from `channel_focus` (Server/ws/handlers_presence.go), and
 * silently drops frames over that budget — no error reaches the client. A
 * burst of `mark_read` sends larger than the budget would still clear every
 * local badge (see `markChannelRead`), so the excess channels' badges would
 * resurrect on the next `ready` once the server re-asserts its own unread
 * counts. Pacing the burst to below the budget keeps every send inside a
 * window the server actually honours.
 */
const MARK_ALL_READ_BURST_SIZE = 4;
const MARK_ALL_READ_BURST_INTERVAL_MS = 1100;

/** Channels still waiting for their `mark_read` frame, each with its
 *  unread+mention total at click time. One queue is shared by every caller of
 *  `markChannelsRead`, so overlapping calls merge instead of dropping each
 *  other's unsent tail. A re-registered sender (new connection) empties it. */
let markQueue: Array<{ readonly id: number; readonly snapshot: number }> = [];
/** When each frame sent inside the current pacing window went out. */
let markSentAt: number[] = [];
let markTimer: ReturnType<typeof setTimeout> | null = null;

export function cancelPendingMarkAll(): void {
  if (markTimer !== null) clearTimeout(markTimer);
  markTimer = null;
  markQueue = [];
  markSentAt = [];
}

/** Send as many queued channels as the window allows, then re-arm for the rest. */
function drainMarkQueue(deps: MarkAllDeps): void {
  markTimer = null;
  const now = Date.now();
  markSentAt = markSentAt.filter((t) => now - t < MARK_ALL_READ_BURST_INTERVAL_MS);
  while (markQueue.length > 0 && markSentAt.length < MARK_ALL_READ_BURST_SIZE) {
    const next = markQueue.shift()!;
    // A message that arrived after the click was never seen: skip its send,
    // and spend no budget on it.
    if (deps.unreadTotal(next.id) > next.snapshot) continue;
    deps.markOne(next.id);
    markSentAt.push(now);
  }
  if (markQueue.length > 0) {
    const wait = Math.max(0, markSentAt[0]! + MARK_ALL_READ_BURST_INTERVAL_MS - now);
    markTimer = setTimeout(() => drainMarkQueue(deps), wait);
  }
}

/** Queue `ids` (those still unread) and send what the pacing window allows. */
export function queueMarkRead(ids: readonly number[], deps: MarkAllDeps): number {
  const queued = new Set(markQueue.map((q) => q.id));
  for (const id of ids) {
    if (queued.has(id)) continue;
    // Already read (an earlier burst got there first): nothing to send.
    const snapshot = deps.unreadTotal(id);
    if (snapshot === 0) continue;
    queued.add(id);
    markQueue.push({ id, snapshot });
  }
  if (markTimer !== null) clearTimeout(markTimer);
  drainMarkQueue(deps);
  return ids.length;
}
