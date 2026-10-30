/**
 * What the thread surfaces need to decide and to send: who may change
 * a thread, why its composer is closed, and the `thread_*` frames. Loaded with
 * the lazy panel, dialog and popover, never at startup.
 *
 * A thread has no permission state of its own, so "moderator" is read from its
 * parent channel's server verdict (`canDeleteOthers`, which is MANAGE_MESSAGES
 * there), falling back to the role on a server that never said.
 */

import { channelBitOrRole } from "@lib/permissions";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import type { WsClient } from "@lib/ws";
import type { ThreadAutoArchiveMinutes, ThreadInfo, ThreadUpdatePayload } from "@lib/types";
import { threadsText } from "../../i18n/threads";

/** The periods the dialog offers, shortest first; 24 hours is the default. */
export const AUTO_ARCHIVE_CHOICES: readonly ThreadAutoArchiveMinutes[] = [60, 1440, 4320, 10080];
export const DEFAULT_AUTO_ARCHIVE: ThreadAutoArchiveMinutes = 1440;
/** The server's limit on a thread name, in characters. */
export const THREAD_NAME_MAX = 100;

/** Whether the viewer moderates the thread's parent channel. */
export function isThreadModerator(thread: Pick<ThreadInfo, "parent_id">): boolean {
  return channelBitOrRole(channelsStore.getState().channels.get(thread.parent_id)?.canDeleteOthers);
}

/** Rename and archive: the thread's owner or a moderator (a locked thread is the moderator's). */
export function canManageThread(thread: ThreadInfo, userId: number): boolean {
  if (isThreadModerator(thread)) return true;
  return !thread.locked && thread.owner_id !== null && thread.owner_id === userId;
}

/** Why the composer is closed for a locked thread; null when it is open. */
export function threadComposerReason(thread: ThreadInfo): string | null {
  return thread.locked && !isThreadModerator(thread) ? threadsText("composer.locked") : null;
}

/** The name as the server will take it: trimmed, 1..100 characters, or null. */
export function cleanThreadName(raw: string): string | null {
  const name = raw.trim();
  const length = Array.from(name).length;
  return length >= 1 && length <= THREAD_NAME_MAX ? name : null;
}

/** The default name for a thread started on `content`: its first line, cut to fit. */
export function suggestThreadName(content: string): string {
  const line = content.split("\n").find((l) => l.trim() !== "") ?? "";
  return Array.from(line.trim()).slice(0, THREAD_NAME_MAX).join("").trim();
}

/** Whether the socket can take a frame now (a dropped one would be lost silently). */
export function isConnected(): boolean {
  return uiStore.getState().connectionStatus === "connected";
}

type UpdateFields = Omit<ThreadUpdatePayload, "thread_id">;

/** Send a `thread_update`; false when the socket is down. The new state arrives as `thread_changed`. */
export function sendThreadUpdate(ws: WsClient, threadId: number, fields: UpdateFields): boolean {
  if (!isConnected()) return false;
  ws.send({ type: "thread_update", payload: { thread_id: threadId, ...fields } });
  return true;
}

/** Send a `thread_delete` (moderators only); false when the socket is down. */
export function sendThreadDelete(ws: WsClient, threadId: number): boolean {
  if (!isConnected()) return false;
  ws.send({ type: "thread_delete", payload: { thread_id: threadId } });
  return true;
}

/** Send a `thread_follow`; false when the socket is down. The new state arrives as `thread_follow_update`. */
export function sendThreadFollow(ws: WsClient, threadId: number, follow: boolean): boolean {
  if (!isConnected()) return false;
  ws.send({ type: "thread_follow", payload: { thread_id: threadId, follow } });
  return true;
}
