import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockGetVersion } = vi.hoisted(() => ({
  mockGetVersion: vi.fn<() => Promise<string | null>>(),
}));
vi.mock("../../src/platform/desktop", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/platform/desktop")>();
  return { desktop: { ...real.desktop, appMetadata: { getVersion: mockGetVersion } } };
});
vi.mock("../../src/features/whats-new/changelogSource", () => ({
  loadChangelog: () =>
    Promise.resolve([
      { version: "2.1.0", body: "- New thing" },
      { version: "2.0.0", body: "- Old thing" },
    ]),
}));

import { createWhatsNewPrompt } from "../../src/features/whats-new/whatsNewPrompt";
import { markVersionSeen } from "../../src/features/whats-new/seenVersion";

const dialog = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-testid=whats-new-dialog]");

describe("What's new prompt", () => {
  let container: HTMLDivElement;
  let prompt: ReturnType<typeof createWhatsNewPrompt>;
  const onOpenHistory = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    onOpenHistory.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    prompt = createWhatsNewPrompt(onOpenHistory);
  });
  afterEach(() => {
    prompt.destroy?.();
    container.remove();
  });

  it("shows the new version's notes once after an update", async () => {
    markVersionSeen("2.0.0");
    mockGetVersion.mockResolvedValue("2.1.0");
    prompt.mount(container);
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.textContent).toContain("Updated to 2.1.0");
    expect(dialog()!.textContent).toContain("New thing");
    expect(dialog()!.textContent).not.toContain("Old thing");

    (dialog()!.querySelector(".whats-new-actions .ac-btn:not(.secondary)") as HTMLElement).click();
    expect(dialog()).toBeNull();

    const again = createWhatsNewPrompt(onOpenHistory);
    again.mount(container);
    await new Promise((r) => setTimeout(r, 20));
    expect(dialog()).toBeNull();
    again.destroy?.();
  });

  it("stays quiet on a fresh install", async () => {
    mockGetVersion.mockResolvedValue("2.1.0");
    prompt.mount(container);
    await new Promise((r) => setTimeout(r, 20));
    expect(dialog()).toBeNull();
    expect(localStorage.getItem("owncord:whats-new:seen-version")).toBe("2.1.0");
  });

  it("stays quiet for a version with no notes, and does not ask again", async () => {
    markVersionSeen("2.1.0");
    mockGetVersion.mockResolvedValue("2.2.0-dev");
    prompt.mount(container);
    await vi.waitFor(() =>
      expect(localStorage.getItem("owncord:whats-new:seen-version")).toBe("2.2.0-dev"),
    );
    expect(dialog()).toBeNull();
  });

  it("Version history closes the window and opens the history", async () => {
    markVersionSeen("2.0.0");
    mockGetVersion.mockResolvedValue("2.1.0");
    prompt.mount(container);
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    (dialog()!.querySelector(".whats-new-actions .secondary") as HTMLElement).click();
    expect(dialog()).toBeNull();
    expect(onOpenHistory).toHaveBeenCalledTimes(1);
  });

  it("closes with Escape and when the page is torn down", async () => {
    markVersionSeen("2.0.0");
    mockGetVersion.mockResolvedValue("2.1.0");
    prompt.mount(container);
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(dialog()).toBeNull();

    markVersionSeen("2.0.0");
    const next = createWhatsNewPrompt(onOpenHistory);
    next.mount(container);
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    next.destroy?.();
    expect(dialog()).toBeNull();
  });
});
