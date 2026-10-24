import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { renderForumView } from "../../src/features/forums/ForumView";
import type { ForumViewContext } from "../../src/features/navigation/destinations";
import {
  resetThreadsStore,
  removeThread,
  threadsStore,
  upsertThread as upsert,
} from "@stores/threads.store";
import { channelsStore, resetChannelsStore, setChannels } from "@stores/channels.store";
import { setMembers } from "@stores/members.store";
import { setConnectionStatus, uiStore } from "@stores/ui.store";
import type { ApiClient } from "@lib/api";
import type { ThreadInfo, ThreadListResponse } from "@lib/types";
import { createMockWsClient } from "../helpers/mock-ws";
import { expectConsole } from "../helpers/console";
import { FORUM, makePost, seedForum } from "../helpers/forum-fixtures";

type Page = Pick<ThreadListResponse, "threads" | "has_more" | "next_before">;
const page = (threads: ThreadInfo[], next = ""): Page => ({
  threads,
  has_more: next !== "",
  next_before: next,
});

let ac: AbortController;
let root: HTMLElement;
let listThreads: ReturnType<typeof vi.fn>;
let openPost: Mock<(threadId: number) => void>;

/** Answer list requests by their query: `archived=0` and `archived=1` pages. */
function serve(pages: Record<string, Page>): void {
  listThreads.mockImplementation(async (_channel: number, query: string) => {
    const params = new URLSearchParams(query);
    const key = `${params.get("archived")}:${params.get("before") ?? ""}`;
    return pages[key] ?? page([]);
  });
}

function mount(): void {
  root = document.createElement("div");
  document.body.appendChild(root);
  renderForumView(root, {
    channelId: FORUM,
    signal: ac.signal,
    api: { listThreads } as unknown as ApiClient,
    ws: createMockWsClient() as never,
    openPost,
  } satisfies ForumViewContext);
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** A frame as the dispatcher applies it; the store announces it in a microtask, so flush. */
function upsertThread(post: ThreadInfo): void {
  upsert(post);
  threadsStore.flush();
}
function reseed(
  forum: Parameters<typeof seedForum>[1],
  over: Parameters<typeof seedForum>[0] = {},
): void {
  seedForum(over, forum);
  channelsStore.flush();
}
const q = <T extends HTMLElement>(sel: string): T => root.querySelector<T>(sel) as T;
const titles = (sel = '[data-testid="forum-posts"]'): string[] =>
  Array.from(root.querySelectorAll(`${sel} .forum-post-title`)).map((e) => e.textContent ?? "");
const queries = (): URLSearchParams[] =>
  listThreads.mock.calls.map((c) => new URLSearchParams(c[1] as string));

beforeEach(() => {
  localStorage.clear();
  ac = new AbortController();
  listThreads = vi.fn();
  openPost = vi.fn();
  resetThreadsStore();
  resetChannelsStore();
  seedForum();
  setMembers([
    {
      id: 10,
      username: "alice",
      avatar: null,
      role: "member",
      status: "online",
      display_name: "Alice",
    },
  ]);
  serve({ "0:": page([]), "1:": page([]) });
});
afterEach(() => {
  ac.abort();
  root.remove();
  document.body.replaceChildren();
  resetThreadsStore();
});

describe("ForumView list", () => {
  it("shows the guidelines, the tags and a row per post with title, tags, author, replies and preview", async () => {
    serve({ "0:": page([makePost(1, { tags: [1, 2], message_count: 4 })]) });
    mount();
    await vi.waitFor(() => expect(titles()).toEqual(["Post 1"]));
    expect(q('[data-testid="forum-guidelines-body"]').textContent).toContain("Be kind.");
    expect(root.querySelectorAll(".forum-tag-chip").length).toBe(3);
    const row = q('[data-testid="forum-post-1"]');
    expect(row.querySelectorAll(".forum-tag")).toHaveLength(2);
    expect(row.textContent).toContain("🐛 Bug");
    expect(row.textContent).toContain("opening message of 1");
    expect(row.textContent).toContain("Alice");
    expect(row.textContent).toContain("3 replies");
    expect(queries()[0]!.toString()).toBe("archived=0&sort=activity&limit=25");
  });

  it("collapses the guidelines", async () => {
    mount();
    await flush();
    const toggle = q<HTMLButtonElement>('[data-testid="forum-guidelines-toggle"]');
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(q('[data-testid="forum-guidelines-body"]').hidden).toBe(true);
  });

  it("remembers the collapsed guidelines for the next forum", async () => {
    mount();
    await flush();
    q<HTMLButtonElement>('[data-testid="forum-guidelines-toggle"]').click();
    expect(localStorage.getItem("owncord:settings:forumGuidelinesOpen")).toBe("false");
    root.remove();
    mount();
    await flush();
    expect(q('[data-testid="forum-guidelines-body"]').hidden).toBe(true);
    expect(q('[data-testid="forum-guidelines-toggle"]').getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("starts in cards, switches layout from the toolbar and remembers it", async () => {
    serve({ "0:": page([makePost(1)]) });
    mount();
    await vi.waitFor(() => expect(titles()).toHaveLength(1));
    expect(root.classList.contains("forum-view--grid")).toBe(true);
    expect(q('[data-testid="forum-layout-grid"]').getAttribute("aria-pressed")).toBe("true");

    q<HTMLButtonElement>('[data-testid="forum-layout-feed"]').click();
    expect(root.classList.contains("forum-view--feed")).toBe(true);
    expect(root.classList.contains("forum-view--grid")).toBe(false);
    expect(q('[data-testid="forum-layout-feed"]').getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("owncord:settings:forumLayout")).toBe('"feed"');
    // A layout switch redraws nothing from the server.
    expect(listThreads).toHaveBeenCalledTimes(2);

    root.remove();
    mount();
    expect(root.classList.contains("forum-view--feed")).toBe(true);
  });

  it("gives each row the author's avatar and a reply count, and marks the open post", async () => {
    serve({ "0:": page([makePost(1, { message_count: 4 }), makePost(2)]) });
    mount();
    await vi.waitFor(() => expect(titles()).toHaveLength(2));
    const row = q('[data-testid="forum-post-1"]');
    expect(row.querySelector(".forum-post-avatar")?.textContent).toBe("A");
    expect(row.querySelector(".forum-post-count")?.textContent).toBe("3");

    threadsStore.setState((prev) => ({ ...prev, focusedThreadId: 1 }));
    threadsStore.flush();
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(q('[data-testid="forum-post-2"]').hasAttribute("aria-current")).toBe(false);
  });

  it("opens a post on click", async () => {
    serve({ "0:": page([makePost(1)]) });
    mount();
    await vi.waitFor(() => expect(titles()).toHaveLength(1));
    q<HTMLButtonElement>('[data-testid="forum-post-1"]').click();
    expect(openPost).toHaveBeenCalledWith(1);
  });

  it("says so when the opening message was deleted", async () => {
    const gone = makePost(1);
    serve({
      "0:": page([{ ...gone, post: { tag_ids: [], first_message: null } }]),
    });
    mount();
    await vi.waitFor(() => expect(titles()).toHaveLength(1));
    expect(q('[data-testid="forum-post-1"]').textContent).toContain("opening message was deleted");
  });

  it("hides New Post when the viewer may not post", async () => {
    seedForum({ can_send: false });
    mount();
    await flush();
    expect(q('[data-testid="forum-new-post"]').hidden).toBe(true);
  });
});

describe("ForumView paging", () => {
  it("pages the open posts with next_before, then loads Older posts below them", async () => {
    serve({
      "0:": page([makePost(3), makePost(2)], "c1"),
      "0:c1": page([makePost(1)]),
      "1:": page([makePost(0, { archived: true, name: "Archived post" })]),
    });
    mount();
    await vi.waitFor(() => expect(titles()).toEqual(["Post 3", "Post 2"]));
    // The first page had more: nothing older is requested yet.
    expect(queries().map((p) => p.get("archived"))).toEqual(["0"]);
    q<HTMLButtonElement>('[data-testid="forum-more"]').click();
    await vi.waitFor(() =>
      expect(titles("[data-testid=forum-posts-older]")).toEqual(["Archived post"]),
    );
    expect(titles()).toEqual(["Post 3", "Post 2", "Post 1"]);
    const asked = queries().map((p) => `${p.get("archived")}:${p.get("before") ?? ""}`);
    expect(asked).toEqual(["0:", "0:c1", "1:"]);
    expect(q('[data-testid="forum-older-head"]').hidden).toBe(false);
    expect(q('[data-testid="forum-older-head"]').textContent).toBe("Older posts");
  });

  it("sends the selected tags as repeated tag parameters and restarts the list", async () => {
    serve({ "0:": page([makePost(1, { tags: [1] }), makePost(2, { tags: [3] })]) });
    mount();
    await vi.waitFor(() => expect(titles()).toHaveLength(2));
    q<HTMLButtonElement>('[data-testid="forum-tag-1"]').click();
    q<HTMLButtonElement>('[data-testid="forum-tag-3"]').click();
    await vi.waitFor(() => expect(queries().length).toBeGreaterThanOrEqual(3));
    await flush();
    const last = queries()
      .filter((p) => p.get("archived") === "0")
      .at(-1)!;
    expect(last.getAll("tag")).toEqual(["1", "3"]);
    expect(last.get("before")).toBeNull();
    expect(q('[data-testid="forum-tag-1"]').getAttribute("aria-pressed")).toBe("true");
    expect(q('[data-testid="forum-tag-2"]').getAttribute("aria-pressed")).toBe("false");
  });

  it("filters live posts by the selected tags too, and clearing the filter restores them", async () => {
    mount();
    await flush();
    q<HTMLButtonElement>('[data-testid="forum-tag-2"]').click();
    await flush();
    upsertThread(makePost(5, { tags: [1] }));
    upsertThread(makePost(6, { tags: [2] }));
    expect(titles()).toEqual(["Post 6"]);
    q<HTMLButtonElement>('[data-testid="forum-tag-clear"]').click();
    await flush();
    // A fresh list: the filter's live posts were left behind with the old list.
    expect(queries().at(-1)!.getAll("tag")).toEqual([]);
  });

  it("switches the sort, which restarts paging with the new order", async () => {
    serve({ "0:": page([makePost(2), makePost(1)], "c1") });
    mount();
    await vi.waitFor(() => expect(titles()).toHaveLength(2));
    q<HTMLButtonElement>('[data-testid="forum-sort-created"]').click();
    await flush();
    const last = queries().at(-1)!;
    expect(last.get("sort")).toBe("created");
    expect(last.get("before")).toBeNull();
    expect(q('[data-testid="forum-sort-created"]').getAttribute("aria-pressed")).toBe("true");
  });

  it("reports a failed page and retries it", async () => {
    listThreads.mockRejectedValueOnce(new Error("boom"));
    serve({ "0:": page([makePost(1)]) });
    mount();
    await vi.waitFor(() =>
      expect(q('[data-testid="forum-status"]').textContent).toBe("Couldn't load posts"),
    );
    expectConsole("warn", /Forum post list failed/);
    listThreads.mockImplementation(async () => page([makePost(1)]));
    q<HTMLButtonElement>('[data-testid="forum-more"]').click();
    await vi.waitFor(() => expect(titles()).toEqual(["Post 1"]));
  });

  it("drops a page that lands after the channel was left", async () => {
    let release: (p: Page) => void = () => {};
    listThreads.mockImplementation(() => new Promise<Page>((r) => (release = r)));
    mount();
    ac.abort();
    release(page([makePost(1)]));
    await flush();
    expect(titles()).toEqual([]);
  });
});

describe("ForumView live updates", () => {
  it("moves a post that took a reply to the top, and adds new posts once", async () => {
    serve({
      "0:": page([
        makePost(2, { last_message_at: "2026-10-21T10:00:00Z" }),
        makePost(1, { last_message_at: "2026-10-21T09:00:00Z" }),
      ]),
    });
    mount();
    await vi.waitFor(() => expect(titles()).toEqual(["Post 2", "Post 1"]));
    // thread_changed: the dispatcher writes the post's whole state.
    upsertThread(makePost(1, { last_message_at: "2026-10-21T11:00:00Z", message_count: 4 }));
    expect(titles()).toEqual(["Post 1", "Post 2"]);
    expect(q('[data-testid="forum-post-1"]').textContent).toContain("3 replies");
    const created = makePost(3, { last_message_at: "2026-10-21T12:00:00Z" });
    upsertThread(created);
    upsertThread(created);
    expect(titles()).toEqual(["Post 3", "Post 1", "Post 2"]);
    expect(root.querySelectorAll('[data-testid="forum-post-3"]')).toHaveLength(1);
  });

  it("keeps the same row element across a re-sort, so a focused row keeps focus", async () => {
    serve({
      "0:": page([
        makePost(2, { last_message_at: "2026-10-21T10:00:00Z" }),
        makePost(1, { last_message_at: "2026-10-21T09:00:00Z" }),
      ]),
    });
    mount();
    await vi.waitFor(() => expect(titles()).toHaveLength(2));
    q<HTMLButtonElement>('[data-testid="forum-post-1"]').focus();
    upsertThread(makePost(1, { last_message_at: "2026-10-21T11:00:00Z" }));
    expect(document.activeElement).toBe(q('[data-testid="forum-post-1"]'));
  });

  it("sorts by id under Newest", async () => {
    mount();
    await flush();
    q<HTMLButtonElement>('[data-testid="forum-sort-created"]').click();
    await flush();
    upsertThread(makePost(1, { last_message_at: "2026-10-21T12:00:00Z" }));
    upsertThread(makePost(2, { last_message_at: "2026-10-21T08:00:00Z" }));
    expect(titles()).toEqual(["Post 2", "Post 1"]);
  });

  it("moves an archived post to Older posts and brings a reopened one back", async () => {
    serve({ "0:": page([makePost(1)]) });
    mount();
    await vi.waitFor(() => expect(titles()).toEqual(["Post 1"]));
    upsertThread(makePost(1, { archived: true }));
    expect(titles()).toEqual([]);
    expect(titles("[data-testid=forum-posts-older]")).toEqual(["Post 1"]);
    upsertThread(makePost(1, { archived: false }));
    expect(titles()).toEqual(["Post 1"]);
  });

  it("ignores another channel's threads and drops a deleted post", async () => {
    serve({ "0:": page([makePost(1)]) });
    mount();
    await vi.waitFor(() => expect(titles()).toEqual(["Post 1"]));
    upsertThread(makePost(7, { parent_id: 2 }));
    expect(titles()).toEqual(["Post 1"]);
    removeThread(1);
    threadsStore.flush();
    expect(titles()).toEqual([]);
  });

  it("does not list a stored post older than the first page (a gap in the pages)", async () => {
    upsertThread(makePost(50, { last_message_at: "2026-10-01T00:00:00Z" }));
    serve({
      "0:": page([makePost(1, { last_message_at: "2026-10-21T09:00:00Z" })], "cursor-1"),
    });
    mount();
    await vi.waitFor(() => expect(titles()).toEqual(["Post 1"]));
  });

  it("shows a post a live frame brought before the view mounted once the first page lands", async () => {
    // thread_changed arrived while the lazy view was still loading.
    upsertThread(makePost(50, { last_message_at: "2026-10-22T09:00:00Z" }));
    serve({
      "0:": page([makePost(1, { last_message_at: "2026-10-21T09:00:00Z" })], "cursor-1"),
    });
    mount();
    await vi.waitFor(() => expect(titles()).toEqual(["Post 50", "Post 1"]));
  });

  it("refetches the first page after a reconnect and keeps the rows meanwhile", async () => {
    serve({ "0:": page([makePost(1)]) });
    mount();
    await vi.waitFor(() => expect(titles()).toEqual(["Post 1"]));
    const openFetches = (): number => queries().filter((p) => p.get("archived") === "0").length;
    const before = openFetches();
    serve({ "0:": page([makePost(2)]) });
    setConnectionStatus("reconnecting");
    uiStore.flush();
    expect(openFetches()).toBe(before);
    setConnectionStatus("connected");
    uiStore.flush();
    // The old rows stay until the new first page lands, then are replaced.
    expect(titles()).toEqual(["Post 1"]);
    await vi.waitFor(() => expect(titles()).toEqual(["Post 2"]));
    expect(queries().at(-1)!.get("before")).toBeNull();
    expect(openFetches()).toBe(before + 1);
  });

  it("opens one New Post dialog for a double click during the lazy import", async () => {
    mount();
    await flush();
    const btn = q<HTMLButtonElement>('[data-testid="forum-new-post"]');
    btn.click();
    btn.click();
    expect(btn.disabled).toBe(true);
    await vi.waitFor(() =>
      expect(document.querySelectorAll('[data-testid="forum-post-dialog"]')).toHaveLength(1),
    );
    await flush();
    expect(document.querySelectorAll('[data-testid="forum-post-dialog"]')).toHaveLength(1);
    // Closing the dialog frees the button for the next one.
    document.querySelector<HTMLElement>('[data-testid="forum-post-cancel"]')!.click();
    await vi.waitFor(() => expect(btn.disabled).toBe(false));
  });

  it("does not retry a failed page on its own when the sentinel is still in view", async () => {
    const observers: { cb: (e: { isIntersecting: boolean }[]) => void }[] = [];
    class FakeIO {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) {
        observers.push({ cb });
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("IntersectionObserver", FakeIO);
    try {
      listThreads.mockRejectedValue(new Error("boom"));
      mount();
      await vi.waitFor(() =>
        expect(q('[data-testid="forum-status"]').textContent).toContain("Couldn't"),
      );
      expectConsole("warn", /Forum post list failed/);
      const calls = listThreads.mock.calls.length;
      observers[0]!.cb([{ isIntersecting: true }]);
      await flush();
      expect(listThreads.mock.calls.length).toBe(calls);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("takes a page's tags over a stale stored copy no live frame has touched", async () => {
    upsertThread(makePost(1, { tags: [1] }));
    serve({ "0:": page([makePost(1, { tags: [2] })]) });
    mount();
    await vi.waitFor(() => expect(titles()).toEqual(["Post 1"]));
    expect(q('[data-testid="forum-post-1"]').textContent).toContain("Idea");
  });

  it("repaints a row when the forum's tags are renamed", async () => {
    serve({ "0:": page([makePost(1, { tags: [2] })]) });
    mount();
    await vi.waitFor(() => expect(titles()).toHaveLength(1));
    reseed({ tags: [{ id: 2, name: "Proposal", position: 0 }] });
    expect(q('[data-testid="forum-post-1"]').textContent).toContain("Proposal");
  });
});

describe("ForumView empty states", () => {
  it("says there are no posts yet", async () => {
    mount();
    await vi.waitFor(() => expect(q('[data-testid="forum-empty"]').hidden).toBe(false));
    expect(q(".forum-empty-title").textContent).toBe("No posts yet");
    // Both halves were asked for before the empty state showed.
    expect(queries().map((p) => p.get("archived"))).toEqual(["0", "1"]);
  });

  it("says there are no posts with the selected tags", async () => {
    mount();
    await flush();
    q<HTMLButtonElement>('[data-testid="forum-tag-3"]').click();
    await vi.waitFor(() =>
      expect(q(".forum-empty-title").textContent).toBe("No posts with these tags"),
    );
    expect(q('[data-testid="forum-empty"]').hidden).toBe(false);
  });

  it("is not shown while a page is still loading", async () => {
    listThreads.mockImplementation(() => new Promise(() => {}));
    mount();
    await flush();
    expect(q('[data-testid="forum-empty"]').hidden).toBe(true);
    expect(q('[data-testid="forum-status"]').textContent).toBe("Loading posts…");
  });
});

describe("ForumView header follows the channel", () => {
  it("drops a tag filter whose tag the forum no longer has", async () => {
    mount();
    await flush();
    q<HTMLButtonElement>('[data-testid="forum-tag-3"]').click();
    await flush();
    reseed({ tags: [{ id: 1, name: "Bug", position: 0 }] });
    await flush();
    expect(queries().at(-1)!.getAll("tag")).toEqual([]);
  });

  it("hides the guidelines when the topic is empty", async () => {
    seedForum({ topic: "" });
    mount();
    await flush();
    expect(q('[data-testid="forum-guidelines"]').hidden).toBe(true);
    setChannels([]);
  });
});
