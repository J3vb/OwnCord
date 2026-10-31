// Composer "Mark as spoiler" toggle (6.12): the staged file is renamed with the
// SPOILER_ prefix and uploaded again under that name.
import { describe, it, expect, vi } from "vitest";

import * as mocks from "../helpers/messageInputMocks";
vi.mock("@components/EmojiPicker", () => mocks.emojiPickerMock());
vi.mock("@components/GifPicker", () => mocks.gifPickerMock());

import {
  mountMessageInput,
  mountUploadingComposer,
  queueFile,
  useMessageInputContainer,
} from "../helpers/messageInputHarness";

type Uploaded = { id: string; url: string; filename: string };

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const toggle = (c: HTMLElement): HTMLButtonElement =>
  c.querySelector<HTMLButtonElement>('[data-testid="attachment-spoiler"]')!;

describe("MessageInput spoiler toggle", () => {
  let container: HTMLDivElement;
  useMessageInputContainer((el) => {
    container = el;
  });

  it("renames the staged file, uploads it again and withdraws the first copy", async () => {
    const { comp, uploads, onDiscardUpload, onSend } = mountUploadingComposer(container);
    queueFile(container, new File(["x"], "cat.png", { type: "image/png" }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    expect(toggle(container).getAttribute("aria-pressed")).toBe("false");

    toggle(container).click();
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    expect(uploads[1]!.name).toBe("SPOILER_cat.png");
    expect(uploads[1]!.type).toBe("image/png");
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    await vi.waitFor(() => expect(onDiscardUpload).toHaveBeenCalledWith("srv-1"));
    expect(toggle(container).getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector(".attachment-preview-img")?.getAttribute("alt")).toBe(
      "SPOILER_cat.png",
    );

    // Only the renamed upload is sent.
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "hi";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSend).toHaveBeenCalled();
    expect(onSend.mock.calls[0]![2]).toEqual(["srv-2"]);
    comp.destroy?.();
  });

  it("toggling twice returns the original name", async () => {
    const { comp, uploads } = mountUploadingComposer(container);
    queueFile(container, new File(["x"], "cat.png", { type: "image/png" }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    toggle(container).click();
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    toggle(container).click();
    await vi.waitFor(() => expect(uploads).toHaveLength(3));
    expect(uploads[2]!.name).toBe("cat.png");
    expect(toggle(container).getAttribute("aria-pressed")).toBe("false");
    comp.destroy?.();
  });

  it("shows a file already named SPOILER_x as marked, and un-marking strips it once", async () => {
    const { comp, uploads } = mountUploadingComposer(container);
    queueFile(container, new File(["x"], "SPOILER_x.png", { type: "image/png" }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    expect(toggle(container).getAttribute("aria-pressed")).toBe("true");

    toggle(container).click();
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    expect(uploads[1]!.name).toBe("x.png");
    expect(toggle(container).getAttribute("aria-pressed")).toBe("false");
    comp.destroy?.();
  });

  it("cancels a running upload instead of withdrawing a copy that does not exist", async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const names: string[] = [];
    const onUploadFile = vi.fn((file: File, signal?: AbortSignal) => {
      signals.push(signal);
      names.push(file.name);
      return new Promise<Uploaded>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
        if (names.length === 2) resolve({ id: "srv-b", url: "/f/b", filename: file.name });
      });
    });
    const onDiscardUpload = vi.fn(async () => {});
    const { comp } = mountMessageInput(container, { onUploadFile, onDiscardUpload });
    queueFile(container, new File(["x"], "a.png", { type: "image/png" }));
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(1));

    toggle(container).click();
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(2));
    expect(signals[0]!.aborted).toBe(true);
    expect(names[1]).toBe("SPOILER_a.png");
    expect(onDiscardUpload).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    expect(container.querySelectorAll(".attachment-preview-item")).toHaveLength(1);
    comp.destroy?.();
  });

  it("keeps the chip, and the old copy, when the re-upload fails", async () => {
    let calls = 0;
    const onUploadFile = vi.fn(async (file: File): Promise<Uploaded> => {
      calls += 1;
      if (calls === 2) throw new Error("boom");
      return { id: `srv-${calls}`, url: `/f/${calls}`, filename: file.name };
    });
    const onDiscardUpload = vi.fn(async () => {});
    const onSend = vi.fn();
    const { comp } = mountMessageInput(container, { onSend, onUploadFile, onDiscardUpload });
    queueFile(container, new File(["x"], "cat.png", { type: "image/png" }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());

    toggle(container).click();
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    await flush();
    expect(container.querySelectorAll(".attachment-preview-item")).toHaveLength(1);
    expect(container.querySelector(".attachment-upload-error-text")?.textContent).toContain("boom");
    // The old copy is not withdrawn: nothing replaced it.
    expect(onDiscardUpload).not.toHaveBeenCalled();
    comp.destroy?.();
  });

  it("a double toggle does not race: the id sent is the last upload's", async () => {
    const resolvers: ((r: Uploaded) => void)[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const names: string[] = [];
    const onUploadFile = vi.fn((file: File, signal?: AbortSignal) => {
      signals.push(signal);
      names.push(file.name);
      return new Promise<Uploaded>((resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
        resolvers.push((r) => resolve(r));
      });
    });
    const onDiscardUpload = vi.fn(async () => {});
    const onSend = vi.fn();
    const { comp } = mountMessageInput(container, { onSend, onUploadFile, onDiscardUpload });
    queueFile(container, new File(["x"], "a.png", { type: "image/png" }));
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(1));
    resolvers[0]!({ id: "srv-a", url: "/f/a", filename: "a.png" });
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());

    toggle(container).click(); // SPOILER_a.png, upload 2 in flight
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(2));
    toggle(container).click(); // back to a.png, upload 2 cancelled
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalledTimes(3));
    expect(signals[1]!.aborted).toBe(true);
    expect(names).toEqual(["a.png", "SPOILER_a.png", "a.png"]);
    // Nothing is withdrawn while a replacement is still on its way.
    expect(onDiscardUpload).not.toHaveBeenCalled();

    resolvers[2]!({ id: "srv-b", url: "/f/b", filename: "a.png" });
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    await vi.waitFor(() => expect(onDiscardUpload).toHaveBeenCalledWith("srv-a"));
    expect(onDiscardUpload).toHaveBeenCalledTimes(1);

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    textarea.value = "hi";
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSend.mock.calls[0]![2]).toEqual(["srv-b"]);
    comp.destroy?.();
  });
});
