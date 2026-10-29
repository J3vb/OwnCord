/**
 * ThreadPanelHost (WP 6.9c) — owns the side panel's slot: which thread is open,
 * the `thread_focus` frames that say so, and the panel's lazy load.
 *
 * `threadsStore.focusedThreadId` is the single truth for "a panel is open", and
 * the message list's read-marking gates read it. The host writes it on open and
 * close, and follows it when something else clears it (the thread was deleted,
 * or a reconnect found it gone). The panel's own code loads on the first open;
 * a load that finishes after the panel was closed or moved to another thread is
 * dropped by a generation tag, the same idea as the connect generation in
 * lib/ws.ts.
 */

import type { ApiClient } from "@lib/api";
import type { WsClient } from "@lib/ws";
import type { ThreadInfo } from "@lib/types";
import { createLogger } from "@lib/logger";
import { Disposable } from "@lib/disposable";
import {
  adoptThreadSnapshots,
  authorityChannelId,
  getThread,
  setFocusedThread,
  threadsStore,
} from "@stores/threads.store";
import { invalidateChannelMessageWindow } from "@stores/messages.store";
import { channelsStore } from "@stores/channels.store";
import { authStore } from "@stores/auth.store";
import { safetyStore } from "../../features/safety/store";
import type { ThreadPanelComponent } from "@components/ThreadPanel";
import { RateLimiter } from "@lib/rate-limiter";
import { setThreadResume, withThreadsStore } from "@stores/threadsLoader";
import { resumeThreadFocus } from "../../features/messaging/threadResume";
import type { MessageController } from "./MessageController";
import { createReactionController } from "./ReactionController";
import { messagingText } from "../../i18n/messaging";
import { createPaneResize } from "../../features/panes/paneResize";

const log = createLogger("thread-panel-host");

export const THREAD_PANEL_WIDTH_PREF = "threadPanelWidth";
export const THREAD_PANEL_WIDTH_MIN = 320;
export const THREAD_PANEL_WIDTH_MAX = 960;
export const THREAD_PANEL_WIDTH_DEFAULT = 380;
/** What the panel leaves for the rest of the row (sidebar and chat). */
const THREAD_PANEL_ROW_RESERVE = 640;

export interface ThreadPanelHostOptions {
  readonly ws: WsClient;
  readonly api: ApiClient;
  readonly msgCtrl: MessageController;
  /** The element the panel mounts in, beside the chat column. */
  readonly slot: HTMLElement;
  readonly showToast: (msg: string, type: "success" | "error" | "info") => void;
}

export interface ThreadPanelHost {
  /**
   * Open the thread (or focus its composer when it is the one open).
   * `returnFocus` names the element the panel's own Close button hands focus
   * back to (a forum's post row); it is looked up at close time, so a list
   * that repainted in between still has its row found.
   */
  open(thread: ThreadInfo, returnFocus?: () => HTMLElement | null): void;
  /**
   * Open a thread known only by id (the loser of a create race, who is told the
   * winner's id): from the store, else from the parent's thread list. Dropped
   * when `signal` aborts first (the channel was left).
   */
  openById(
    threadId: number,
    parentId: number,
    signal: AbortSignal,
    returnFocus?: () => HTMLElement | null,
  ): void;
  /** Close the panel and tell the server. A no-op when none is open. */
  close(): void;
  /** The thread the panel has open, or null. */
  readonly openThreadId: number | null;
  /** Page teardown: unmount without any frame (the socket is going away). */
  destroy(): void;
}

export function createThreadPanelHost(options: ThreadPanelHostOptions): ThreadPanelHost {
  const { ws, api, msgCtrl, slot, showToast } = options;
  let openId: number | null = null;
  let panel: ThreadPanelComponent | null = null;
  let loadGen = 0;
  let returnFocus: (() => HTMLElement | null) | null = null;
  // Across a reconnect the dispatcher asks us to re-focus the open thread.
  setThreadResume(resumeThreadFocus);
  // The handle on the panel's left edge; the slot carries the width.
  const resize = createPaneResize({
    host: slot,
    property: "--thread-panel-width",
    pref: THREAD_PANEL_WIDTH_PREF,
    min: THREAD_PANEL_WIDTH_MIN,
    max: THREAD_PANEL_WIDTH_MAX,
    initial: THREAD_PANEL_WIDTH_DEFAULT,
    room: () => {
      const row = slot.parentElement?.getBoundingClientRect().width ?? 0;
      return row > 0 ? row - THREAD_PANEL_ROW_RESERVE : 0;
    },
    label: messagingText("thread.resizePanel"),
    className: "thread-panel-resize",
    testId: "thread-panel-resize",
  });
  const owner = new Disposable();
  window.addEventListener(
    "resize",
    () => {
      if (openId !== null) resize.apply();
    },
    { signal: owner.signal },
  );

  /** `thread_focus` is the second subscription slot; null closes it. */
  function sendFocus(threadId: number | null): void {
    ws.send({ type: "thread_focus", payload: { thread_id: threadId } });
  }

  function unmount(): void {
    loadGen++;
    returnFocus = null;
    // The server stops sending this thread's frames once it is unfocused, so
    // what is held goes stale: the next open reloads it.
    if (openId !== null) invalidateChannelMessageWindow(openId);
    panel?.destroy?.();
    panel = null;
    openId = null;
    slot.classList.remove("open");
    slot.parentElement?.classList.remove("thread-open");
    resize.release();
    slot.replaceChildren();
  }

  function close(): void {
    if (openId === null) return;
    unmount();
    setFocusedThread(null);
    sendFocus(null);
  }

  function open(thread: ThreadInfo, back?: () => HTMLElement | null): void {
    if (openId === thread.id) {
      panel?.focusComposer();
      return;
    }
    // A thread deleted under us stays deleted; and what a live frame told us
    // outranks the snapshot the caller holds (a list row, a create ack).
    if (threadsStore.getState().deleted.has(thread.id)) return;
    unmount();
    returnFocus = back ?? null;
    adoptThreadSnapshots([thread]);
    openId = thread.id;
    setFocusedThread(thread.id);
    sendFocus(thread.id);
    slot.classList.add("open");
    slot.parentElement?.classList.add("thread-open");
    slot.appendChild(resize.handle);
    resize.apply();
    const gen = ++loadGen;
    const id = thread.id;
    void import("@components/ThreadPanel").then(
      ({ createThreadPanel }) => {
        if (gen !== loadGen || openId !== id) return;
        const next = createThreadPanel({
          ws,
          api,
          msgCtrl,
          threadId: id,
          reactions: createReactionController({
            ws,
            reactionsLimiter: new RateLimiter(5, 1_000),
            getChannelId: () => id,
            showError: (msg) => showToast(msg, "error"),
          }),
          showToast,
          onClose: () => {
            // The Close button hands focus to the opener (the list row), not
            // to the body its own removal would leave it on.
            const opener = returnFocus;
            close();
            opener?.()?.focus();
          },
        });
        panel = next;
        next.mount(slot);
        next.focusComposer();
      },
      (err: unknown) => {
        log.error("Thread panel failed to load", { error: String(err) });
        if (gen !== loadGen) return;
        close();
        showToast(messagingText("thread.panelLoadFailed"), "error");
      },
    );
  }

  // The store clears the focus when the thread is deleted or gone after a
  // reconnect: take the panel down with it. No frame: the server released it.
  const unsubscribe = threadsStore.subscribeSelector(
    (s) => s.focusedThreadId,
    (focused) => {
      if (focused !== openId && openId !== null && focused === null) {
        // The open thread went away (deleted, or gone after a reconnect): hand
        // focus back to the opener rather than to the body.
        const opener = returnFocus;
        unmount();
        opener?.()?.focus();
      }
    },
  );

  function openById(
    threadId: number,
    parentId: number,
    signal: AbortSignal,
    back?: () => HTMLElement | null,
  ): void {
    // Queued behind the dispatcher's own write of the same frame, so a thread
    // the server just told us about is already in the store.
    withThreadsStore((m) => {
      if (signal.aborted) return;
      const known = m.getThread(threadId);
      if (known !== undefined) {
        open(known, back);
        return;
      }
      // The thread may be open or archived; look through the open ones first.
      const look = (query: string, next: string | null): void => {
        api.listThreads(parentId, `${query}&limit=100`, signal).then(
          (page) => {
            if (signal.aborted) return;
            adoptThreadSnapshots(page.threads);
            const found = getThread(threadId);
            if (found !== undefined) open(found, back);
            else if (next !== null) look(next, null);
          },
          (err: unknown) => log.warn("Thread list fetch failed", { error: String(err) }),
        );
      };
      look("archived=0", "archived=1");
    });
  }

  // The server drops the thread slot silently when a timeout, a role change or
  // a channel override takes the right away. Say it again when the right may be
  // back, so replies resume.
  function refocus(): void {
    if (openId !== null) sendFocus(openId);
  }
  const permissionKey = (): string => {
    const ch = channelsStore.getState().channels.get(authorityChannelId(openId ?? 0));
    return `${ch?.canSend}|${ch?.canDeleteOthers}|${ch?.canReact}|${authStore.getState().user?.role}|${authStore.getState().user?.role_ids?.join(",")}`;
  };
  const unsubscribeRights = [
    safetyStore.subscribeSelector(
      (s) => s.timeout === null,
      (cleared) => {
        if (cleared) refocus();
      },
    ),
    channelsStore.subscribeSelector(() => permissionKey(), refocus),
    authStore.subscribeSelector(() => permissionKey(), refocus),
  ];

  return {
    open,
    openById,
    close,
    get openThreadId() {
      return openId;
    },
    destroy() {
      setThreadResume(null);
      owner.destroy();
      unsubscribe();
      for (const off of unsubscribeRights) off();
      if (openId !== null) setFocusedThread(null);
      unmount();
      resize.destroy();
    },
  };
}
