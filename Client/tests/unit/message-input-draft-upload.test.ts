// An upload still running when the user switches channel keeps going in the
// channel's draft, and the composer that restores the draft shows it again and
// sends its id once it finishes (WP 2A-10).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));

import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";
import type { GifApi, GifFavoritesApi } from "@lib/media/gifProvider";

type UploadResult = { id: string; url: string; filename: string };

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

/** An upload handler whose single call the test settles by hand. */
function controlledUpload() {
  let resolve: (r: UploadResult) => void = () => {};
  let reject: (e: Error) => void = () => {};
  let progress: ((f: number) => void) | undefined;
  let signal: AbortSignal | undefined;
  const fn = vi.fn((_file: File, s?: AbortSignal, onProgress?: (f: number) => void) => {
    signal = s;
    progress = onProgress;
    return new Promise<UploadResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
  });
  return {
    fn,
    resolve: (r: UploadResult) => resolve(r),
    reject: (e: Error) => reject(e),
    progress: (f: number) => progress?.(f),
    signal: () => signal,
  };
}

function queueFile(container: HTMLElement, file: File): void {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { value: [file], writable: true });
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
}

function send(container: HTMLElement): void {
  (container.querySelector(".send-btn") as HTMLButtonElement).click();
}

describe("MessageInput upload in flight across a channel switch", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("keeps the upload running and finishes it on the restored chip", async () => {
    const up = controlledUpload();
    const opts = makeOptions({ onUploadFile: up.fn });
    const first = createMessageInput(opts);
    first.mount(container);
    queueFile(container, new File(["x"], "big.zip", { type: "application/zip" }));
    await vi.waitFor(() => expect(up.fn).toHaveBeenCalled());

    const draft = first.getDraft();
    first.destroy?.();
    expect(up.signal()!.aborted).toBe(false);

    const next = createMessageInput(opts);
    next.mount(container);
    next.restoreDraft(draft);
    const chip = container.querySelector(".attachment-preview-item") as HTMLDivElement;
    expect(chip.classList.contains("uploading")).toBe(true);
    expect(chip.textContent).toContain("big.zip");

    up.progress(0.5);
    expect((chip.querySelector("progress") as HTMLProgressElement).value).toBeCloseTo(0.5);

    // (Send here no longer refuses: 3A-9 queues it, see message-input-send-queue.test.ts.)
    up.resolve({ id: "srv-7", url: "/f/7", filename: "big.zip" });
    await vi.waitFor(() => expect(chip.classList.contains("uploading")).toBe(false));
    (container.querySelector(".msg-textarea") as HTMLTextAreaElement).value = "done";
    send(container);
    expect(opts.onSend).toHaveBeenCalledWith(
      "done",
      null,
      ["srv-7"],
      [expect.objectContaining({ id: "srv-7" })],
      false,
    );
    next.destroy?.();
  });

  it("shows an upload that finished while away as a ready chip", async () => {
    const up = controlledUpload();
    const opts = makeOptions({ onUploadFile: up.fn });
    const first = createMessageInput(opts);
    first.mount(container);
    queueFile(container, new File(["x"], "doc.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(up.fn).toHaveBeenCalled());
    const draft = first.getDraft();
    first.destroy?.();

    up.resolve({ id: "srv-9", url: "/f/9", filename: "doc.pdf" });
    await Promise.resolve();

    const next = createMessageInput(opts);
    next.mount(container);
    next.restoreDraft(draft);
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    send(container);
    expect(opts.onSend).toHaveBeenCalledWith(
      "",
      null,
      ["srv-9"],
      [expect.objectContaining({ id: "srv-9" })],
      false,
    );
    next.destroy?.();
  });

  it("reports an upload that failed while away and drops its chip", async () => {
    const up = controlledUpload();
    const opts = makeOptions({ onUploadFile: up.fn });
    const first = createMessageInput(opts);
    first.mount(container);
    queueFile(container, new File(["x"], "doc.pdf", { type: "application/pdf" }));
    await vi.waitFor(() => expect(up.fn).toHaveBeenCalled());
    const draft = first.getDraft();
    first.destroy?.();

    up.reject(new Error("disk full"));
    await Promise.resolve();

    const next = createMessageInput(opts);
    next.mount(container);
    next.restoreDraft(draft);
    await vi.waitFor(() =>
      expect(container.querySelector(".attachment-upload-error")?.textContent).toMatch(/disk full/),
    );
    expect(container.querySelectorAll(".attachment-preview-item").length).toBe(0);
    next.destroy?.();
  });

  it("removing the restored chip cancels the upload", async () => {
    const up = controlledUpload();
    const opts = makeOptions({ onUploadFile: up.fn });
    const first = createMessageInput(opts);
    first.mount(container);
    queueFile(container, new File(["x"], "big.zip", { type: "application/zip" }));
    await vi.waitFor(() => expect(up.fn).toHaveBeenCalled());
    const draft = first.getDraft();
    first.destroy?.();

    const next = createMessageInput(opts);
    next.mount(container);
    next.restoreDraft(draft);
    (container.querySelector("[data-testid='attachment-remove']") as HTMLButtonElement).click();

    expect(up.signal()!.aborted).toBe(true);
    expect(container.querySelectorAll(".attachment-preview-item").length).toBe(0);
    next.destroy?.();
  });

  it("keeps a stale chip whose refresh fails after a channel switch, and retries at Send", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let n = 0;
      let failRefresh: (e: Error) => void = () => {};
      const onUploadFile = vi.fn((file: File) => {
        n += 1;
        if (n === 2) {
          return new Promise<UploadResult>((_res, rej) => {
            failRefresh = rej;
          });
        }
        return Promise.resolve({ id: `srv-${n}`, url: "/f", filename: file.name });
      });
      const opts = makeOptions({ onUploadFile });
      const first = createMessageInput(opts);
      first.mount(container);
      queueFile(container, new File(["x"], "a.pdf", { type: "application/pdf" }));
      await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());

      vi.setSystemTime(Date.now() + 51 * 60 * 1000);
      send(container);
      expect(onUploadFile).toHaveBeenCalledTimes(2);
      const draft = first.getDraft();
      first.destroy?.();

      const next = createMessageInput(opts);
      next.mount(container);
      next.restoreDraft(draft);
      failRefresh(new Error("network down"));
      await vi.waitFor(() =>
        expect(container.querySelector(".attachment-upload-error")?.textContent).toMatch(
          /network down/,
        ),
      );
      expect(container.querySelectorAll(".attachment-preview-item").length).toBe(1);
      expect(container.querySelector(".uploading")).toBeNull();

      send(container);
      expect(opts.onSend).not.toHaveBeenCalled();
      expect(onUploadFile).toHaveBeenCalledTimes(3);
      await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
      vi.setSystemTime(Date.now() + 1000);
      send(container);
      expect(opts.onSend).toHaveBeenCalledWith(
        "",
        null,
        ["srv-3"],
        [expect.objectContaining({ id: "srv-3" })],
        false,
      );
      next.destroy?.();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still cancels an in-flight upload on unmount when no draft took it", async () => {
    const up = controlledUpload();
    const comp = createMessageInput(makeOptions({ onUploadFile: up.fn }));
    comp.mount(container);
    queueFile(container, new File(["x"], "big.zip", { type: "application/zip" }));
    await vi.waitFor(() => expect(up.fn).toHaveBeenCalled());

    comp.destroy?.();

    expect(up.signal()!.aborted).toBe(true);
  });
});
