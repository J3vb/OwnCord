/**
 * The channel header's thread list: a popover under the Threads
 * button listing the channel's open threads, newest activity first, then its
 * archived ones. Each list is paged with the server's opaque `next_before`
 * cursor, one page per "Load more".
 *
 * Every page is also written to threadsStore, so a thread opened from here (or
 * later, from its chip) is known. A page that lands after the popover closed,
 * or after a newer request for the same list started, is dropped. Loaded on
 * first use, never at startup.
 */

import { isImeCommit } from "@lib/text/ime";
import { createElement } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createIcon } from "@lib/icons";
import type { ApiClient } from "@lib/api";
import { errorText } from "@lib/api";
import type { ThreadInfo } from "@lib/types";
import { adoptThreadSnapshots } from "@stores/threads.store";
import { createArchiveIcon, threadAgoLabel, threadCountLabel } from "./message-list/threadChip";
import { threadsText } from "../i18n/threads";

const PAGE_SIZE = 25;

export interface ThreadListPopoverOptions {
  readonly api: ApiClient;
  readonly channelId: number;
  /** The Threads button: the popover sits under it and focus returns to it. */
  readonly anchor: HTMLButtonElement;
  /** The channel's lifetime: leaving it closes the popover. */
  readonly signal: AbortSignal;
  readonly onOpenThread: (thread: ThreadInfo) => void;
  /** Runs once when the popover goes away, by any path. */
  readonly onClosed: () => void;
}

export interface ThreadListPopover {
  close(): void;
}

type Phase = "active" | "archived";

export function openThreadListPopover(options: ThreadListPopoverOptions): ThreadListPopover {
  const { api, channelId, anchor, onOpenThread } = options;
  const owner = new Disposable();
  const onParentAbort = (): void => close();
  options.signal.addEventListener("abort", onParentAbort, { once: true });

  const root = createElement("div", {
    class: "thread-popover",
    role: "dialog",
    "aria-label": threadsText("list.title"),
    "data-testid": "thread-popover",
  });
  const body = createElement("div", { class: "thread-popover-body" });
  const activeList = createElement("ul", {
    class: "thread-popover-list",
    "data-testid": "thread-list-active",
  });
  const archivedHead = createElement(
    "div",
    { class: "thread-popover-head" },
    threadsText("list.archived"),
  );
  archivedHead.hidden = true;
  const archivedList = createElement("ul", {
    class: "thread-popover-list",
    "data-testid": "thread-list-archived",
  });
  const emptyEl = createElement("div", {
    class: "thread-popover-empty",
    "data-testid": "thread-list-empty",
  });
  emptyEl.hidden = true;
  const statusEl = createElement("div", { class: "thread-popover-status", role: "status" });
  const moreBtn = createElement("button", {
    type: "button",
    class: "thread-popover-more",
    "data-testid": "thread-list-more",
  });
  moreBtn.hidden = true;
  body.append(
    createElement("div", { class: "thread-popover-head" }, threadsText("list.active")),
    activeList,
    archivedHead,
    archivedList,
    emptyEl,
    statusEl,
    moreBtn,
  );
  root.appendChild(body);

  let phase: Phase = "active";
  let cursor = "";
  let hasMore = true;
  let archivedShown = false;
  let loading = false;
  let failed = false;
  /** Bumped by every request, so only the newest answer is applied. */
  let requestGen = 0;
  let closed = false;

  function renderItem(thread: ThreadInfo): HTMLLIElement {
    const li = createElement("li", { class: "thread-popover-item" });
    const btn = createElement("button", {
      type: "button",
      class: "thread-popover-open",
      "data-testid": `thread-list-item-${thread.id}`,
    });
    btn.appendChild(thread.archived ? createArchiveIcon(14) : createIcon("message-square", 14));
    btn.appendChild(createElement("span", { class: "thread-popover-name" }, thread.name));
    btn.appendChild(
      createElement(
        "span",
        { class: "thread-popover-meta" },
        `${threadCountLabel(thread.message_count)} · ${threadAgoLabel(thread.last_message_at ?? thread.created_at)}`,
      ),
    );
    btn.addEventListener(
      "click",
      () => {
        close();
        onOpenThread(thread);
      },
      { signal: owner.signal },
    );
    li.appendChild(btn);
    return li;
  }

  function paintFooter(): void {
    const noneShown = activeList.childElementCount === 0 && archivedList.childElementCount === 0;
    const exhausted = phase === "archived" && archivedShown && !hasMore;
    emptyEl.hidden = !(exhausted && !loading && !failed && noneShown);
    emptyEl.textContent = threadsText("list.empty");
    statusEl.textContent = loading
      ? threadsText("list.loading")
      : failed
        ? threadsText("list.failed")
        : "";
    // Past the open threads the next page is the first of the archived ones.
    const label = failed
      ? threadsText("list.retry")
      : phase === "archived" && !archivedShown
        ? threadsText("list.showArchived")
        : threadsText("list.loadMore");
    moreBtn.textContent = label;
    moreBtn.hidden = loading || (exhausted && !failed);
    archivedHead.hidden = archivedList.childElementCount === 0;
  }

  async function loadNext(): Promise<void> {
    if (loading || closed) return;
    loading = true;
    failed = false;
    const gen = ++requestGen;
    const requestPhase = phase;
    paintFooter();
    try {
      const query = new URLSearchParams({
        archived: requestPhase === "archived" ? "1" : "0",
        limit: String(PAGE_SIZE),
      });
      if (cursor !== "") query.set("before", cursor);
      const page = await api.listThreads(channelId, query.toString(), owner.signal);
      if (closed || gen !== requestGen) return;
      adoptThreadSnapshots(page.threads);
      const list = requestPhase === "archived" ? archivedList : activeList;
      for (const thread of page.threads) list.appendChild(renderItem(thread));
      if (requestPhase === "archived") archivedShown = true;
      cursor = page.next_before;
      hasMore = page.has_more;
      if (requestPhase === "active" && !page.has_more) {
        phase = "archived";
        cursor = "";
        hasMore = true;
      }
    } catch (err) {
      if (closed || gen !== requestGen) return;
      failed = true;
      statusEl.title = errorText(err, "");
    } finally {
      if (gen === requestGen) {
        loading = false;
        paintFooter();
      }
    }
  }

  moreBtn.addEventListener("click", () => void loadNext(), { signal: owner.signal });

  function place(): void {
    const rect = anchor.getBoundingClientRect();
    root.style.top = `${Math.round(rect.bottom + 6)}px`;
    root.style.right = `${Math.max(8, Math.round(window.innerWidth - rect.right))}px`;
  }

  function close(): void {
    if (closed) return;
    closed = true;
    options.signal.removeEventListener("abort", onParentAbort);
    owner.destroy();
    root.remove();
    anchor.setAttribute("aria-expanded", "false");
    if (document.contains(anchor)) anchor.focus();
    options.onClosed();
  }

  document.body.appendChild(root);
  place();
  anchor.setAttribute("aria-expanded", "true");
  document.addEventListener(
    "mousedown",
    (e) => {
      if (e.target instanceof Node && !root.contains(e.target) && !anchor.contains(e.target)) {
        close();
      }
    },
    { signal: owner.signal },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && !isImeCommit(e)) {
        e.stopPropagation();
        close();
      }
    },
    { signal: owner.signal, capture: true },
  );
  window.addEventListener("resize", place, { signal: owner.signal });
  void loadNext().then(() => {
    // An empty open list leads straight into the archived ones.
    if (!closed && phase === "archived" && !archivedShown && activeList.childElementCount === 0) {
      void loadNext();
    }
  });

  return { close };
}
