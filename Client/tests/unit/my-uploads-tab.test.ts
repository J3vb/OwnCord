import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fetchImageAsObjectUrl = vi.hoisted(() => vi.fn(() => Promise.resolve("blob:thumb")));

vi.mock("@components/message-list/attachments", () => ({
  fetchImageAsObjectUrl,
  formatFileSize: (n: number) => `${n} B`,
  isImageMime: (m: string) => m.startsWith("image/"),
  resolveServerUrl: (url: string) => `https://server.test${url}`,
  thumbnailUrl: (url: string) => `${url}/thumb`,
}));

import {
  buildMyUploadsTab,
  UPLOADS_SEARCH_DEBOUNCE_MS,
  uploadLocation,
} from "@components/settings/MyUploadsTab";
import type { MyUploadsApi } from "@components/settings/MyUploadsTab";
import { ApiClientError } from "@lib/api";
import type { UserStorage, UserUploadItem, UserUploadsPage } from "@lib/types";
import { resetChannelsStore, setChannels } from "@stores/channels.store";

function upload(
  id: string,
  extra: Partial<UserUploadItem> = {},
  mime = "image/png",
): UserUploadItem {
  return {
    attachment: { id, filename: `${id}.png`, size: 10, mime, url: `/api/v1/files/${id}` },
    uploaded_at: "2026-10-01 10:00:00",
    channel_id: 5,
    message_id: 40,
    state: "message",
    removable: true,
    ...extra,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

describe("MyUploadsTab", () => {
  let abort: AbortController;
  let host: HTMLDivElement;
  let pane: HTMLDivElement;
  let getUserStorage: ReturnType<typeof vi.fn<MyUploadsApi["getUserStorage"]>>;
  let listUserUploads: ReturnType<typeof vi.fn<MyUploadsApi["listUserUploads"]>>;
  let removeUserUpload: ReturnType<typeof vi.fn<MyUploadsApi["removeUserUpload"]>>;

  async function open(
    pages: UserUploadsPage[],
    storage: UserStorage = { used_bytes: 64, quota_bytes: 100 },
  ) {
    let n = 0;
    getUserStorage.mockResolvedValue(storage);
    listUserUploads.mockImplementation(() =>
      Promise.resolve(pages[Math.min(n++, pages.length - 1)]!),
    );
    pane = buildMyUploadsTab(abort.signal, { getUserStorage, listUserUploads, removeUserUpload });
    host.appendChild(pane);
    await flush();
  }

  const rows = (): HTMLElement[] => [...pane.querySelectorAll<HTMLElement>(".my-uploads__row")];
  const lastQuery = () => listUserUploads.mock.calls.at(-1)![0];
  const confirmBtn = (): HTMLButtonElement | null =>
    document.querySelector<HTMLButtonElement>("[data-testid='uploads-remove-confirm-btn']");

  async function remove(row: HTMLElement): Promise<void> {
    row.querySelector<HTMLButtonElement>(".my-uploads__remove")!.click();
    confirmBtn()!.click();
    await flush();
  }

  beforeEach(() => {
    abort = new AbortController();
    host = document.createElement("div");
    document.body.appendChild(host);
    getUserStorage = vi.fn<MyUploadsApi["getUserStorage"]>();
    listUserUploads = vi.fn<MyUploadsApi["listUserUploads"]>();
    removeUserUpload = vi.fn<MyUploadsApi["removeUserUpload"]>(() => Promise.resolve());
    resetChannelsStore();
    setChannels([
      { id: 5, name: "photos", type: "text", category: null, position: 0 },
      { id: 6, name: "Sam", type: "dm", category: null, position: 1 },
    ]);
  });

  afterEach(() => {
    abort.abort();
    host.remove();
    document.body
      .querySelectorAll("[data-testid='uploads-remove-confirm']")
      .forEach((e) => e.remove());
    resetChannelsStore();
    vi.useRealTimers();
  });

  it("renders the usage bar, rows, locations and remove buttons by removability", async () => {
    await open([
      {
        items: [
          upload("a"),
          upload("b", { channel_id: 6 }),
          upload("c", { state: "avatar", removable: false, channel_id: null, message_id: null }),
          upload("d", { state: "pending", channel_id: null, message_id: null }, "application/pdf"),
          upload("e", { channel_id: 99 }),
        ],
      },
    ]);
    expect(pane.querySelector(".my-uploads__usage-text")!.textContent).toBe("64 B used of 100 B");
    expect(pane.querySelector(".my-uploads__bar")!.getAttribute("aria-valuenow")).toBe("64");
    expect(pane.querySelector(".my-uploads__usage")!.classList.contains("is-warning")).toBe(false);

    const where = rows().map((r) => r.querySelector(".my-uploads__where")!.textContent);
    expect(where).toEqual([
      "#photos",
      "DM with Sam",
      "Profile picture",
      "Not sent",
      "Unavailable channel",
    ]);
    expect(rows().map((r) => r.querySelector(".my-uploads__remove") !== null)).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
    expect(rows()[0]!.querySelector("img")).not.toBeNull();
    expect(rows()[3]!.querySelector("img")).toBeNull();
    expect(rows()[0]!.querySelector(".my-uploads__meta")!.textContent).toBe("10 B · Oct 1, 2026");
  });

  it("names the other states", () => {
    expect(uploadLocation(upload("x", { state: "deleted" }))).toBe("Deleted message");
    expect(uploadLocation(upload("x", { state: "banner" }))).toBe("Profile banner");
    expect(uploadLocation(upload("x", { state: "group_icon" }))).toBe("Group icon");
  });

  it("warns from 90% of the quota", async () => {
    await open([{ items: [upload("a")] }], { used_bytes: 90, quota_bytes: 100 });
    expect(pane.querySelector(".my-uploads__usage")!.classList.contains("is-warning")).toBe(true);
  });

  it("says 'no limit' and shows no bar when the quota is 0", async () => {
    await open([{ items: [upload("a")] }], { used_bytes: 2048, quota_bytes: 0 });
    expect(pane.querySelector(".my-uploads__usage-text")!.textContent).toBe(
      "2048 B used, no limit",
    );
    expect(pane.querySelector<HTMLElement>(".my-uploads__bar")!.hidden).toBe(true);
  });

  it("shows the empty state", async () => {
    await open([{ items: [] }]);
    expect(pane.querySelector(".my-uploads__status")!.textContent).toContain("haven't uploaded");
  });

  it("sends the sort and, after the debounce, the search; resetting the list each time", async () => {
    vi.useFakeTimers();
    await open([{ items: [upload("a")] }]);
    expect(lastQuery()).toMatchObject({ sort: "newest" });
    expect(lastQuery().q).toBeUndefined();

    pane.querySelector<HTMLButtonElement>("[data-sort='largest']")!.click();
    await flush();
    expect(lastQuery()).toMatchObject({ sort: "largest" });
    expect(lastQuery().cursor).toBeUndefined();

    const box = pane.querySelector<HTMLInputElement>(".my-uploads__search")!;
    box.value = "  cat ";
    box.dispatchEvent(new Event("input"));
    box.value = "cats";
    box.dispatchEvent(new Event("input"));
    const calls = listUserUploads.mock.calls.length;
    vi.advanceTimersByTime(UPLOADS_SEARCH_DEBOUNCE_MS - 1);
    expect(listUserUploads.mock.calls.length).toBe(calls);
    vi.advanceTimersByTime(1);
    await flush();
    expect(listUserUploads.mock.calls.length).toBe(calls + 1);
    expect(lastQuery()).toMatchObject({ sort: "largest", q: "cats" });
    expect(rows()).toHaveLength(1);
  });

  it("pages with next_cursor through Load more", async () => {
    await open([{ items: [upload("a")], next_cursor: "c1" }, { items: [upload("b")] }]);
    const more = pane.querySelector<HTMLButtonElement>("[data-testid='uploads-more']")!;
    expect(more.hidden).toBe(false);
    more.click();
    await flush();
    expect(lastQuery().cursor).toBe("c1");
    expect(rows().map((r) => r.dataset.attachmentId)).toEqual(["a", "b"]);
    expect(more.hidden).toBe(true);
  });

  it("removes a file after confirmation and refreshes the usage", async () => {
    await open([{ items: [upload("a"), upload("b")] }]);
    getUserStorage.mockResolvedValue({ used_bytes: 54, quota_bytes: 100 });
    rows()[0]!.querySelector<HTMLButtonElement>(".my-uploads__remove")!.click();
    expect(removeUserUpload).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Remove this file?");
    confirmBtn()!.click();
    await flush();
    expect(removeUserUpload).toHaveBeenCalledWith("a");
    expect(rows().map((r) => r.dataset.attachmentId)).toEqual(["b"]);
    expect(pane.querySelector(".my-uploads__usage-text")!.textContent).toBe("54 B used of 100 B");
  });

  it("mounts the confirmation inside the settings overlay so it stacks above it", async () => {
    const overlay = document.createElement("div");
    overlay.dataset.testid = "settings-overlay";
    host.appendChild(overlay);
    await open([{ items: [upload("a")] }]);
    overlay.appendChild(pane);
    rows()[0]!.querySelector<HTMLButtonElement>(".my-uploads__remove")!.click();
    expect(overlay.querySelector("[data-testid='uploads-remove-confirm']")).not.toBeNull();
  });

  it("does not remove when the confirmation is cancelled", async () => {
    await open([{ items: [upload("a")] }]);
    rows()[0]!.querySelector<HTMLButtonElement>(".my-uploads__remove")!.click();
    document
      .querySelector<HTMLButtonElement>(
        "[data-testid='uploads-remove-confirm'] .btn-ghost, [data-testid='uploads-remove-confirm'] .btn-secondary, [data-testid='uploads-remove-confirm'] .btn-modal-cancel",
      )!
      .click();
    await flush();
    expect(removeUserUpload).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(1);
  });

  it("treats a 404 as already removed: the row goes quietly", async () => {
    removeUserUpload.mockRejectedValue(new ApiClientError(404, "NOT_FOUND", "not found"));
    await open([{ items: [upload("a"), upload("b")] }]);
    await remove(rows()[0]!);
    expect(rows().map((r) => r.dataset.attachmentId)).toEqual(["b"]);
    expect(document.querySelector("[data-testid='uploads-remove-confirm']")).toBeNull();
  });

  it("keeps the row and explains a 409 in use", async () => {
    removeUserUpload.mockRejectedValue(new ApiClientError(409, "CONFLICT", "in use"));
    await open([{ items: [upload("a")] }]);
    await remove(rows()[0]!);
    expect(rows()).toHaveLength(1);
    expect(document.body.textContent).toContain("in use as a profile picture");
  });

  it("keeps the row and shows an error for any other failure", async () => {
    removeUserUpload.mockRejectedValue(new Error("boom"));
    await open([{ items: [upload("a")] }]);
    await remove(rows()[0]!);
    expect(rows()).toHaveLength(1);
    expect(document.querySelector("[data-testid='uploads-remove-confirm']")).not.toBeNull();
  });

  it("does not bring back a removed file from a page that was already in flight", async () => {
    await open([{ items: [upload("a")], next_cursor: "c1" }]);
    let land!: (page: UserUploadsPage) => void;
    listUserUploads.mockImplementationOnce(() => new Promise((r) => (land = r)));
    pane.querySelector<HTMLButtonElement>("[data-testid='uploads-more']")!.click();
    await remove(rows()[0]!);
    land({ items: [upload("a"), upload("b")] });
    await flush();
    expect(rows().map((r) => r.dataset.attachmentId)).toEqual(["b"]);
  });

  it("shows no empty state while a load is still in flight", async () => {
    await open([{ items: [upload("a")], next_cursor: "c1" }]);
    listUserUploads.mockImplementationOnce(() => new Promise(() => {}));
    pane.querySelector<HTMLButtonElement>("[data-testid='uploads-more']")!.click();
    await remove(rows()[0]!);
    expect(pane.querySelector<HTMLElement>(".my-uploads__status")!.hidden).toBe(true);
  });

  it("keeps the latest usage figure when answers arrive out of order", async () => {
    await open([{ items: [upload("a"), upload("b")] }]);
    const resolvers: Array<(s: UserStorage) => void> = [];
    getUserStorage.mockImplementation(() => new Promise((r) => resolvers.push(r)));
    await remove(rows()[0]!);
    await remove(rows()[0]!);
    resolvers[1]!({ used_bytes: 30, quota_bytes: 100 });
    resolvers[0]!({ used_bytes: 50, quota_bytes: 100 });
    await flush();
    expect(pane.querySelector(".my-uploads__usage-text")!.textContent).toBe("30 B used of 100 B");
  });

  it("offers a retry when the list cannot load", async () => {
    getUserStorage.mockResolvedValue({ used_bytes: 1, quota_bytes: 0 });
    listUserUploads.mockRejectedValueOnce(new Error("offline"));
    listUserUploads.mockResolvedValueOnce({ items: [upload("a")] });
    pane = buildMyUploadsTab(abort.signal, { getUserStorage, listUserUploads, removeUserUpload });
    host.appendChild(pane);
    await flush();
    expect(pane.querySelector(".my-uploads__status")!.textContent).toContain("Couldn't load");
    pane.querySelector<HTMLButtonElement>(".my-uploads__retry")!.click();
    await flush();
    expect(rows()).toHaveLength(1);
  });
});
