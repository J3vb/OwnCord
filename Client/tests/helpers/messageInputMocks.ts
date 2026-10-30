import { vi } from "vitest";

/** Captured emoji picker callbacks so tests can simulate selection. */
export let lastEmojiPickerOptions: {
  onSelect: (emoji: string, select?: { keepOpen: boolean }) => void;
  onClose: () => void;
} | null = null;

/** Captured GIF picker callbacks so tests can simulate selection. */
export type CapturedGifPickerOptions = {
  onSelect: (url: string) => void;
  onClose: () => void;
  onUnavailable?: (reason: string) => void;
};

export let lastGifPickerOptions: CapturedGifPickerOptions | null = null;

export function emojiPickerMock() {
  return {
    createEmojiPicker: (opts: NonNullable<typeof lastEmojiPickerOptions>) => {
      lastEmojiPickerOptions = opts;
      const element = document.createElement("div");
      element.classList.add("emoji-picker");
      return { element, destroy: vi.fn() };
    },
  };
}

export function gifPickerMock() {
  return {
    createGifPicker: (opts: CapturedGifPickerOptions) => {
      lastGifPickerOptions = opts;
      const element = document.createElement("div");
      element.classList.add("gif-picker");
      return { element, destroy: vi.fn() };
    },
  };
}

export function resetPickerCaptures(): void {
  lastEmojiPickerOptions = null;
  lastGifPickerOptions = null;
}
