import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/settingsOverlayMocks";
import {
  acButton,
  defaultOptions,
  getTab,
  openOverlay,
  testId,
  useSettingsOverlayHarness,
} from "../../helpers/settingsOverlayHarness";
import type { SettingsOverlayOptions } from "../../../src/features/settings/SettingsOverlay";

vi.mock("../../../src/features/whats-new/appVersion", () => mocks.newAppVersionMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@stores/ui.store", () => mocks.uiStoreMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@stores/auth.store", () => mocks.authStoreMock());

const prompt = (): HTMLElement | null => testId(document, "unsaved-confirm-dialog");
const activeTabLabel = (container: ParentNode): string | null =>
  container.querySelector(".settings-nav-item.active")?.textContent ?? null;

describe("SettingsOverlay unsaved profile edits", () => {
  let container: HTMLDivElement;
  useSettingsOverlayHarness((el) => {
    container = el;
  });

  function typeAbout(text: string): void {
    const about = testId<HTMLTextAreaElement>(container, "about-input");
    about.value = text;
    about.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("closes without asking when nothing was changed", () => {
    const overlay = openOverlay(container);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(prompt()).toBeNull();
    expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);
    overlay.destroy?.();
  });

  it("asks before Escape throws away a typed about text; Keep editing keeps it", () => {
    const overlay = openOverlay(container);
    typeAbout("Hello there");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(prompt()).not.toBeNull();
    expect(defaultOptions.onClose).not.toHaveBeenCalled();

    testId(document, "unsaved-keep").click();
    expect(prompt()).toBeNull();
    expect(defaultOptions.onClose).not.toHaveBeenCalled();
    expect(testId<HTMLTextAreaElement>(container, "about-input").value).toBe("Hello there");
    overlay.destroy?.();
  });

  it("Discard lets the close go ahead", () => {
    const overlay = openOverlay(container);
    typeAbout("Hello there");
    container.querySelector<HTMLElement>(".settings-overlay")!.click();
    expect(prompt()).not.toBeNull();

    testId(document, "unsaved-discard").click();
    expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);
    overlay.destroy?.();
  });

  it("asks before a tab switch and switches only on Discard", () => {
    const overlay = openOverlay(container);
    testId<HTMLInputElement>(container, "display-name-input").value = "New name";
    const other = getTab(container, 2);
    const otherLabel = other.textContent;

    other.click();
    expect(prompt()).not.toBeNull();
    expect(activeTabLabel(container)).toBe("Account");

    testId(document, "unsaved-discard").click();
    expect(activeTabLabel(container)).toBe(otherLabel);
    expect(testId(container, "display-name-input")).toBeNull();
    overlay.destroy?.();
  });

  it("a saved edit no longer counts as unsaved", async () => {
    const onUpdateProfile = vi.fn().mockImplementation((patch: { about?: string }) => {
      mocks.mockAuthState.user = { ...mocks.mockAuthState.user, ...patch };
      return Promise.resolve(undefined);
    });
    const overlay = openOverlay(container, { ...defaultOptions, onUpdateProfile });
    typeAbout("Saved text");
    testId(container, "profile-save-btn").click();
    await vi.waitFor(() => expect(onUpdateProfile).toHaveBeenCalledTimes(1));

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(prompt()).toBeNull();
    expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);
    overlay.destroy?.();
  });

  it("counts a typed new username in the open rename field", () => {
    const overlay = openOverlay(container);
    (container.querySelector(".account-field-edit") as HTMLElement).click();
    testId<HTMLInputElement>(container, "username-edit-input").value = "someone-else";

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(prompt()).not.toBeNull();
    overlay.destroy?.();
    expect(prompt()).toBeNull();
  });
});

describe("SettingsOverlay username rename", () => {
  let container: HTMLDivElement;
  useSettingsOverlayHarness((el) => {
    container = el;
  });

  function openRename(onUpdateProfile: SettingsOverlayOptions["onUpdateProfile"]) {
    const overlay = openOverlay(container, { ...defaultOptions, onUpdateProfile });
    (container.querySelector(".account-field-edit") as HTMLElement).click();
    const input = testId<HTMLInputElement>(container, "username-edit-input");
    input.value = "new-name";
    return { overlay, input, save: acButton(container, "Save") };
  }

  it("Enter in the field saves", async () => {
    const onUpdateProfile = vi.fn().mockResolvedValue(undefined);
    const { overlay, input } = openRename(onUpdateProfile);
    const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onUpdateProfile).toHaveBeenCalledWith({ username: "new-name" });
    overlay.destroy?.();
  });

  it("sends one request while one is in flight, then re-enables Save", async () => {
    let finish: () => void = () => {};
    const onUpdateProfile = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { overlay, input, save } = openRename(onUpdateProfile);
    save.click();
    expect(save.disabled).toBe(true);
    save.click();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onUpdateProfile).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => expect(save.disabled).toBe(false));
    overlay.destroy?.();
  });
});
