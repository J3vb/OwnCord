// The one-time Command Deck notice: its text, every way to close it, and its
// place after the What's new dialog.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The version this start reports; the What's new check reads it first.
const appVersion = vi.hoisted(() => vi.fn<() => Promise<string | null>>());
vi.mock("../../src/features/whats-new/appVersion", () => ({ readAppVersion: appVersion }));
vi.mock("../../src/features/whats-new/changelogSource", () => ({
  loadChangelog: () => Promise.resolve([{ version: "2.1.0", body: "- New thing" }]),
}));

import { layoutNoticeText as t } from "../../src/i18n/layoutNotice";
import { createLayoutNotice } from "../../src/features/layout-notice/layoutNotice";
import { createStartupNotices } from "../../src/features/layout-notice/startupNotices";
import { markVersionSeen } from "../../src/features/whats-new/seenVersion";
import { expectConsole } from "../helpers/console";

const NOTICE_KEY = "owncord:settings:deckSwitchNotice";
const notice = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-testid=layout-notice-dialog]");
const whatsNew = (): HTMLElement | null =>
  document.querySelector<HTMLElement>("[data-testid=whats-new-dialog]");

describe("the Command Deck notice", () => {
  let container: HTMLDivElement;
  let opener: HTMLButtonElement;
  const onOpenAppearance = vi.fn();
  let component: ReturnType<typeof createLayoutNotice>;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(NOTICE_KEY, "true");
    onOpenAppearance.mockClear();
    container = document.createElement("div");
    opener = document.createElement("button");
    document.body.append(opener, container);
    opener.focus();
    component = createLayoutNotice(onOpenAppearance);
  });
  afterEach(() => {
    component.destroy?.();
    container.remove();
    opener.remove();
  });

  async function shown(): Promise<HTMLElement> {
    component.mount(container);
    await vi.waitFor(() => expect(notice()).not.toBeNull());
    return notice()!;
  }

  it("reads its text from the catalog, with the way back in bold", async () => {
    const dialog = await shown();
    expect(dialog.querySelector(".whats-new-eyebrow")!.textContent).toBe(t("dialog.eyebrow"));
    expect(dialog.querySelector("h3")!.textContent).toBe(t("dialog.title"));
    const paragraphs = [...dialog.querySelectorAll(".layout-notice-body p")];
    expect(paragraphs.map((p) => p.textContent)).toEqual([
      "Everything works the same, it just looks different.",
      "Prefer the old look? Go to Settings › Appearance › Screen layout and choose Classic.",
    ]);
    expect([...paragraphs[1]!.querySelectorAll("strong")].map((s) => s.textContent)).toEqual([
      "Settings › Appearance › Screen layout",
      "Classic",
    ]);
    const buttons = [...dialog.querySelectorAll(".modal-footer .whats-new-actions button")];
    expect(buttons.map((b) => [b.textContent, b.className])).toEqual([
      ["Open Settings", "ac-btn secondary"],
      ["Got it", "ac-btn"],
    ]);
    expect(dialog.querySelector(".modal-close")!.getAttribute("aria-label")).toBe("Close");
    const modal = dialog.querySelector(".whats-new-modal")!;
    expect(modal.getAttribute("role")).toBe("dialog");
    expect(modal.getAttribute("aria-labelledby")).toBe("layout-notice-title");
    expect(modal.contains(document.activeElement)).toBe(true);
  });

  it.each([
    ["the ✕", () => notice()!.querySelector<HTMLElement>(".modal-close")!.click()],
    [
      "Got it",
      () => notice()!.querySelector<HTMLElement>("[data-testid=layout-notice-done]")!.click(),
    ],
    [
      "Esc",
      () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    ],
    [
      "the backdrop",
      () => {
        const overlay = notice()!;
        overlay.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      },
    ],
  ])("closes on %s, clears the flag and gives focus back", async (_name, close) => {
    await shown();
    close();
    expect(notice()).toBeNull();
    expect(localStorage.getItem(NOTICE_KEY)).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(onOpenAppearance).not.toHaveBeenCalled();
    const again = createLayoutNotice(onOpenAppearance);
    again.mount(container);
    await vi.dynamicImportSettled();
    expect(notice()).toBeNull();
    again.destroy?.();
  });

  it("Open Settings closes, clears the flag and opens Appearance", async () => {
    await shown();
    notice()!.querySelector<HTMLElement>("[data-testid=layout-notice-settings]")!.click();
    expect(notice()).toBeNull();
    expect(localStorage.getItem(NOTICE_KEY)).toBeNull();
    expect(onOpenAppearance).toHaveBeenCalledOnce();
  });

  it("leaves an Esc another dialog handled, or one typed with focus outside, alone", async () => {
    const dialog = await shown();
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    const button = dialog.querySelector<HTMLElement>("[data-testid=layout-notice-done]")!;
    button.focus();
    button.addEventListener("keydown", (e) => e.preventDefault(), { once: true });
    button.dispatchEvent(handled);
    expect(notice()).not.toBeNull();
    opener.focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(notice()).not.toBeNull();
    expect(localStorage.getItem(NOTICE_KEY)).toBe("true");
  });

  it("keeps focus inside while open", async () => {
    const dialog = await shown();
    const buttons = [...dialog.querySelectorAll<HTMLElement>("button")];
    buttons.at(-1)!.focus();
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
    );
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("shows nothing without the flag", async () => {
    localStorage.removeItem(NOTICE_KEY);
    component.mount(container);
    await vi.dynamicImportSettled();
    expect(notice()).toBeNull();
  });

  it("a page torn down under it removes it and keeps the flag for the next page", async () => {
    await shown();
    component.destroy?.();
    expect(notice()).toBeNull();
    expect(localStorage.getItem(NOTICE_KEY)).toBe("true");
  });

  it("a page torn down before the dialog loads shows nothing", async () => {
    component.mount(container);
    component.destroy?.();
    await vi.dynamicImportSettled();
    expect(notice()).toBeNull();
  });
});

describe("startup notices", () => {
  let container: HTMLDivElement;
  const openSettings = vi.fn();
  let notices: ReturnType<typeof createStartupNotices>;

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(NOTICE_KEY, "true");
    openSettings.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    notices = createStartupNotices(openSettings);
  });
  afterEach(() => {
    notices.destroy?.();
    container.remove();
  });

  it("shows the notice only after What's new closes, never on top of it", async () => {
    markVersionSeen("2.0.0");
    appVersion.mockResolvedValue("2.1.0");
    notices.mount(container);
    await vi.waitFor(() => expect(whatsNew()).not.toBeNull());
    await vi.dynamicImportSettled();
    expect(notice()).toBeNull();
    (
      whatsNew()!.querySelector(".whats-new-actions .ac-btn:not(.secondary)") as HTMLElement
    ).click();
    await vi.waitFor(() => expect(notice()).not.toBeNull());
    expect(whatsNew()).toBeNull();
  });

  it("shows the notice at once when What's new has nothing to show", async () => {
    markVersionSeen("2.1.0");
    appVersion.mockResolvedValue("2.1.0");
    notices.mount(container);
    await vi.waitFor(() => expect(notice()).not.toBeNull());
    expect(whatsNew()).toBeNull();
  });

  it("shows the notice when the What's new check fails", async () => {
    appVersion.mockRejectedValue(new Error("no host"));
    notices.mount(container);
    await vi.waitFor(() => expect(notice()).not.toBeNull());
    expectConsole("warn", /What's new check failed/);
  });

  it("Version history opens About and keeps the notice for the next start", async () => {
    markVersionSeen("2.0.0");
    appVersion.mockResolvedValue("2.1.0");
    notices.mount(container);
    await vi.waitFor(() => expect(whatsNew()).not.toBeNull());
    (whatsNew()!.querySelector(".whats-new-actions .ac-btn.secondary") as HTMLElement).click();
    expect(openSettings).toHaveBeenLastCalledWith("About");
    await vi.dynamicImportSettled();
    expect(notice()).toBeNull();
    expect(localStorage.getItem(NOTICE_KEY)).toBe("true");

    // The next start: What's new has nothing new, so the notice shows.
    notices.destroy?.();
    notices = createStartupNotices(openSettings);
    notices.mount(container);
    await vi.waitFor(() => expect(notice()).not.toBeNull());
    notice()!.querySelector<HTMLElement>("[data-testid=layout-notice-settings]")!.click();
    expect(openSettings).toHaveBeenLastCalledWith("Appearance");
  });

  it("a teardown while What's new is up shows no notice afterwards", async () => {
    markVersionSeen("2.0.0");
    appVersion.mockResolvedValue("2.1.0");
    notices.mount(container);
    await vi.waitFor(() => expect(whatsNew()).not.toBeNull());
    notices.destroy?.();
    await vi.dynamicImportSettled();
    expect(whatsNew()).toBeNull();
    expect(notice()).toBeNull();
    expect(localStorage.getItem(NOTICE_KEY)).toBe("true");
  });
});
