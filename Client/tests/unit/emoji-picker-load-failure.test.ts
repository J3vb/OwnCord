/**
 * C44: a failed load of the Unicode emoji set says so, with a Retry, instead of
 * reading as "No emoji found". The loader is stubbed so its first call rejects
 * and the next one goes to the real loader.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const { loadMock } = vi.hoisted(() => ({ loadMock: vi.fn() }));

vi.mock("../../src/features/messaging/emojiCatalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/features/messaging/emojiCatalog")>();
  return { ...actual, loadEmojiCatalog: loadMock };
});

import { createEmojiPicker } from "@components/EmojiPicker";
import { emojiCatalog } from "../../src/features/messaging/emojiCatalog";
import { clearCustomEmoji } from "@stores/emoji.store";

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("EmojiPicker load failure", () => {
  afterEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    clearCustomEmoji();
    loadMock.mockReset();
  });

  it("shows a message and Retry when the load fails, even with Recent present", async () => {
    localStorage.setItem("owncord:recent-emoji", JSON.stringify(["\u{1F600}"]));
    loadMock.mockRejectedValueOnce(new Error("chunk failed"));
    const picker = createEmojiPicker({ onSelect: vi.fn(), onClose: vi.fn() });
    document.body.appendChild(picker.element);
    await flush();

    const failed = picker.element.querySelector("[data-testid='emoji-load-failed']");
    expect(failed?.textContent).toContain("Couldn't load emoji");
    expect(picker.element.querySelector("[data-testid='emoji-retry']")?.textContent).toBe("Retry");
    // Recent still renders beside the failure row, and it is not "No emoji found".
    expect(picker.element.querySelectorAll(".ep-emoji").length).toBe(1);
    expect(picker.element.textContent).not.toContain("No emoji found");
    picker.destroy();
  });

  // Order matters: the success test below leaves the real catalog loaded.
  it("a second failure shows Retry again", async () => {
    loadMock.mockRejectedValue(new Error("offline"));
    const picker = createEmojiPicker({ onSelect: vi.fn(), onClose: vi.fn() });
    document.body.appendChild(picker.element);
    await flush();
    picker.element.querySelector<HTMLButtonElement>("[data-testid='emoji-retry']")!.click();
    await flush();

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(picker.element.querySelector("[data-testid='emoji-retry']")).not.toBeNull();
    picker.destroy();
  });

  it("Retry reloads, and on success renders the emoji and drops the message", async () => {
    const actual = await vi.importActual<
      typeof import("../../src/features/messaging/emojiCatalog")
    >("../../src/features/messaging/emojiCatalog");
    loadMock.mockRejectedValueOnce(new Error("chunk failed"));
    loadMock.mockImplementationOnce(() => actual.loadEmojiCatalog());
    const picker = createEmojiPicker({ onSelect: vi.fn(), onClose: vi.fn() });
    document.body.appendChild(picker.element);
    await flush();

    picker.element.querySelector<HTMLButtonElement>("[data-testid='emoji-retry']")!.click();
    // Retrying shows the loading row, not the failure.
    expect(picker.element.querySelector("[data-testid='emoji-load-failed']")).toBeNull();
    expect(picker.element.querySelector(".ep-loading")).not.toBeNull();
    await vi.waitFor(() => expect(emojiCatalog()).not.toBeNull());
    await flush();

    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(picker.element.querySelector("[data-testid='emoji-load-failed']")).toBeNull();
    expect(picker.element.querySelectorAll(".ep-emoji").length).toBeGreaterThan(100);
    picker.destroy();
  });
});
