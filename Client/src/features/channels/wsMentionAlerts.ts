// Mention alert timing for the channel handlers: a mention_count rise waits a
// moment for a channel_activity entry that carries the mention. Owns the
// pending alerts, their session reset, and nothing that subscribes to the socket.
import { notifyMention, type ThreadNotifyContext } from "../../lib/notifications";
import { loadedThreadsStore } from "../../stores/threadsLoader";
import { registerSessionReset } from "../../lib/net/sessionRegistry";

/** Who an alert for `id` is for when `id` is a followed thread: its parent, name and whether it is open. */
export function threadNotifyContext(id: number): ThreadNotifyContext | undefined {
  const m = loadedThreadsStore();
  const t = m?.getThread(id);
  if (m === null || t === undefined) return undefined;
  return {
    parentId: t.parent_id,
    name: t.name,
    watching: m.threadsStore.getState().focusedThreadId === id,
  };
}

/**
 * How long a mention_count alert waits for a channel_activity entry that
 * carries the mention, and how long a mention entry that came first waits for
 * its rise. The server flushes activity on a 1 s window and
 * resolves a flush within 2 s.
 */
export const MENTION_ALERT_GRACE_MS = 3000;

/** A channel's mention_count rises still waiting for an activity entry. */
interface PendingMentionAlert {
  readonly timer: ReturnType<typeof setTimeout>;
  /** Rises not yet matched by a mention entry. */
  owed: number;
}

const pendingMentionAlerts = new Map<number, PendingMentionAlert>();
/** Mention entries that arrived before their rise, with when, by channel. */
const activityCredits = new Map<number, number[]>();

/** Unexpired credits for `channelId`, oldest first. */
function liveCredits(channelId: number): number[] {
  const now = Date.now();
  const live = (activityCredits.get(channelId) ?? []).filter(
    (at) => now - at < MENTION_ALERT_GRACE_MS,
  );
  if (live.length === 0) activityCredits.delete(channelId);
  else activityCredits.set(channelId, live);
  return live;
}

/**
 * Alert for `rises` mention_count rises unless channel_activity announces
 * them. Each mention entry matches one rise, before or after it, so a second
 * mention whose entry never came (the server keeps only a window's newest
 * mentions, a dropped frame, a server without the frame) still alerts, one
 * grace window late.
 */
export function deferMentionAlert(channelId: number, rises: number): void {
  const credits = liveCredits(channelId);
  const used = Math.min(credits.length, rises);
  if (used > 0) {
    credits.splice(0, used);
    if (credits.length === 0) activityCredits.delete(channelId);
  }
  const owed = rises - used;
  if (owed === 0) return;
  const pending = pendingMentionAlerts.get(channelId);
  if (pending !== undefined) {
    pending.owed += owed;
    return;
  }
  pendingMentionAlerts.set(channelId, {
    owed,
    timer: setTimeout(() => {
      pendingMentionAlerts.delete(channelId);
      const thread = threadNotifyContext(channelId);
      if (thread === undefined) notifyMention(channelId);
      else notifyMention(channelId, thread);
    }, MENTION_ALERT_GRACE_MS),
  });
}

/** Take back `count` rises a lowered total reversed (a delete or purge). */
export function withdrawMentionAlert(channelId: number, count: number): void {
  const pending = pendingMentionAlerts.get(channelId);
  if (pending === undefined) return;
  pending.owed -= count;
  if (pending.owed <= 0) {
    clearTimeout(pending.timer);
    pendingMentionAlerts.delete(channelId);
  }
}

/** A mention entry alerted: it answers one pending rise, or one still to come. */
export function matchMentionEntry(channelId: number): void {
  const pending = pendingMentionAlerts.get(channelId);
  if (pending === undefined) {
    activityCredits.set(channelId, [...liveCredits(channelId), Date.now()]);
    return;
  }
  pending.owed--;
  if (pending.owed <= 0) {
    clearTimeout(pending.timer);
    pendingMentionAlerts.delete(channelId);
  }
}

/** Drop pending mention alerts and what they were matched against. Run when
 *  the dispatcher is torn down. */
export function resetChannelActivity(): void {
  for (const pending of pendingMentionAlerts.values()) clearTimeout(pending.timer);
  pendingMentionAlerts.clear();
  activityCredits.clear();
}
// Mention alerts are keyed by this server's channel ids and fire on a timer;
// a server switch must not let one fire for the next server.
void registerSessionReset("channels:activity", resetChannelActivity, { phase: "cache" }); // app-lifetime
