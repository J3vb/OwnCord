import { describe, it, expect, vi } from "vitest";
import * as mocks from "../../helpers/settingsOverlayMocks";
import {
  defaultOptions,
  getTab,
  openOverlay,
  testId,
  useSettingsOverlayHarness,
} from "../../helpers/settingsOverlayHarness";

vi.mock("../../../src/features/whats-new/appVersion", () => mocks.newAppVersionMock());
vi.mock("@lib/logger", () => mocks.loggerMock());
vi.mock("@stores/ui.store", () => mocks.uiStoreMock());
vi.mock("@lib/voice/livekitSession", () => mocks.voiceLivekitSessionMock());
vi.mock("@stores/auth.store", () => mocks.authStoreMock());

const prompt = (): HTMLElement | null => testId(document, "unsaved-confirm-dialog");
const escape = (): void => {
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
};

describe("SettingsOverlay close guard beyond the profile fields", () => {
  let container: HTMLDivElement;
  useSettingsOverlayHarness((el) => {
    container = el;
  });

  async function showRecoveryKitSecret(): Promise<void> {
    testId(container, "recovery-kit-btn").click();
    testId<HTMLInputElement>(container, "recovery-kit-password").value = "hunter2hunter2";
    testId(container, "recovery-kit-submit").click();
    await vi.waitFor(() => expect(testId(container, "recovery-kit-secret")).not.toBeNull());
  }

  const kitOptions = {
    ...defaultOptions,
    onEnrolRecoveryKit: vi.fn().mockResolvedValue({ kit_secret: "KIT-SECRET", created_at: "x" }),
  };

  it("asks before Escape wipes a recovery secret that is on screen", async () => {
    const overlay = openOverlay(container, kitOptions);
    await showRecoveryKitSecret();

    escape();
    expect(prompt()?.textContent).toContain("shown only once");
    expect(defaultOptions.onClose).not.toHaveBeenCalled();

    testId(document, "unsaved-keep").click();
    expect(testId(container, "recovery-kit-secret")?.textContent).toBe("KIT-SECRET");
    overlay.destroy?.();
  });

  it("closes without asking once the secret was dismissed with Done", async () => {
    const overlay = openOverlay(container, kitOptions);
    await showRecoveryKitSecret();
    testId(container, "shown-once-done").click();

    escape();
    expect(prompt()).toBeNull();
    expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);
    overlay.destroy?.();
  });

  it("asks before a tab switch drops a half-written custom theme", () => {
    const overlay = openOverlay(container);
    getTab(container, 1).click();
    const newTheme = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "New theme",
    )!;
    newTheme.click();
    testId<HTMLTextAreaElement>(container, "custom-theme-css").value = "body { color: red; }";

    escape();
    expect(prompt()?.textContent).toContain("custom theme");
    expect(defaultOptions.onClose).not.toHaveBeenCalled();

    testId(document, "unsaved-discard").click();
    expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);
    overlay.destroy?.();
  });

  it("closes without asking while the theme editor is open but untouched", () => {
    const overlay = openOverlay(container);
    getTab(container, 1).click();
    Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent === "New theme")!
      .click();

    escape();
    expect(prompt()).toBeNull();
    expect(defaultOptions.onClose).toHaveBeenCalledTimes(1);
    overlay.destroy?.();
  });
});
