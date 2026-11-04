import { vi, beforeEach } from "vitest";
import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";
import { resetPickerCaptures } from "./messageInputMocks";
import { useMountContainer } from "./mountContainer";
import type { GifApi, GifFavoritesApi } from "@lib/media/gifProvider";

/** GIF endpoints on the user's own server (never api.klipy.com). */
export const stubGifApi: GifApi & GifFavoritesApi = {
  gifSearch: vi.fn(async () => ({ results: [] })),
  gifTrending: vi.fn(async () => ({ results: [] })),
  gifFavorites: vi.fn(async () => ({ favorites: [] })),
  addGifFavorite: vi.fn(async () => undefined),
  removeGifFavorite: vi.fn(async () => undefined),
};

export function makeOptions(overrides: Partial<MessageInputOptions> = {}): MessageInputOptions {
  return {
    channelId: 1,
    channelName: "general",
    gifApi: stubGifApi,
    onSend: vi.fn(),
    onTyping: vi.fn(),
    ...overrides,
  };
}

/** Gives each test a fresh container and clears the picker captures. */
export function useMessageInputContainer(bind: (container: HTMLDivElement) => void): void {
  beforeEach(() => {
    resetPickerCaptures();
  });
  useMountContainer(bind);
}

/** Creates a MessageInput from the given overrides and mounts it into the container. */
export function mountMessageInput(
  container: HTMLDivElement,
  overrides: Partial<MessageInputOptions> = {},
): { opts: MessageInputOptions; comp: ReturnType<typeof createMessageInput> } {
  const opts = makeOptions(overrides);
  const comp = createMessageInput(opts);
  comp.mount(container);
  return { opts, comp };
}

/** Picks files through the hidden file input, as the browser would. */
export function selectFiles(container: HTMLElement, files: File[]): void {
  const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(fileInput, "files", { value: files, writable: true, configurable: true });
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Picks one file through the hidden file input. */
export function queueFile(container: HTMLElement, file: File): void {
  selectFiles(container, [file]);
}

/** Pastes one file into the composer textarea. jsdom has no ClipboardEvent, so a plain Event carries the data. */
export function pasteFile(container: HTMLElement, file: File): void {
  const textarea = container.querySelector(".msg-textarea") as HTMLTextAreaElement;
  const pasteEvent = new Event("paste", { bubbles: true });
  Object.defineProperty(pasteEvent, "clipboardData", {
    value: { items: [{ kind: "file", type: file.type, getAsFile: () => file }] },
  });
  textarea.dispatchEvent(pasteEvent);
}

/** Clicks the composer's send button. */
export function clickSend(container: HTMLElement): void {
  (container.querySelector(".send-btn") as HTMLButtonElement).click();
}

/** The composer's attachment upload error text, or "" when none shows. */
export function attachmentErrorText(container: HTMLElement): string {
  return container.querySelector(".attachment-upload-error")?.textContent ?? "";
}

/** A small PDF fixture with the given file name. */
export function pdfFile(name: string): File {
  return new File(["x"], name, { type: "application/pdf" });
}

type Uploaded = { id: string; url: string; filename: string };

/** Mounts a composer whose uploads resolve at once with sequential srv-N ids. */
export function mountUploadingComposer(container: HTMLElement): {
  comp: ReturnType<typeof createMessageInput>;
  uploads: File[];
  onUploadFile: ReturnType<typeof vi.fn>;
  onDiscardUpload: ReturnType<typeof vi.fn>;
  onSend: ReturnType<typeof vi.fn>;
} {
  let n = 0;
  const uploads: File[] = [];
  const onUploadFile = vi.fn(async (file: File): Promise<Uploaded> => {
    uploads.push(file);
    n += 1;
    return { id: `srv-${n}`, url: `/f/${n}`, filename: file.name };
  });
  const onDiscardUpload = vi.fn(async () => {});
  const onSend = vi.fn();
  const comp = createMessageInput(makeOptions({ onSend, onUploadFile, onDiscardUpload }));
  comp.mount(container);
  return { comp, uploads, onUploadFile, onDiscardUpload, onSend };
}

/** A file just over the 100 MB upload limit. */
export function makeOversizedFile(): File {
  const bigFile = new File(["x"], "huge.bin", { type: "application/octet-stream" });
  Object.defineProperty(bigFile, "size", { value: 101 * 1024 * 1024 });
  return bigFile;
}

export type UploadResult = { id: string; url: string; filename: string };

/** An upload handler whose single call the test settles by hand. */
export function controlledUpload() {
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
