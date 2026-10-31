// Composer attachment chips: a picture the webview can draw shows its preview;
// one it cannot (HEIC, TIFF, a type that fails to decode) shows the file chip
// instead of a broken-image icon.
import { describe, it, expect, vi } from "vitest";

import * as mocks from "../helpers/messageInputMocks";
vi.mock("@components/EmojiPicker", () => mocks.emojiPickerMock());
vi.mock("@components/GifPicker", () => mocks.gifPickerMock());

import {
  mountUploadingComposer,
  queueFile,
  useMessageInputContainer,
} from "../helpers/messageInputHarness";

describe("MessageInput attachment preview", () => {
  let container: HTMLDivElement;
  useMessageInputContainer((el) => {
    container = el;
  });

  it("previews a PNG from its own bytes", async () => {
    const { comp } = mountUploadingComposer(container);
    queueFile(container, new File(["x"], "cat.png", { type: "image/png" }));
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLImageElement>(".attachment-preview-img")?.src).toMatch(
        /^data:image\/png/,
      ),
    );
    expect(container.querySelector(".attachment-preview-file")).toBeNull();
    comp.destroy?.();
  });

  it.each([
    ["IMG_0013(1).heic", "image/heic"],
    ["photo.heif", "image/heif"],
    ["scan.tiff", "image/tiff"],
  ])("shows %s as a file chip, not an image", async (name, type) => {
    const { comp } = mountUploadingComposer(container);
    queueFile(container, new File(["x"], name, { type }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    expect(container.querySelector(".attachment-preview-img")).toBeNull();
    expect(container.querySelector(".attachment-preview-file")).not.toBeNull();
    expect(container.querySelector(".attachment-preview-name")?.textContent).toBe(name);
    comp.destroy?.();
  });

  it("swaps an image that fails to decode for the file chip", async () => {
    const { comp } = mountUploadingComposer(container);
    queueFile(container, new File(["x"], "raw.dng", { type: "image/x-adobe-dng" }));
    const img = await vi.waitFor(() => {
      const el = container.querySelector<HTMLImageElement>(".attachment-preview-img");
      expect(el?.src).toMatch(/^data:/);
      return el!;
    });
    img.dispatchEvent(new Event("error"));
    expect(container.querySelector(".attachment-preview-img")).toBeNull();
    expect(container.querySelector(".attachment-preview-file")).not.toBeNull();
    expect(container.querySelector(".attachment-preview-name")?.textContent).toBe("raw.dng");
    expect(container.querySelector('[data-testid="attachment-remove"]')).not.toBeNull();
    comp.destroy?.();
  });

  it("keeps a picture's preview when its draft is restored", async () => {
    const { comp } = mountUploadingComposer(container);
    const file = new File(["x"], "cat.png", { type: "image/png" });
    comp.restoreDraft({
      content: "",
      replyTo: null,
      attachments: [{ id: "srv-9", filename: "cat.png", uploadedAt: Date.now(), file }],
    });
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLImageElement>(".attachment-preview-img")?.src).toMatch(
        /^data:image\/png/,
      ),
    );
    comp.destroy?.();
  });

  it("restores a HEIC or a chip without its file as the file chip", () => {
    const { comp } = mountUploadingComposer(container);
    comp.restoreDraft({
      content: "",
      replyTo: null,
      attachments: [
        {
          id: "srv-1",
          filename: "IMG_1.heic",
          uploadedAt: Date.now(),
          file: new File(["x"], "IMG_1.heic", { type: "image/heic" }),
        },
        { id: "srv-2", filename: "dog.png", uploadedAt: Date.now() },
      ],
    });
    expect(container.querySelector(".attachment-preview-img")).toBeNull();
    expect(
      [...container.querySelectorAll(".attachment-preview-name")].map((e) => e.textContent),
    ).toEqual(["IMG_1.heic", "dog.png"]);
    comp.destroy?.();
  });
});
