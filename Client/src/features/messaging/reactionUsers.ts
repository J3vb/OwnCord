/**
 * The who-reacted reactor-list cache and its transport hook.
 *
 * The reactor list is not part of the message payload (a page of chat carries
 * dozens of pills and almost none are ever hovered), so it is fetched on demand
 * from GET /channels/{id}/messages/{messageId}/reactions/{emoji}/users and
 * cached per message+emoji. The cache is invalidated by `reaction_update` for
 * that message, which is the only event that can change the answer.
 *
 * This lives below the UI layer so `features/messaging/wsHandlers.ts` can
 * invalidate the cache on `reaction_update` without importing the tooltip
 * component that renders it (ARCH-06). The tooltip reads the cache and registers
 * the live ApiClient fetcher.
 */

import { createLogger } from "@lib/logger";
import type { ReactionUser } from "@lib/types";

const log = createLogger("reaction-tooltip");

export type ReactionUsersFetcher = (
  channelId: number,
  messageId: number,
  emoji: string,
) => Promise<readonly ReactionUser[]>;

let fetcher: ReactionUsersFetcher | null = null;

/**
 * Register the transport used to fetch reactor lists. Called once from
 * MainPage with the live ApiClient, the same way setServerHost is. Until it is
 * set, hovering a pill is a no-op rather than an error — the renderer is used
 * by tests and previews that have no server.
 */
export function setReactionUsersFetcher(next: ReactionUsersFetcher | null): void {
  fetcher = next;
}

/** NUL separator: the server rejects control characters in an emoji, so no
 *  emoji can contain it and no two (message, emoji) pairs can collide. */
function cacheKey(messageId: number, emoji: string): string {
  return `${messageId}\u0000${emoji}`;
}

/** Resolved reactor lists, keyed by message+emoji. */
const cache = new Map<string, readonly ReactionUser[]>();
/** In-flight requests, so a re-hover during the fetch does not duplicate it. */
const inFlight = new Map<string, Promise<readonly ReactionUser[] | null>>();

/**
 * Drop every cached reactor list for a message. Called from the `reaction_update`
 * dispatch: any add/remove on that message makes all of its lists stale, and
 * the event carries only the one emoji that changed, so scoping the eviction to
 * that emoji would leave the others silently wrong after a race.
 */
export function invalidateReactionUsers(messageId: number): void {
  // Deleting the key currently being visited is well-defined for a Map
  // iterator, so no snapshot of the key set is needed.
  const prefix = `${messageId}\u0000`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  for (const key of inFlight.keys()) {
    if (key.startsWith(prefix)) inFlight.delete(key);
  }
}

/** Drop every cached reactor list (channel switch, logout, reconnect). */
export function clearReactionUsersCache(): void {
  cache.clear();
  inFlight.clear();
}

/** Cached reactor list for a message+emoji, or undefined when not fetched. */
export function getCachedReactionUsers(
  messageId: number,
  emoji: string,
): readonly ReactionUser[] | undefined {
  return cache.get(cacheKey(messageId, emoji));
}

/**
 * Reactor list for a message+emoji, from cache when present. Returns null when
 * there is no fetcher registered or the request failed — callers show nothing
 * rather than an error, since this is a hover affordance.
 */
export function loadReactionUsers(
  channelId: number,
  messageId: number,
  emoji: string,
): Promise<readonly ReactionUser[] | null> {
  const key = cacheKey(messageId, emoji);

  const cached = cache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);

  const existing = inFlight.get(key);
  if (existing !== undefined) return existing;

  const activeFetcher = fetcher;
  if (activeFetcher === null) return Promise.resolve(null);

  const promise = activeFetcher(channelId, messageId, emoji).then(
    (users) => {
      // A concurrent invalidation dropped this key: the response describes a
      // state that has already changed, so it must not repopulate the cache.
      if (inFlight.get(key) === promise) {
        cache.set(key, users);
      }
      return users;
    },
    (err: unknown) => {
      log.warn("failed to load reaction users", {
        messageId,
        emoji,
        error: String(err),
      });
      return null;
    },
  );

  inFlight.set(key, promise);
  void promise.finally(() => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key);
    }
  });

  return promise;
}
