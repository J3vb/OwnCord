// Composer attachment chips: a picture the webview can draw shows its preview;
// one it cannot (HEIC, TIFF, a type that fails to decode) shows the file chip
// instead of a broken-image icon.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));

import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";
import type { GifApi, GifFavoritesApi } from "@lib/gifProvider";

const stubGifApi: GifApi & GifFavoritesApi = {
  gifSearch: vi.fn(async () => ({ results: [] })),
  gifTrending: vi.fn(async () => ({ results: [] })),
  gifFavorites: vi.fn(async () => ({ favorites: [] })),
  addGifFavorite: vi.fn(async () => undefined),
  removeGifFavorite: vi.fn(async () => undefined),
};

type Uploaded = { id: string; url: string; filename: string };

function setup(container: HTMLElement) {
  let n = 0;
  const uploads: File[] = [];
  const onUploadFile = vi.fn(async (file: File): Promise<Uploaded> => {
    uploads.push(file);
    n += 1;
    return { id: `srv-${n}`, url: `/f/${n}`, filename: file.name };
  });
  const onDiscardUpload = vi.fn(async () => {});
  const onSend = vi.fn();
  const options: MessageInputOptions = {
    channelId: 1,
    channelName: "general",
    gifApi: stubGifApi,
    onSend,
    onTyping: vi.fn(),
    onUploadFile,
    onDiscardUpload,
  };
  const comp = createMessageInput(options);
  comp.mount(container);
  return { comp, uploads, onUploadFile, onDiscardUpload, onSend };
}

function queueFile(container: HTMLElement, file: File): void {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { value: [file], writable: true });
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("MessageInput attachment preview", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });
  afterEach(() => container.remove());

  it("previews a PNG from its own bytes", async () => {
    const { comp } = setup(container);
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
    const { comp } = setup(container);
    queueFile(container, new File(["x"], name, { type }));
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    expect(container.querySelector(".attachment-preview-img")).toBeNull();
    expect(container.querySelector(".attachment-preview-file")).not.toBeNull();
    expect(container.querySelector(".attachment-preview-name")?.textContent).toBe(name);
    comp.destroy?.();
  });

  it("swaps an image that fails to decode for the file chip", async () => {
    const { comp } = setup(container);
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
});
