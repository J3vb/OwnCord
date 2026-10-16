import { afterEach, describe, expect, it, vi } from "vitest";
import { Disposable } from "../../lib/disposable";
import type { DraftUpload, SentAttachment } from "../../components/MessageInput";
import { messagesStore } from "../../stores/messages.store";
import { ATTACHMENT_TTL_MS } from "./attachmentTtl";
import {
  cancelQueuedSend,
  renderUploadStrip,
  retryQueuedSend,
  runQueuedSend,
  type QueueDeps,
  type QueuedItem,
  type QueuedSend,
} from "./sendQueue";

type Result = { id: string; filename: string };

/** A running upload (the composer's DraftUpload) the test settles by hand. */
function held(name: string) {
  const file = new File(["x"], name);
  const owner = new Disposable();
  let resolve!: (r: Result) => void;
  let reject!: (e: Error) => void;
  const result = new Promise<Result>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A transport that honours its signal rejects when the owner is destroyed.
  owner.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  let settledAt: number | undefined;
  let fraction: number | null = null;
  result.then(
    () => (settledAt = Date.now()),
    () => {},
  );
  const upload: DraftUpload = {
    filename: name,
    file,
    owner,
    result,
    get settledAt() {
      return settledAt;
    },
    get fraction() {
      return fraction;
    },
    onProgress: null,
    refreshing: null,
  };
  return {
    file,
    upload,
    owner,
    resolve: (id: string) => resolve({ id, filename: name }),
    reject: (message = "boom") => reject(new Error(message)),
    tick: (f: number) => {
      fraction = f;
      upload.onProgress?.(f);
    },
  };
}

function entryOf(items: QueuedItem[], extra: Partial<QueuedSend> = {}): QueuedSend {
  return {
    cid: "cid-1",
    channelId: 1,
    userId: 7,
    content: "hello",
    replyTo: null,
    replyPing: false,
    items,
    ...extra,
  };
}

/** Deps whose `upload` the test settles by hand; calls are recorded in order. */
function makeDeps() {
  const uploads: {
    file: File;
    signal: AbortSignal;
    onProgress: (f: number) => void;
    resolve: (id: string) => void;
    reject: () => void;
  }[] = [];
  const deps = {
    upload: vi.fn(
      (file: File, signal: AbortSignal, onProgress: (f: number) => void) =>
        new Promise<Result>((resolve, reject) => {
          uploads.push({
            file,
            signal,
            onProgress,
            resolve: (id) => resolve({ id, filename: file.name }),
            reject: () => reject(new Error("boom")),
          });
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    ),
    putBack: vi.fn<(files: readonly SentAttachment[]) => void>(),
    slowWindow: vi.fn<QueueDeps["slowWindow"]>(() => undefined),
    dispatch: vi.fn<(files: readonly SentAttachment[]) => void>(),
    fail: vi.fn<(code: "UPLOAD_FAILED" | "UPLOAD_CANCELLED") => void>(),
  } satisfies QueueDeps & Record<string, unknown>;
  return { deps, uploads };
}

const settled = (id: string, name: string, uploadedAt = Date.now(), file?: File): QueuedItem => ({
  filename: name,
  id,
  uploadedAt,
  ...(file === undefined ? {} : { file }),
});
const running = (h: ReturnType<typeof held>): QueuedItem => ({
  filename: h.upload.filename,
  file: h.file,
  upload: h.upload,
});
/** Let every promise continuation queued so far run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runQueuedSend", () => {
  it("dispatches once with the ids in chip order", async () => {
    const a = held("a.pdf");
    const c = held("c.pdf");
    const { deps } = makeDeps();
    const entry = entryOf([running(a), settled("srv-b", "b.pdf"), running(c)]);
    const done = runQueuedSend(entry, deps);

    // They land out of order; the files still go out in chip order.
    c.resolve("srv-c");
    await flush();
    expect(deps.dispatch).not.toHaveBeenCalled();
    a.resolve("srv-a");
    await done;

    expect(deps.dispatch).toHaveBeenCalledOnce();
    expect(deps.dispatch.mock.calls[0]![0]).toEqual([
      { id: "srv-a", filename: "a.pdf", file: a.file },
      { id: "srv-b", filename: "b.pdf" },
      { id: "srv-c", filename: "c.pdf", file: c.file },
    ]);
    expect(deps.fail).not.toHaveBeenCalled();
    expect(deps.putBack).not.toHaveBeenCalled();
  });

  it("dispatches at once when nothing is uploading", async () => {
    const { deps } = makeDeps();
    await runQueuedSend(entryOf([settled("srv-a", "a.pdf")]), deps);
    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it("fails UPLOAD_FAILED on the first rejection, destroys the rest and keeps settled ids", async () => {
    const a = held("a.pdf");
    const b = held("b.pdf");
    const c = held("c.pdf");
    const { deps } = makeDeps();
    const entry = entryOf([running(a), running(b), running(c)]);
    const done = runQueuedSend(entry, deps);

    a.resolve("srv-a");
    await flush();
    b.reject();
    await done;

    expect(deps.fail).toHaveBeenCalledOnce();
    expect(deps.fail).toHaveBeenCalledWith("UPLOAD_FAILED");
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(c.owner.signal.aborted).toBe(true);
    expect(entry.failed).toBe(true);
    // The settled id stays for Retry; the others hold no upload.
    expect(entry.items.map((i) => i.id)).toEqual(["srv-a", undefined, undefined]);
    expect(entry.items.every((i) => i.upload === undefined)).toBe(true);
  });

  it("re-uploads an id that aged past the limit while the other uploads ran, from its file", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const oldFile = new File(["x"], "old.pdf");
    const slow = held("slow.pdf");
    const { deps, uploads } = makeDeps();
    const entry = entryOf([settled("srv-old", "old.pdf", start, oldFile), running(slow)]);
    const done = runQueuedSend(entry, deps);

    vi.setSystemTime(start + ATTACHMENT_TTL_MS + 1);
    slow.resolve("srv-slow");
    await flush();
    expect(deps.upload).toHaveBeenCalledOnce();
    expect(uploads[0]!.file).toBe(oldFile);
    expect(deps.dispatch).not.toHaveBeenCalled();
    uploads[0]!.resolve("srv-new");
    await done;

    expect(deps.dispatch.mock.calls[0]![0]).toEqual([
      { id: "srv-new", filename: "old.pdf", file: oldFile },
      { id: "srv-slow", filename: "slow.pdf", file: slow.file },
    ]);
    expect(deps.upload).toHaveBeenCalledOnce();
  });

  it("puts an aged id with no file back to the composer and dispatches the rest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const slow = held("slow.pdf");
    const { deps } = makeDeps();
    const entry = entryOf([settled("srv-old", "old.pdf", start), running(slow)]);
    const done = runQueuedSend(entry, deps);

    vi.setSystemTime(start + ATTACHMENT_TTL_MS + 1);
    slow.resolve("srv-slow");
    await done;

    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.putBack).toHaveBeenCalledWith([{ id: "srv-old", filename: "old.pdf" }]);
    expect(deps.dispatch.mock.calls[0]![0]).toEqual([
      { id: "srv-slow", filename: "slow.pdf", file: slow.file },
    ]);
  });
});

describe("cancelQueuedSend", () => {
  it("aborts every signal and fails the send UPLOAD_CANCELLED", async () => {
    const a = held("a.pdf");
    const b = held("b.pdf");
    const { deps } = makeDeps();
    const entry = entryOf([running(a), running(b)]);
    const done = runQueuedSend(entry, deps);

    cancelQueuedSend(entry);
    await done;

    expect(a.owner.signal.aborted).toBe(true);
    expect(b.owner.signal.aborted).toBe(true);
    expect(deps.fail).toHaveBeenCalledOnce();
    expect(deps.fail).toHaveBeenCalledWith("UPLOAD_CANCELLED");
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it("ends the wait even when the transport ignores its signal", async () => {
    const a = held("a.pdf");
    // A transport that never rejects on abort: only the owner's signal tells us.
    const stubborn: QueuedItem = {
      filename: "a.pdf",
      file: a.file,
      upload: { ...a.upload, result: new Promise<Result>(() => {}) },
    };
    const { deps } = makeDeps();
    const entry = entryOf([stubborn]);
    const done = runQueuedSend(entry, deps);

    cancelQueuedSend(entry);
    await done;

    expect(deps.fail).toHaveBeenCalledWith("UPLOAD_CANCELLED");
  });
});

describe("retryQueuedSend", () => {
  it("re-uploads only the items without a fresh id", async () => {
    const { deps, uploads } = makeDeps();
    const fileB = new File(["x"], "b.pdf");
    const fileC = new File(["x"], "c.pdf");
    const entry = entryOf(
      [
        settled("srv-a", "a.pdf"),
        { filename: "b.pdf", file: fileB },
        {
          filename: "c.pdf",
          file: fileC,
          id: "srv-stale",
          uploadedAt: Date.now() - 2 * ATTACHMENT_TTL_MS,
        },
      ],
      { failed: true },
    );
    const done = retryQueuedSend(entry, deps);

    expect(deps.upload).toHaveBeenCalledTimes(2);
    expect(uploads.map((u) => u.file)).toEqual([fileB, fileC]);
    expect(entry.failed).toBe(false);
    uploads[1]!.resolve("srv-c2");
    uploads[0]!.resolve("srv-b2");
    await done;

    expect(deps.dispatch.mock.calls[0]![0]).toEqual([
      { id: "srv-a", filename: "a.pdf" },
      { id: "srv-b2", filename: "b.pdf", file: fileB },
      { id: "srv-c2", filename: "c.pdf", file: fileC },
    ]);
  });

  it("gives each re-upload an owner of its own, and Cancel then aborts it", async () => {
    const { deps, uploads } = makeDeps();
    const entry = entryOf([{ filename: "b.pdf", file: new File(["x"], "b.pdf") }], {
      failed: true,
      cancelled: true,
    });
    const done = retryQueuedSend(entry, deps);

    expect(entry.cancelled).toBe(false);
    expect(uploads[0]!.signal.aborted).toBe(false);
    cancelQueuedSend(entry);
    await done;

    expect(uploads[0]!.signal.aborted).toBe(true);
    expect(deps.fail).toHaveBeenCalledWith("UPLOAD_CANCELLED");
  });

  it("puts an item with neither a fresh id nor a file back to the composer", async () => {
    const { deps } = makeDeps();
    const entry = entryOf(
      [
        settled("srv-a", "a.pdf"),
        { filename: "gone.pdf", id: "srv-gone", uploadedAt: Date.now() - 2 * ATTACHMENT_TTL_MS },
      ],
      { failed: true },
    );
    await retryQueuedSend(entry, deps);

    expect(deps.upload).not.toHaveBeenCalled();
    expect(deps.putBack).toHaveBeenCalledWith([{ id: "srv-gone", filename: "gone.pdf" }]);
    expect(deps.dispatch.mock.calls[0]![0]).toEqual([{ id: "srv-a", filename: "a.pdf" }]);
  });

  it("keeps waiting on an upload that is still running", async () => {
    const a = held("a.pdf");
    const { deps } = makeDeps();
    const entry = entryOf([running(a)], { failed: true });
    const done = retryQueuedSend(entry, deps);

    expect(deps.upload).not.toHaveBeenCalled();
    a.resolve("srv-a");
    await done;

    expect(deps.dispatch.mock.calls[0]![0]).toEqual([
      { id: "srv-a", filename: "a.pdf", file: a.file },
    ]);
  });
});

describe("renderUploadStrip", () => {
  it("shows a chip per file with its progress and one Cancel while it runs", () => {
    const a = held("a.pdf");
    const entry = entryOf([running(a), settled("srv-b", "b.pdf")]);
    const strip = renderUploadStrip(entry, new AbortController().signal);

    expect(strip.className).toBe("msg-upload-strip");
    expect(strip.getAttribute("role")).toBe("group");
    expect(strip.getAttribute("aria-label")).toBe("Uploading 2 files");
    const chips = strip.querySelectorAll(".msg-upload-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]!.querySelector("span")!.textContent).toBe("a.pdf");
    const bars = strip.querySelectorAll("progress");
    // Indeterminate until the first tick (no value attribute); a settled file is full.
    expect(bars[0]!.hasAttribute("value")).toBe(false);
    expect(bars[1]!.value).toBe(1);
    const cancel = strip.querySelectorAll("button.msg-upload-cancel");
    expect(cancel).toHaveLength(1);
    expect(cancel[0]!.getAttribute("data-testid")).toBe("msg-upload-cancel-cid-1");
    expect(cancel[0]!.textContent).toBe("Cancel upload");
  });

  it("starts a chip at the progress the upload last reported", () => {
    const a = held("a.pdf");
    a.tick(0.4);
    const strip = renderUploadStrip(entryOf([running(a)]), new AbortController().signal);
    expect(strip.querySelector("progress")!.value).toBeCloseTo(0.4);
  });

  it("names a single file in the singular", () => {
    const strip = renderUploadStrip(
      entryOf([running(held("a.pdf"))]),
      new AbortController().signal,
    );
    expect(strip.getAttribute("aria-label")).toBe("Uploading 1 file");
  });

  it("updates <progress> on each tick and never writes the message store", async () => {
    const a = held("a.pdf");
    const b = held("b.pdf");
    const { deps } = makeDeps();
    const entry = entryOf([running(a), running(b)]);
    void runQueuedSend(entry, deps);
    const strip = renderUploadStrip(entry, new AbortController().signal);
    const setState = vi.spyOn(messagesStore, "setState");
    const bars = strip.querySelectorAll("progress");

    a.tick(0.25);
    b.tick(0.5);
    a.tick(0.75);

    expect(bars[0]!.value).toBeCloseTo(0.75);
    expect(bars[1]!.value).toBeCloseTo(0.5);
    expect(setState).not.toHaveBeenCalled();
    a.resolve("srv-a");
    await flush();
    expect(bars[0]!.value).toBe(1);
    expect(setState).not.toHaveBeenCalled();
  });

  it("stops observing when the row's signal aborts", () => {
    const a = held("a.pdf");
    const { deps } = makeDeps();
    const entry = entryOf([running(a)]);
    void runQueuedSend(entry, deps);
    const rowOwner = new AbortController();
    const strip = renderUploadStrip(entry, rowOwner.signal);
    const bar = strip.querySelector("progress")!;
    expect(entry.listeners?.size ?? 0).toBe(1);

    rowOwner.abort();
    a.tick(0.9);

    expect(entry.listeners?.size ?? 0).toBe(0);
    expect(bar.hasAttribute("value")).toBe(false);
  });

  it("does not observe at all for a row already torn down", () => {
    const rowOwner = new AbortController();
    rowOwner.abort();
    const entry = entryOf([running(held("a.pdf"))]);
    renderUploadStrip(entry, rowOwner.signal);
    expect(entry.listeners?.size ?? 0).toBe(0);
  });

  it("Cancel stops the uploads", async () => {
    const a = held("a.pdf");
    const { deps } = makeDeps();
    const entry = entryOf([running(a)]);
    const done = runQueuedSend(entry, deps);
    const strip = renderUploadStrip(entry, new AbortController().signal);

    (strip.querySelector(".msg-upload-cancel") as HTMLButtonElement).click();
    await done;

    expect(a.owner.signal.aborted).toBe(true);
    expect(deps.fail).toHaveBeenCalledWith("UPLOAD_CANCELLED");
  });

  it("shows only the chips, with no progress and no Cancel, once the send failed", () => {
    const strip = renderUploadStrip(
      entryOf([settled("srv-a", "a.pdf"), { filename: "b.pdf" }], { failed: true }),
      new AbortController().signal,
    );

    expect(strip.querySelectorAll(".msg-upload-chip span")).toHaveLength(2);
    expect(strip.querySelector("progress")).toBeNull();
    expect(strip.querySelector("button")).toBeNull();
    expect(strip.hasAttribute("aria-label")).toBe(false);
  });
});

const describedBy = (strip: HTMLElement) =>
  strip.querySelector(".msg-upload-cancel")!.getAttribute("aria-describedby");

describe("review follow-ups", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("moves focus to the new Retry button when Cancel had it", async () => {
    const a = held("a.pdf");
    const { deps } = makeDeps();
    const entry = entryOf([running(a)]);
    const strip = renderUploadStrip(entry, new AbortController().signal);
    document.body.appendChild(strip);
    // The host replaces the strip with the failed row's Retry when the send fails.
    deps.fail.mockImplementation(() => {
      const retry = document.createElement("button");
      retry.dataset.testid = "msg-retry-cid-1";
      strip.replaceWith(retry);
    });
    const done = runQueuedSend(entry, deps);
    const cancel = strip.querySelector<HTMLButtonElement>(".msg-upload-cancel")!;
    cancel.focus();

    cancel.click();
    await done;

    expect(document.activeElement).toBe(document.querySelector('[data-testid="msg-retry-cid-1"]'));
  });

  it("leaves focus alone when Cancel did not have it", async () => {
    const a = held("a.pdf");
    const { deps } = makeDeps();
    const entry = entryOf([running(a)]);
    const strip = renderUploadStrip(entry, new AbortController().signal);
    document.body.appendChild(strip);
    const other = document.createElement("input");
    document.body.appendChild(other);
    deps.fail.mockImplementation(() => {
      const retry = document.createElement("button");
      retry.dataset.testid = "msg-retry-cid-1";
      document.body.appendChild(retry);
    });
    const done = runQueuedSend(entry, deps);
    other.focus();

    cancelQueuedSend(entry);
    await done;

    expect(document.activeElement).toBe(other);
  });

  it("describes each Cancel by its row's text and its own chips", () => {
    const one = renderUploadStrip(
      entryOf([running(held("a.pdf"))], { cid: "x1" }),
      new AbortController().signal,
    );
    const two = renderUploadStrip(
      entryOf([running(held("b.pdf"))], { cid: "x2" }),
      new AbortController().signal,
    );
    expect(describedBy(one)).toBe("msg-body-x1");
    expect(describedBy(two)).toBe("msg-body-x2");
    expect(one.id).toBe("msg-upload-strip-x1");
  });

  it("waits out the slow-mode window before dispatching", async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    const now = Date.now();
    deps.slowWindow.mockReturnValue({ sentAt: now, window: 5 });
    const done = runQueuedSend(
      entryOf([{ filename: "a.pdf", id: "srv-a", uploadedAt: now }]),
      deps,
    );

    await vi.advanceTimersByTimeAsync(4000);
    expect(deps.dispatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1100);
    await done;

    expect(deps.dispatch).toHaveBeenCalledOnce();
  });

  it("Cancel ends the slow-mode wait with UPLOAD_CANCELLED", async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    const now = Date.now();
    deps.slowWindow.mockReturnValue({ sentAt: now, window: 60 });
    const entry = entryOf([{ filename: "a.pdf", id: "srv-a", uploadedAt: now }]);
    const done = runQueuedSend(entry, deps);
    await vi.advanceTimersByTimeAsync(1000);

    cancelQueuedSend(entry);
    await vi.advanceTimersByTimeAsync(300);
    await done;

    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(deps.fail).toHaveBeenCalledWith("UPLOAD_CANCELLED");
  });
});
