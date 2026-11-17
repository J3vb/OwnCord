/**
 * The channel's thread list, in the channel side panel the Threads button
 * opens: its open threads, newest activity first, then its archived ones.
 * Each list is paged with the server's opaque `next_before` cursor, one page
 * per "Load more".
 *
 * Every page is also written to threadsStore, so a thread opened from here (or
 * later, from its chip) is known. A page that lands after the list closed,
 * or after a newer request for the same list started, is dropped. Loaded on
 * first use, never at startup.
 */

import { createElement } from "@lib/dom";
import { Disposable } from "@lib/disposable";
import { createIcon } from "@lib/icons";
import type { MountableComponent } from "@lib/text/safeRender";
import { createSidePanelFrame } from "@lib/ui/sidePanelFrame";
import type { ApiClient } from "@lib/api";
import { errorText } from "@lib/api";
import type { ThreadInfo } from "@lib/types";
import { adoptThreadSnapshots } from "@stores/threads.store";
import {
  createArchiveIcon,
  threadAgoLabel,
  threadCountLabel,
} from "../messaging/message-list/threadChip";
import { threadsText } from "../../i18n/threads";

const PAGE_SIZE = 25;

export interface ThreadListOptions {
  readonly api: ApiClient;
  readonly channelId: number;
  readonly onOpenThread: (thread: ThreadInfo) => void;
  readonly onClose: () => void;
}

type Phase = "active" | "archived";

type ThreadListPage = Awaited<ReturnType<ApiClient["listThreads"]>>;

function threadPageQuery(phase: Phase, cursor: string): string {
  const query = new URLSearchParams({
    archived: phase === "archived" ? "1" : "0",
    limit: String(PAGE_SIZE),
  });
  if (cursor !== "") query.set("before", cursor);
  return query.toString();
}

export function createThreadList(options: ThreadListOptions): MountableComponent {
  const { api, channelId, onOpenThread } = options;
  const owner = new Disposable();

  const frame = createSidePanelFrame({
    className: "thread-list-panel",
    label: threadsText("list.title"),
    title: threadsText("list.title"),
    icon: "message-square",
    closeLabel: threadsText("list.close"),
    testId: "thread-list-panel",
    onClose: () => options.onClose(),
    signal: owner.signal,
  });
  const body = createElement("div", { class: "thread-list-body" });
  const activeList = createElement("ul", {
    class: "thread-list-list",
    "data-testid": "thread-list-active",
  });
  const archivedHead = createElement(
    "div",
    { class: "thread-list-head" },
    threadsText("list.archived"),
  );
  archivedHead.hidden = true;
  const archivedList = createElement("ul", {
    class: "thread-list-list",
    "data-testid": "thread-list-archived",
  });
  const emptyEl = createElement("div", {
    class: "thread-list-empty",
    "data-testid": "thread-list-empty",
  });
  emptyEl.hidden = true;
  const statusEl = createElement("div", { class: "thread-list-status", role: "status" });
  const moreBtn = createElement("button", {
    type: "button",
    class: "thread-list-more",
    "data-testid": "thread-list-more",
  });
  moreBtn.hidden = true;
  body.append(
    createElement("div", { class: "thread-list-head" }, threadsText("list.active")),
    activeList,
    archivedHead,
    archivedList,
    emptyEl,
    statusEl,
    moreBtn,
  );
  frame.body.appendChild(body);

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
    const li = createElement("li", { class: "thread-list-item" });
    const btn = createElement("button", {
      type: "button",
      class: "thread-list-open",
      "data-testid": `thread-list-item-${thread.id}`,
    });
    btn.appendChild(thread.archived ? createArchiveIcon(14) : createIcon("message-square", 14));
    btn.appendChild(createElement("span", { class: "thread-list-name" }, thread.name));
    btn.appendChild(
      createElement(
        "span",
        { class: "thread-list-meta" },
        `${threadCountLabel(thread.message_count)} · ${threadAgoLabel(thread.last_message_at ?? thread.created_at)}`,
      ),
    );
    btn.addEventListener("click", () => onOpenThread(thread), { signal: owner.signal });
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

  /** Fold one answered page into the lists and the paging cursor. */
  function applyPage(page: ThreadListPage, requestPhase: Phase): void {
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
  }

  async function loadNext(): Promise<void> {
    if (loading || closed) return;
    loading = true;
    failed = false;
    const gen = ++requestGen;
    const requestPhase = phase;
    paintFooter();
    try {
      const page = await api.listThreads(
        channelId,
        threadPageQuery(requestPhase, cursor),
        owner.signal,
      );
      if (closed || gen !== requestGen) return;
      applyPage(page, requestPhase);
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

  function destroy(): void {
    if (closed) return;
    closed = true;
    owner.destroy();
    frame.root.remove();
  }

  function mount(container: Element): void {
    container.appendChild(frame.root);
    void loadNext().then(() => {
      // An empty open list leads straight into the archived ones.
      if (!closed && phase === "archived" && !archivedShown && activeList.childElementCount === 0) {
        void loadNext();
      }
    });
  }

  return { mount, destroy };
}
