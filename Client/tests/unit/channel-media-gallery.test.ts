import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchImageAsObjectUrl = vi.hoisted(() => vi.fn(() => Promise.resolve("blob:thumb")));

vi.mock("@components/message-list/attachments", () => ({
  fetchImageAsObjectUrl,
  formatFileSize: (n: number) => `${n} B`,
  isImageMime: (m: string) => m.startsWith("image/"),
  isAudioMime: (m: string) => m.startsWith("audio/"),
  isVideoAttachment: (a: { mime: string }) => a.mime.startsWith("video/"),
  resolveServerUrl: (url: string) => `https://server.test${url}`,
  thumbnailUrl: (url: string) => `${url}/thumb`,
}));

import {
  createChannelMediaGallery,
  localMonthKey,
  MEDIA_SEARCH_DEBOUNCE_MS,
} from "@components/ChannelMediaGallery";
import type {
  ChannelMediaGalleryOptions,
  ChannelMediaGalleryPanel,
} from "@components/ChannelMediaGallery";
import type { ChannelMediaItem, ChannelMediaPage, ChannelMediaQuery } from "@lib/types";

function item(
  messageId: number,
  filename: string,
  mime: string,
  timestamp: string,
  extra: Partial<ChannelMediaItem["attachment"]> = {},
): ChannelMediaItem {
  return {
    attachment: {
      id: `att-${messageId}-${filename}`,
      filename,
      size: 10,
      mime,
      url: `/api/v1/files/att-${messageId}`,
      ...extra,
    },
    message_id: messageId,
    user: { id: 7, username: "alice" },
    timestamp,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("ChannelMediaGallery", () => {
  let container: HTMLDivElement;
  let panel: ChannelMediaGalleryPanel | null = null;
  let loadPage: ReturnType<typeof vi.fn<ChannelMediaGalleryOptions["loadPage"]>>;
  let loadMonths: ReturnType<typeof vi.fn<ChannelMediaGalleryOptions["loadMonths"]>>;
  let onJump: ReturnType<typeof vi.fn<(id: number) => void>>;

  function open(pages: ChannelMediaPage[]): ChannelMediaGalleryPanel {
    let n = 0;
    loadPage.mockImplementation(() => Promise.resolve(pages[Math.min(n++, pages.length - 1)]!));
    panel = createChannelMediaGallery({
      channelName: "photos",
      loadPage,
      loadMonths,
      uploaders: () => [
        { id: 7, name: "alice" },
        { id: 8, name: "bob" },
      ],
      onJumpToMessage: onJump,
      onClose: vi.fn(),
      timeZone: "UTC",
    });
    panel.mount(container);
    return panel;
  }

  const lastQuery = (): ChannelMediaQuery => loadPage.mock.calls.at(-1)![0];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    loadPage = vi.fn<ChannelMediaGalleryOptions["loadPage"]>();
    loadMonths = vi.fn<ChannelMediaGalleryOptions["loadMonths"]>(() =>
      Promise.resolve({
        months: [
          { month: "2026-02", count: 1 },
          { month: "2026-01", count: 2 },
          { month: "2025-12", count: 4 },
        ],
      }),
    );
    onJump = vi.fn<(id: number) => void>();
  });

  afterEach(() => {
    panel?.destroy();
    panel = null;
    container.remove();
    vi.useRealTimers();
  });

  it("groups media by month and jumps to the message on click", async () => {
    open([
      {
        items: [
          item(3, "c.png", "image/png", "2026-02-03 10:00:00"),
          item(2, "b.mp4", "video/mp4", "2026-01-20 10:00:00"),
          item(1, "a.png", "image/png", "2026-01-02 10:00:00"),
        ],
        next_cursor: "",
      },
    ]);
    await flush();

    expect(lastQuery()).toMatchObject({ kind: "media", order: "newest", tz: "UTC" });
    const headings = [...container.querySelectorAll(".media-gallery__month")].map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(["February 2026", "January 2026"]);
    expect(container.querySelectorAll(".media-gallery__tile")).toHaveLength(3);
    expect(container.querySelector(".media-gallery__tile--video")?.textContent).toContain("b.mp4");

    container.querySelector<HTMLElement>('[data-message-id="2"]')!.click();
    expect(onJump).toHaveBeenCalledWith(2);
  });

  it("lists the months by year and jumps the walk to one", async () => {
    open([{ items: [item(1, "a.png", "image/png", "2026-02-03 10:00:00")], next_cursor: "" }]);
    await flush();

    const years = [...container.querySelectorAll(".media-gallery__year")].map((y) => y.textContent);
    expect(years).toEqual(["2026", "2025"]);
    container.querySelector<HTMLElement>('[data-month="2025-12"]')!.click();
    await flush();
    expect(lastQuery()).toMatchObject({ month: "2025-12" });
    expect(lastQuery().cursor).toBeUndefined();
    expect(container.querySelector('[data-month="2025-12"]')?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("switches to the Files list and shows size, uploader and date", async () => {
    open([
      { items: [item(1, "a.png", "image/png", "2026-02-03 10:00:00")], next_cursor: "" },
      {
        items: [
          item(4, "notes.pdf", "application/pdf", "2026-02-04 10:00:00"),
          item(5, "voice.ogg", "audio/ogg", "2026-02-05 10:00:00", {
            duration_ms: 65_000,
            waveform: "AAEC",
          }),
        ],
        next_cursor: "",
      },
    ]);
    await flush();
    container.querySelector<HTMLElement>('[data-kind="files"]')!.click();
    await flush();

    expect(lastQuery()).toMatchObject({ kind: "files" });
    expect(loadMonths).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "files" }),
      expect.any(AbortSignal),
    );
    const metas = [...container.querySelectorAll(".media-gallery__file-meta")].map(
      (m) => m.textContent,
    );
    expect(metas[0]).toContain("10 B");
    expect(metas[0]).toContain("alice");
    expect(metas[1]).toContain("1:05");
    expect(container.querySelector('[data-kind="files"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("debounces the name search and filters by uploader", async () => {
    vi.useFakeTimers();
    open([{ items: [], next_cursor: "" }]);
    await flush();
    const calls = loadPage.mock.calls.length;

    const search = container.querySelector<HTMLInputElement>(".media-gallery__search")!;
    search.value = "hol";
    search.dispatchEvent(new Event("input"));
    search.value = "holiday";
    search.dispatchEvent(new Event("input"));
    expect(loadPage.mock.calls.length).toBe(calls);
    vi.advanceTimersByTime(MEDIA_SEARCH_DEBOUNCE_MS);
    await flush();
    expect(loadPage.mock.calls.length).toBe(calls + 1);
    expect(lastQuery()).toMatchObject({ q: "holiday" });
    expect(container.querySelector(".media-gallery__status")?.textContent).toBe(
      "Nothing matches your search.",
    );

    const from = container.querySelector<HTMLSelectElement>('select[aria-label="Posted by"]')!;
    expect([...from.options].map((o) => o.textContent)).toEqual(["Anyone", "alice", "bob"]);
    from.value = "8";
    from.dispatchEvent(new Event("change"));
    await flush();
    expect(lastQuery()).toMatchObject({ q: "holiday", from: 8 });
  });

  it("pages with the cursor and drops a stale page after a filter change", async () => {
    let resolveFirst: (p: ChannelMediaPage) => void = () => {};
    loadPage.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolveFirst = r;
        }),
    );
    panel = createChannelMediaGallery({
      channelName: "photos",
      loadPage,
      loadMonths,
      uploaders: () => [],
      onJumpToMessage: onJump,
      onClose: vi.fn(),
      timeZone: "UTC",
    });
    loadPage.mockImplementation(() =>
      Promise.resolve({
        items: [item(9, "fresh.png", "image/png", "2026-02-03 10:00:00")],
        next_cursor: "9_x",
      }),
    );
    panel.mount(container);
    const firstSignal = loadPage.mock.calls[0]![1];

    const sort = container.querySelector<HTMLSelectElement>('select[aria-label="Sort"]')!;
    sort.value = "oldest";
    sort.dispatchEvent(new Event("change"));
    expect(firstSignal.aborted).toBe(true);
    resolveFirst({
      items: [item(1, "stale.png", "image/png", "2026-01-01 10:00:00")],
      next_cursor: "",
    });
    await flush();

    expect(lastQuery()).toMatchObject({ order: "oldest" });
    const names = [...container.querySelectorAll(".media-gallery__tile")].map((t) =>
      t.getAttribute("title"),
    );
    expect(names).not.toContain("stale.png");
    expect(names).toContain("fresh.png");
  });

  it("uncovers a spoiler on the first click and jumps on the second", async () => {
    open([
      {
        items: [item(1, "SPOILER_ending.png", "image/png", "2026-02-03 10:00:00")],
        next_cursor: "",
      },
    ]);
    await flush();
    const tile = container.querySelector<HTMLElement>(".media-gallery__tile")!;
    expect(tile.classList.contains("is-spoiler")).toBe(true);
    tile.click();
    expect(onJump).not.toHaveBeenCalled();
    expect(tile.classList.contains("is-spoiler")).toBe(false);
    tile.click();
    expect(onJump).toHaveBeenCalledWith(1);
  });

  it("removes a deleted message's items and its emptied month", async () => {
    const p = open([
      {
        items: [
          item(2, "b.png", "image/png", "2026-02-03 10:00:00"),
          item(1, "a.png", "image/png", "2026-01-02 10:00:00"),
        ],
        next_cursor: "",
      },
    ]);
    await flush();
    p.removeMessages([1]);
    expect(container.querySelectorAll(".media-gallery__tile")).toHaveLength(1);
    expect(container.querySelectorAll(".media-gallery__section")).toHaveLength(1);
    p.removeMessages([2, 99]);
    expect(container.querySelector(".media-gallery__status")?.textContent).toBe(
      "No photos or videos in this channel yet.",
    );
  });

  it("offers a retry when a page fails", async () => {
    loadPage.mockRejectedValueOnce(new Error("offline"));
    panel = createChannelMediaGallery({
      channelName: "photos",
      loadPage,
      loadMonths,
      uploaders: () => [],
      onJumpToMessage: onJump,
      onClose: vi.fn(),
      timeZone: "UTC",
    });
    loadPage.mockResolvedValue({
      items: [item(1, "a.png", "image/png", "2026-02-03 10:00:00")],
      next_cursor: "",
    });
    panel.mount(container);
    await flush();
    expect(container.querySelector(".media-gallery__status")?.textContent).toContain(
      "Couldn't load media.",
    );
    container.querySelector<HTMLButtonElement>(".media-gallery__retry")!.click();
    await flush();
    expect(container.querySelectorAll(".media-gallery__tile")).toHaveLength(1);
  });
});

describe("localMonthKey", () => {
  it("reads the server's UTC timestamp in the local calendar", () => {
    expect(localMonthKey("2026-01-31 12:00:00")).toBe("2026-01");
    expect(localMonthKey("not a date")).toBe("");
  });
});

describe("ChannelMediaGallery files tab usage line", () => {
  let container: HTMLDivElement;
  let panel: ChannelMediaGalleryPanel | null = null;

  function open(extra: Partial<ChannelMediaGalleryOptions>): ChannelMediaGalleryPanel {
    panel = createChannelMediaGallery({
      channelName: "photos",
      loadPage: vi.fn(() => Promise.resolve({ items: [], next_cursor: "" })),
      loadMonths: vi.fn(() => Promise.resolve({ months: [] })),
      uploaders: () => [],
      onJumpToMessage: vi.fn(),
      onClose: vi.fn(),
      timeZone: "UTC",
      ...extra,
    });
    panel.mount(container);
    return panel;
  }
  const filesTab = (): HTMLButtonElement =>
    container.querySelector<HTMLButtonElement>("[data-kind='files']")!;
  const usage = (): HTMLElement =>
    container.querySelector<HTMLElement>("[data-testid='media-usage']")!;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => {
    panel?.destroy();
    panel = null;
    container.remove();
  });

  it("fetches storage once when Files first opens and links to My uploads", async () => {
    const loadStorage = vi.fn(() => Promise.resolve({ used_bytes: 64, quota_bytes: 100 }));
    const onManageUploads = vi.fn();
    open({ loadStorage, onManageUploads });
    await flush();
    expect(loadStorage).not.toHaveBeenCalled();
    expect(usage().hidden).toBe(true);

    filesTab().click();
    await flush();
    expect(loadStorage).toHaveBeenCalledTimes(1);
    expect(usage().hidden).toBe(false);
    expect(usage().textContent).toContain("You've used 64 B of 100 B");

    container.querySelector<HTMLButtonElement>("[data-testid='media-manage']")!.click();
    expect(onManageUploads).toHaveBeenCalledTimes(1);

    container.querySelector<HTMLButtonElement>("[data-kind='media']")!.click();
    expect(usage().hidden).toBe(true);
    filesTab().click();
    await flush();
    expect(loadStorage).toHaveBeenCalledTimes(1);
    expect(usage().hidden).toBe(false);
  });

  it("says how much is used when the quota is unlimited", async () => {
    open({
      loadStorage: () => Promise.resolve({ used_bytes: 5, quota_bytes: 0 }),
      onManageUploads: vi.fn(),
    });
    filesTab().click();
    await flush();
    expect(usage().textContent).toContain("5 B used");
    expect(usage().textContent).not.toContain("of");
  });

  it("stays out of the way when storage cannot be read", async () => {
    open({ loadStorage: () => Promise.reject(new Error("offline")) });
    filesTab().click();
    await flush();
    expect(usage().hidden).toBe(true);
  });

  it("drops only the removed attachment's item when a message's file list shrinks", async () => {
    const two = (name: string): ChannelMediaItem =>
      item(9, name, "application/pdf", "2026-02-03 10:00:00", { id: `id-${name}` });
    const p = open({
      loadPage: vi.fn(() =>
        Promise.resolve({ items: [two("a.pdf"), two("b.pdf")], next_cursor: "" }),
      ),
    });
    filesTab().click();
    await flush();
    expect(container.querySelectorAll(".media-gallery__file")).toHaveLength(2);

    p.syncMessageAttachments(9, ["id-b.pdf"]);
    const left = [...container.querySelectorAll(".media-gallery__file")];
    expect(left).toHaveLength(1);
    expect(left[0]!.getAttribute("data-attachment-id")).toBe("id-b.pdf");

    p.syncMessageAttachments(9, []);
    expect(container.querySelectorAll(".media-gallery__file")).toHaveLength(0);
    expect(container.querySelector(".media-gallery__section")).toBeNull();
    p.syncMessageAttachments(123, []);
  });
});
