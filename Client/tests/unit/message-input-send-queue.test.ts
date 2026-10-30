// Send while uploading, composer half (WP 3A-9): Enter with an upload running
// hands the message to the host as a queued send, in chip order, and clears the
// composer. A stale or expired chip, too-long text and the slow-mode gate still
// refuse, exactly as before.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));

import {
  createMessageInput,
  type MessageInputOptions,
  type QueuedAttachment,
} from "@components/MessageInput";
import type { GifApi, GifFavoritesApi } from "@lib/media/gifProvider";

type UploadResult = { id: string; url: string; filename: string };

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

/** An upload handler whose calls the test settles by hand, one entry per call. */
function heldUploads() {
  const calls: {
    file: File;
    signal: AbortSignal | undefined;
    resolve: (r: UploadResult) => void;
    reject: (e: Error) => void;
  }[] = [];
  const fn = vi.fn(
    (file: File, signal?: AbortSignal) =>
      new Promise<UploadResult>((resolve, reject) => {
        calls.push({ file, signal, resolve, reject });
      }),
  );
  return { fn, calls };
}

function queueFile(container: HTMLElement, file: File): void {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
}

const send = (container: HTMLElement): void =>
  (container.querySelector(".send-btn") as HTMLButtonElement).click();
const textareaOf = (container: HTMLElement): HTMLTextAreaElement =>
  container.querySelector(".msg-textarea") as HTMLTextAreaElement;
const errorText = (container: HTMLElement): string =>
  container.querySelector(".attachment-upload-error")?.textContent ?? "";
const pdf = (name: string): File => new File(["x"], name, { type: "application/pdf" });

describe("MessageInput send while uploading", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("hands over every chip in chip order and clears the text, the reply and the chips", async () => {
    const uploads = heldUploads();
    const opts = makeOptions({ onUploadFile: uploads.fn });
    const comp = createMessageInput(opts);
    comp.mount(container);
    const a = pdf("a.pdf");
    const b = pdf("b.pdf");
    const c = pdf("c.pdf");
    queueFile(container, a);
    await vi.waitFor(() => expect(uploads.fn).toHaveBeenCalledTimes(1));
    uploads.calls[0]!.resolve({ id: "srv-a", url: "/a", filename: "a.pdf" });
    await vi.waitFor(() =>
      expect(container.querySelector(".attachment-preview-item.uploading")).toBeNull(),
    );
    queueFile(container, b);
    queueFile(container, c);
    await vi.waitFor(() => expect(uploads.fn).toHaveBeenCalledTimes(3));
    comp.setReplyTo(9, "bob");
    textareaOf(container).value = "  here they are  ";

    send(container);

    expect(opts.onSend).toHaveBeenCalledOnce();
    const call = vi.mocked(opts.onSend).mock.calls[0]!;
    // The settled chip rides in the plain arguments too, as it does today.
    expect(call.slice(0, 5)).toEqual([
      "here they are",
      9,
      ["srv-a"],
      [{ id: "srv-a", filename: "a.pdf", file: a }],
      true,
    ]);
    const queued = call[5] as readonly QueuedAttachment[];
    expect(queued.map((q) => q.filename)).toEqual(["a.pdf", "b.pdf", "c.pdf"]);
    expect(queued[0]).toMatchObject({ id: "srv-a", file: a, uploadedAt: expect.any(Number) });
    expect(queued[0]!.upload).toBeUndefined();
    expect(queued[1]).toMatchObject({ file: b, upload: expect.objectContaining({ file: b }) });
    expect(queued[1]!.id).toBeUndefined();
    expect(queued[2]).toMatchObject({ file: c, upload: expect.objectContaining({ file: c }) });
    // Every handed handle is free for the host's strip to take over.
    expect(queued[1]!.upload!.onProgress).toBeNull();
    expect(queued[2]!.upload!.onProgress).toBeNull();

    expect(textareaOf(container).value).toBe("");
    expect(container.querySelector(".reply-bar.visible")).toBeNull();
    expect(container.querySelectorAll(".attachment-preview-item")).toHaveLength(0);
    expect(errorText(container)).toBe("");
    comp.destroy?.();
  });

  it("does not carry the old id of a chip that is refreshing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const uploads = heldUploads();
    const opts = makeOptions({ onUploadFile: uploads.fn });
    const comp = createMessageInput(opts);
    comp.mount(container);
    queueFile(container, pdf("a.pdf"));
    await vi.waitFor(() => expect(uploads.fn).toHaveBeenCalledTimes(1));
    uploads.calls[0]!.resolve({ id: "srv-old", url: "/o", filename: "a.pdf" });
    await vi.waitFor(() =>
      expect(container.querySelector(".attachment-preview-item.uploading")).toBeNull(),
    );
    vi.setSystemTime(Date.now() + 55 * MIN);

    // Send refreshes the stale chip and refuses; the next Send queues behind the refresh.
    send(container);
    expect(opts.onSend).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(uploads.fn).toHaveBeenCalledTimes(2));
    vi.setSystemTime(Date.now() + 1000);
    send(container);

    const call = vi.mocked(opts.onSend).mock.calls[0]!;
    expect(call.slice(0, 4)).toEqual(["", null, [], []]);
    const queued = call[5] as readonly QueuedAttachment[];
    expect(queued).toHaveLength(1);
    expect(queued[0]!.id).toBeUndefined();
    expect(queued[0]!.upload).toBeDefined();
    comp.destroy?.();
  });

  it("queues a chip restored from a draft that is still uploading", async () => {
    const uploads = heldUploads();
    const opts = makeOptions({ onUploadFile: uploads.fn });
    const first = createMessageInput(opts);
    first.mount(container);
    queueFile(container, pdf("big.zip"));
    await vi.waitFor(() => expect(uploads.fn).toHaveBeenCalled());
    const draft = first.getDraft();
    first.destroy?.();

    const next = createMessageInput(opts);
    next.mount(container);
    next.restoreDraft(draft);
    send(container);

    expect(opts.onSend).toHaveBeenCalledOnce();
    const queued = vi.mocked(opts.onSend).mock.calls[0]![5] as readonly QueuedAttachment[];
    expect(queued.map((q) => q.filename)).toEqual(["big.zip"]);
    expect(queued[0]!.upload).toBe(draft.uploads![0]);
    next.destroy?.();
  });

  it("shows no composer error when a queued upload fails later", async () => {
    const uploads = heldUploads();
    const opts = makeOptions({ onUploadFile: uploads.fn });
    const comp = createMessageInput(opts);
    comp.mount(container);
    queueFile(container, pdf("a.pdf"));
    await vi.waitFor(() => expect(uploads.fn).toHaveBeenCalled());
    textareaOf(container).value = "hi";
    send(container);
    expect(opts.onSend).toHaveBeenCalledOnce();

    uploads.calls[0]!.reject(new Error("Server exploded"));
    await new Promise((r) => setTimeout(r, 10));

    expect(errorText(container)).toBe("");
    comp.destroy?.();
  });

  it("shows no composer error and no stale chip state when a queued upload succeeds later", async () => {
    const uploads = heldUploads();
    const opts = makeOptions({ onUploadFile: uploads.fn });
    const comp = createMessageInput(opts);
    comp.mount(container);
    queueFile(container, pdf("a.pdf"));
    await vi.waitFor(() => expect(uploads.fn).toHaveBeenCalled());
    send(container);

    uploads.calls[0]!.resolve({ id: "srv-a", url: "/a", filename: "a.pdf" });
    await new Promise((r) => setTimeout(r, 10));

    // The chip is gone for good: it was not resurrected and no second send happened.
    expect(container.querySelectorAll(".attachment-preview-item")).toHaveLength(0);
    expect(comp.getDraft().attachments).toEqual([]);
    expect(opts.onSend).toHaveBeenCalledOnce();
    comp.destroy?.();
  });

  it("does not cancel a queued upload when the composer unmounts", async () => {
    const uploads = heldUploads();
    const opts = makeOptions({ onUploadFile: uploads.fn });
    const comp = createMessageInput(opts);
    comp.mount(container);
    queueFile(container, pdf("a.pdf"));
    await vi.waitFor(() => expect(uploads.fn).toHaveBeenCalled());
    send(container);
    const queued = vi.mocked(opts.onSend).mock.calls[0]![5] as readonly QueuedAttachment[];

    comp.destroy?.();

    expect(uploads.calls[0]!.signal!.aborted).toBe(false);
    expect(queued[0]!.upload!.owner.signal.aborted).toBe(false);
  });

  it("still cancels an upload that was not queued when the composer unmounts", async () => {
    const uploads = heldUploads();
    const opts = makeOptions({ onUploadFile: uploads.fn });
    const comp = createMessageInput(opts);
    comp.mount(container);
    queueFile(container, pdf("a.pdf"));
    await vi.waitFor(() => expect(uploads.fn).toHaveBeenCalled());

    comp.destroy?.();

    expect(uploads.calls[0]!.signal!.aborted).toBe(true);
  });

  it("still refuses an expired chip while another upload is running", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const uploads = heldUploads();
    const opts = makeOptions({ onUploadFile: uploads.fn });
    const comp = createMessageInput(opts);
    comp.mount(container);
    comp.restoreDraft({
      content: "",
      replyTo: null,
      attachments: [{ id: "old", filename: "old.pdf", uploadedAt: Date.now() - 45 * MIN }],
    });
    queueFile(container, pdf("new.pdf"));
    await vi.waitFor(() => expect(uploads.fn).toHaveBeenCalled());
    vi.setSystemTime(Date.now() + 6 * MIN);
    textareaOf(container).value = "with files";

    send(container);

    expect(opts.onSend).not.toHaveBeenCalled();
    expect(errorText(container)).toMatch(/expired/i);
    expect(textareaOf(container).value).toBe("with files");
    comp.destroy?.();
  });

  it("still refuses text over the limit while an upload is running", async () => {
    const uploads = heldUploads();
    const opts = makeOptions({ onUploadFile: uploads.fn });
    const comp = createMessageInput(opts);
    comp.mount(container);
    queueFile(container, pdf("a.pdf"));
    await vi.waitFor(() => expect(uploads.fn).toHaveBeenCalled());
    textareaOf(container).value = "x".repeat(4001);

    send(container);

    expect(opts.onSend).not.toHaveBeenCalled();
    expect(errorText(container)).toMatch(/limited to/i);
    expect(container.querySelectorAll(".attachment-preview-item")).toHaveLength(1);
    comp.destroy?.();
  });

  it("still refuses a send gated by slow mode while an upload is running", async () => {
    const uploads = heldUploads();
    const opts = makeOptions({ onUploadFile: uploads.fn });
    const comp = createMessageInput(opts);
    comp.mount(container);
    queueFile(container, pdf("a.pdf"));
    await vi.waitFor(() => expect(uploads.fn).toHaveBeenCalled());
    comp.setSendGate("Slow mode: wait 5s");
    textareaOf(container).value = "hello";

    send(container);

    expect(opts.onSend).not.toHaveBeenCalled();
    expect(errorText(container)).toContain("Slow mode");
    expect(textareaOf(container).value).toBe("hello");
    comp.destroy?.();
  });

  it("sends a plain message with no extra argument when nothing is uploading", async () => {
    const opts = makeOptions({
      onUploadFile: vi.fn(async (file: File) => ({ id: "srv-1", url: "/1", filename: file.name })),
    });
    const comp = createMessageInput(opts);
    comp.mount(container);
    queueFile(container, pdf("a.pdf"));
    await vi.waitFor(() =>
      expect(container.querySelector(".attachment-preview-item.uploading")).toBeNull(),
    );
    textareaOf(container).value = "done";

    send(container);

    expect(vi.mocked(opts.onSend).mock.calls[0]).toHaveLength(5);
    comp.destroy?.();
  });
});
