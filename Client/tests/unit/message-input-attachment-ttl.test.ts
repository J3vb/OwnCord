// A staged attachment the server's unlinked-upload sweep may already have
// deleted is never sent: past the age limit the chip re-uploads from its file,
// or is marked expired when there is no file, and Send refuses until it is
// fresh. Never a silent send without the file.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));

import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";
import type { GifApi, GifFavoritesApi } from "@lib/media/gifProvider";

const MIN = 60 * 1000;

const stubGifApi: GifApi & GifFavoritesApi = {
  gifSearch: vi.fn(async () => ({ results: [] })),
  gifTrending: vi.fn(async () => ({ results: [] })),
  gifFavorites: vi.fn(async () => ({ favorites: [] })),
  addGifFavorite: vi.fn(async () => undefined),
  removeGifFavorite: vi.fn(async () => undefined),
};

function makeOptions(overrides: Partial<MessageInputOptions> = {}): MessageInputOptions {
  return {
    channelId: 1,
    channelName: "general",
    gifApi: stubGifApi,
    onSend: vi.fn(),
    onTyping: vi.fn(),
    ...overrides,
  };
}

function queueFile(container: HTMLElement, file: File): void {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { value: [file], writable: true });
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
}

function uploader(): MessageInputOptions["onUploadFile"] & ReturnType<typeof vi.fn> {
  let n = 0;
  return vi.fn(async (file: File) => ({ id: `srv-${++n}`, url: `/f/${n}`, filename: file.name }));
}

function send(container: HTMLElement): void {
  (container.querySelector(".send-btn") as HTMLButtonElement).click();
}

function errorText(container: HTMLElement): string {
  return container.querySelector(".attachment-upload-error")?.textContent ?? "";
}

describe("MessageInput staged attachment age limit", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("re-uploads a chip older than 50 minutes at Send instead of sending its old id", async () => {
    // Only the clock is faked: the age timer never fires, as on a machine
    // that slept, so Send itself must catch the stale chip.
    vi.useFakeTimers({ toFake: ["Date"] });
    const onUploadFile = uploader();
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);
    const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;

    queueFile(container, new File(["x"], "a.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());

    vi.setSystemTime(Date.now() + 51 * MIN);
    textarea.value = "here it is";
    send(container);

    expect(opts.onSend).not.toHaveBeenCalled();
    expect(onUploadFile).toHaveBeenCalledTimes(2);
    expect(errorText(container)).toMatch(/send again/i);
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());

    vi.setSystemTime(Date.now() + 1000);
    send(container);
    expect(opts.onSend).toHaveBeenCalledWith(
      "here it is",
      null,
      ["srv-2"],
      [expect.objectContaining({ id: "srv-2" })],
      false,
    );
    comp.destroy?.();
  });

  it("keeps a stale chip when its refresh fails, and retries the refresh at the next Send", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let n = 0;
    const onUploadFile = vi.fn(async (file: File) => {
      n += 1;
      if (n === 2) throw new Error("network down");
      return { id: `srv-${n}`, url: `/f/${n}`, filename: file.name };
    });
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    queueFile(container, new File(["x"], "a.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());

    vi.setSystemTime(Date.now() + 51 * MIN);
    send(container);
    await vi.waitFor(() => expect(errorText(container)).toMatch(/network down/));
    expect(container.querySelectorAll(".attachment-preview-item").length).toBe(1);
    expect(container.querySelector(".uploading")).toBeNull();

    vi.setSystemTime(Date.now() + 1000);
    send(container);
    expect(opts.onSend).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    expect(onUploadFile).toHaveBeenCalledTimes(3);

    vi.setSystemTime(Date.now() + 1000);
    send(container);
    expect(opts.onSend).toHaveBeenCalledWith(
      "",
      null,
      ["srv-3"],
      [expect.objectContaining({ id: "srv-3" })],
      false,
    );
    comp.destroy?.();
  });

  it("sends a chip just under the limit unchanged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const onUploadFile = uploader();
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    queueFile(container, new File(["x"], "a.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());

    vi.setSystemTime(Date.now() + 49 * MIN);
    send(container);
    expect(opts.onSend).toHaveBeenCalledWith(
      "",
      null,
      ["srv-1"],
      [expect.objectContaining({ id: "srv-1" })],
      false,
    );
    expect(onUploadFile).toHaveBeenCalledTimes(1);
    comp.destroy?.();
  });

  it("never re-uploads in the background; Send refreshes the chip and clears the notice", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const onUploadFile = uploader();
    const opts = makeOptions({ onUploadFile });
    const comp = createMessageInput(opts);
    comp.mount(container);

    queueFile(container, new File(["x"], "a.pdf", { type: "application/pdf" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(container.querySelector(".uploading")).toBeNull();

    await vi.advanceTimersByTimeAsync(120 * MIN);
    expect(onUploadFile).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".expired")).toBeNull();

    send(container);
    expect(opts.onSend).not.toHaveBeenCalled();
    expect(errorText(container)).toMatch(/send again/i);
    await vi.advanceTimersByTimeAsync(0);
    expect(onUploadFile).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".uploading")).toBeNull();
    expect(errorText(container)).toBe("");

    await vi.advanceTimersByTimeAsync(1000);
    send(container);
    expect(opts.onSend).toHaveBeenCalledWith(
      "",
      null,
      ["srv-2"],
      [expect.objectContaining({ id: "srv-2" })],
      false,
    );
    comp.destroy?.();
  });

  it("marks a restored chip expired at the limit and refuses Send until it is removed", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);
    comp.restoreDraft({
      content: "with file",
      replyTo: null,
      attachments: [{ id: "old", filename: "old.pdf", uploadedAt: Date.now() - 45 * MIN }],
    });
    const chip = container.querySelector(".attachment-preview-item") as HTMLDivElement;
    expect(chip.classList.contains("expired")).toBe(false);

    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(chip.classList.contains("expired")).toBe(true);
    expect(chip.title).toMatch(/expired/i);

    send(container);
    expect(opts.onSend).not.toHaveBeenCalled();
    expect(errorText(container)).toMatch(/expired/i);

    (chip.querySelector(".attachment-preview-remove") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(1000);
    send(container);
    expect(opts.onSend).toHaveBeenCalledWith("with file", null, [], [], false);
    comp.destroy?.();
  });

  it("refuses Send for a restored chip that aged past the limit before its timer ran", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const opts = makeOptions();
    const comp = createMessageInput(opts);
    comp.mount(container);
    comp.restoreDraft({
      content: "with file",
      replyTo: null,
      attachments: [{ id: "old", filename: "old.pdf", uploadedAt: Date.now() - 45 * MIN }],
    });

    vi.setSystemTime(Date.now() + 6 * MIN);
    send(container);

    expect(opts.onSend).not.toHaveBeenCalled();
    expect(errorText(container)).toMatch(/expired/i);
    expect(container.querySelector(".attachment-preview-item")!.classList.contains("expired")).toBe(
      true,
    );
    comp.destroy?.();
  });
  it("withdraws the old copy before re-uploading a stale chip, so the quota has room", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const order: string[] = [];
    let n = 0;
    const onUploadFile = vi.fn(async (file: File) => {
      n += 1;
      order.push(`upload srv-${n}`);
      return { id: `srv-${n}`, url: `/f/${n}`, filename: file.name };
    });
    const onDiscardUpload = vi.fn(async (id: string) => {
      order.push(`discard ${id}`);
    });
    const opts = makeOptions({ onUploadFile, onDiscardUpload });
    const comp = createMessageInput(opts);
    comp.mount(container);

    queueFile(container, new File(["x"], "a.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());

    vi.setSystemTime(Date.now() + 51 * MIN);
    send(container);
    expect(container.querySelector(".uploading")).not.toBeNull();
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    expect(order).toEqual(["upload srv-1", "discard srv-1", "upload srv-2"]);

    vi.setSystemTime(Date.now() + 1000);
    send(container);
    expect(opts.onSend).toHaveBeenCalledWith(
      "",
      null,
      ["srv-2"],
      [expect.objectContaining({ id: "srv-2" })],
      false,
    );
    comp.destroy?.();
  });

  it("still re-uploads when withdrawing the old copy fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const onUploadFile = uploader();
    const onDiscardUpload = vi.fn(async () => {
      throw new Error("offline");
    });
    const opts = makeOptions({ onUploadFile, onDiscardUpload });
    const comp = createMessageInput(opts);
    comp.mount(container);

    queueFile(container, new File(["x"], "a.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());

    vi.setSystemTime(Date.now() + 51 * MIN);
    send(container);
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    expect(errorText(container)).toBe("");

    vi.setSystemTime(Date.now() + 1000);
    send(container);
    expect(opts.onSend).toHaveBeenCalledWith(
      "",
      null,
      ["srv-2"],
      [expect.objectContaining({ id: "srv-2" })],
      false,
    );
    comp.destroy?.();
  });

  it("withdraws a ready chip's upload when it is removed, but not one still uploading", async () => {
    let release: (() => void) | undefined;
    let n = 0;
    const onUploadFile = vi.fn((file: File) => {
      n += 1;
      const id = `srv-${n}`;
      if (n === 2) {
        return new Promise<{ id: string; url: string; filename: string }>((resolve) => {
          release = () => resolve({ id, url: "/f", filename: file.name });
        });
      }
      return Promise.resolve({ id, url: "/f", filename: file.name });
    });
    const onDiscardUpload = vi.fn(async () => {});
    const comp = createMessageInput(makeOptions({ onUploadFile, onDiscardUpload }));
    comp.mount(container);

    queueFile(container, new File(["x"], "a.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    queueFile(container, new File(["y"], "b.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).not.toBeNull());

    const removes = container.querySelectorAll<HTMLButtonElement>(".attachment-preview-remove");
    removes[1]!.click();
    expect(onDiscardUpload).not.toHaveBeenCalled();
    release?.();

    removes[0]!.click();
    expect(onDiscardUpload).toHaveBeenCalledExactlyOnceWith("srv-1");
    comp.destroy?.();
  });
});
