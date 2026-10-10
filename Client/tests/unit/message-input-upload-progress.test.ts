// Per-attachment determinate upload progress (B11b). The composer shows a
// percentage and a fill for each chip while its upload is in flight, driven by
// the `onProgress` callback the upload handler reports.
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

function makeOptions(overrides: Partial<MessageInputOptions> = {}): MessageInputOptions {
  return {
    channelId: 1,
    channelName: "general",
    gifApi: stubGifApi,
    onSend: vi.fn(),
    onTyping: vi.fn(),
    onEditMessage: vi.fn(),
    ...overrides,
  };
}

function queueFile(container: HTMLElement, file: File): void {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { value: [file], writable: true });
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("MessageInput upload progress", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("shows determinate progress from a progress callback while the upload runs", async () => {
    let report: ((fraction: number) => void) | null = null;
    let finish: (r: { id: string; url: string; filename: string }) => void = () => {};
    const onUploadFile = vi.fn(
      (_file: File, _signal?: AbortSignal, onProgress?: (fraction: number) => void) => {
        report = onProgress ?? null;
        return new Promise<{ id: string; url: string; filename: string }>((resolve) => {
          finish = resolve;
        });
      },
    );
    const comp = createMessageInput(makeOptions({ onUploadFile }));
    comp.mount(container);

    queueFile(container, new File(["x"], "a.png", { type: "image/png" }));
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalled());

    report!(0.25);
    const bar = container.querySelector("progress") as HTMLProgressElement;
    await vi.waitFor(() => expect(bar?.value).toBeCloseTo(0.25));

    finish({ id: "srv-1", url: "/f/1", filename: "a.png" });
    await vi.waitFor(() => expect(container.querySelector(".uploading")).toBeNull());
    comp.destroy?.();
  });

  it("keeps the bar indeterminate until the first progress tick", async () => {
    const onUploadFile = vi.fn(() => new Promise<never>(() => {}));
    const comp = createMessageInput(makeOptions({ onUploadFile }));
    comp.mount(container);

    queueFile(container, new File(["x"], "a.png", { type: "image/png" }));
    await vi.waitFor(() => expect(onUploadFile).toHaveBeenCalled());
    const bar = container.querySelector("progress") as HTMLProgressElement;
    expect(bar).not.toBeNull();
    // No `value` attribute is what makes a <progress> indeterminate.
    expect(bar.hasAttribute("value")).toBe(false);
    comp.destroy?.();
  });
});
