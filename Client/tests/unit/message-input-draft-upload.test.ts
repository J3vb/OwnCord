// An upload still running when the user switches channel keeps going in the
// channel's draft, and the composer that restores the draft shows it again and
// sends its id once it finishes (WP 2A-10).
import { describe, it, expect, vi } from "vitest";

import * as mocks from "../helpers/messageInputMocks";
vi.mock("@components/EmojiPicker", () => mocks.emojiPickerMock());
vi.mock("@components/GifPicker", () => mocks.gifPickerMock());

import { createMessageInput } from "@components/MessageInput";
import { useMountContainer } from "../helpers/mountContainer";
import {
  clickSend,
  controlledUpload,
  makeOptions,
  pdfFile,
  queueFile,
  type UploadResult,
} from "../helpers/messageInputHarness";

type Opts = ReturnType<typeof makeOptions>;

/** Starts an upload in a composer, then leaves the channel: returns its handler, options and draft. */
async function leaveMidUpload(container: HTMLElement, file: File) {
  const up = controlledUpload();
  const opts = makeOptions({ onUploadFile: up.fn });
  const first = createMessageInput(opts);
  first.mount(container);
  queueFile(container, file);
  await vi.waitFor(() => expect(up.fn).toHaveBeenCalled());
  const draft = first.getDraft();
  first.destroy?.();
  return { up, opts, draft };
}

/** A fresh composer that restores `draft`, as when the user returns to the channel. */
function returnToChannel(
  container: HTMLElement,
  opts: Opts,
  draft: ReturnType<ReturnType<typeof createMessageInput>["getDraft"]>,
) {
  const next = createMessageInput(opts);
  next.mount(container);
  next.restoreDraft(draft);
  return next;
}

describe("MessageInput upload in flight across a channel switch", () => {
  let container: HTMLDivElement;
  useMountContainer((mounted) => {
    container = mounted;
  });

  it("keeps the upload running and finishes it on the restored chip", async () => {
    const { up, opts, draft } = await leaveMidUpload(
      container,
      new File(["x"], "big.zip", { type: "application/zip" }),
    );
    expect(up.signal()!.aborted).toBe(false);

    const next = returnToChannel(container, opts, draft);
    const chip = container.querySelector(".attachment-preview-item") as HTMLDivElement;
    expect(chip.classList.contains("uploading")).toBe(true);
    expect(chip.textContent).toContain("big.zip");

    up.progress(0.5);
    expect((chip.querySelector("progress") as HTMLProgressElement).value).toBeCloseTo(0.5);

    // (Send here no longer refuses: 3A-9 queues it, see message-input-send-queue.test.ts.)
    up.resolve({ id: "srv-7", url: "/f/7", filename: "big.zip" });
    await vi.waitFor(() => expect(chip.classList.contains("uploading")).toBe(false));
    (container.querySelector(".msg-textarea") as HTMLTextAreaElement).value = "done";
    clickSend(container);
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
    const { up, opts, draft } = await leaveMidUpload(container, pdfFile("doc.pdf"));

    up.resolve({ id: "srv-9", url: "/f/9", filename: "doc.pdf" });
    await Promise.resolve();

    const next = returnToChannel(container, opts, draft);
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    clickSend(container);
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
    const { up, opts, draft } = await leaveMidUpload(container, pdfFile("doc.pdf"));

    up.reject(new Error("disk full"));
    await Promise.resolve();

    const next = returnToChannel(container, opts, draft);
    await vi.waitFor(() =>
      expect(container.querySelector(".attachment-upload-error")?.textContent).toMatch(/disk full/),
    );
    expect(container.querySelectorAll(".attachment-preview-item").length).toBe(0);
    next.destroy?.();
  });

  it("removing the restored chip cancels the upload", async () => {
    const { up, opts, draft } = await leaveMidUpload(
      container,
      new File(["x"], "big.zip", { type: "application/zip" }),
    );

    const next = returnToChannel(container, opts, draft);
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
      queueFile(container, pdfFile("a.pdf"));
      await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());

      vi.setSystemTime(Date.now() + 51 * 60 * 1000);
      clickSend(container);
      expect(onUploadFile).toHaveBeenCalledTimes(2);
      const draft = first.getDraft();
      first.destroy?.();

      const next = returnToChannel(container, opts, draft);
      failRefresh(new Error("network down"));
      await vi.waitFor(() =>
        expect(container.querySelector(".attachment-upload-error")?.textContent).toMatch(
          /network down/,
        ),
      );
      expect(container.querySelectorAll(".attachment-preview-item").length).toBe(1);
      expect(container.querySelector(".uploading")).toBeNull();

      clickSend(container);
      expect(opts.onSend).not.toHaveBeenCalled();
      expect(onUploadFile).toHaveBeenCalledTimes(3);
      await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
      vi.setSystemTime(Date.now() + 1000);
      clickSend(container);
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
