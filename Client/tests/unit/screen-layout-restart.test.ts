import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { expectConsole } from "../helpers/console";
import { clearHost, hostDesktopApp } from "../helpers/androidHost";

const { mockRelaunch } = vi.hoisted(() => ({
  mockRelaunch: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: mockRelaunch,
}));

import { buildScreenLayoutRow } from "../../src/features/settings/screenLayoutRow";
import { setRunningScreenLayout } from "@lib/prefs/screenLayout";
import { joinVoiceChannel, leaveVoiceChannel } from "@stores/voice.store";
import { settingsText as t } from "../../src/i18n/settings";

const KEY = "owncord:settings:screenLayout";
const BUTTON = "[data-testid='screen-layout-restart']";
const SIGN_IN = "[data-testid='screen-layout-restart-signin']";

describe("Screen layout row: Restart now", () => {
  let ac: AbortController;
  let row: HTMLElement;

  const button = (): HTMLButtonElement | null => row.querySelector<HTMLButtonElement>(BUTTON);
  const signIn = (): HTMLElement | null => row.querySelector<HTMLElement>(SIGN_IN);
  const pick = (value: "classic" | "deck"): void =>
    row.querySelector<HTMLElement>(`[data-testid='screen-layout-${value}']`)!.click();
  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };
  /** Mounts the row running Classic with Deck picked, so the button shows. */
  const mountPending = (): HTMLButtonElement => {
    localStorage.setItem(KEY, '"classic"');
    row = buildScreenLayoutRow(ac.signal)!;
    document.body.appendChild(row);
    pick("deck");
    return button()!;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    mockRelaunch.mockReset();
    mockRelaunch.mockResolvedValue(undefined);
    setRunningScreenLayout("classic");
    ac = new AbortController();
  });

  afterEach(() => {
    ac.abort();
    row?.remove();
    leaveVoiceChannel();
    clearHost();
    setRunningScreenLayout("classic");
    localStorage.clear();
    vi.useRealTimers();
  });

  it("has no button or line while the stored layout is the running one", () => {
    localStorage.setItem(KEY, '"classic"');
    row = buildScreenLayoutRow(ac.signal)!;
    expect(button()).toBeNull();
    expect(signIn()).toBeNull();
  });

  it("shows the button when they differ and removes it when they match again", () => {
    mountPending();
    expect(button()).not.toBeNull();
    expect(button()!.textContent).toBe(t("appearance.screenLayout.restart"));
    expect(button()!.className).toBe("ac-btn secondary");
    pick("classic");
    expect(button()).toBeNull();
    expect(signIn()).toBeNull();
  });

  it("shows the sign-in line on desktop and not in the browser", () => {
    mountPending();
    expect(signIn()).toBeNull();
    row.remove();
    ac.abort();
    ac = new AbortController();
    hostDesktopApp();
    mountPending();
    expect(signIn()!.textContent).toBe(t("appearance.screenLayout.restartSignIn"));
    pick("classic");
    expect(signIn()).toBeNull();
  });

  it("relaunches once out of a call and ignores a click while disabled", async () => {
    let finish: () => void = () => {};
    mockRelaunch.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    hostDesktopApp();
    const btn = mountPending();
    btn.click();
    await flush();
    expect(btn.disabled).toBe(true);
    btn.click();
    await flush();
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
    finish();
    await flush();
  });

  describe("in a call", () => {
    beforeEach(() => joinVoiceChannel(5));

    it("the first click asks and does not relaunch", async () => {
      hostDesktopApp();
      const btn = mountPending();
      btn.click();
      await flush();
      expect(btn.textContent).toBe(t("appearance.screenLayout.restartConfirm"));
      expect(btn.dataset["confirmPending"]).toBe("true");
      expect(mockRelaunch).not.toHaveBeenCalled();
    });

    it("a second click within 3 s relaunches once", async () => {
      hostDesktopApp();
      const btn = mountPending();
      btn.click();
      await vi.advanceTimersByTimeAsync(2900);
      btn.click();
      await flush();
      expect(mockRelaunch).toHaveBeenCalledTimes(1);
      expect(btn.dataset["confirmPending"]).toBeUndefined();
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockRelaunch).toHaveBeenCalledTimes(1);
    });

    it("resets the label after 3 000 ms", async () => {
      hostDesktopApp();
      const btn = mountPending();
      btn.click();
      await vi.advanceTimersByTimeAsync(3000);
      expect(btn.textContent).toBe(t("appearance.screenLayout.restart"));
      expect(btn.dataset["confirmPending"]).toBeUndefined();
      btn.click();
      await flush();
      expect(mockRelaunch).not.toHaveBeenCalled();
    });

    it("a call that ends in the window still relaunches on the second click", async () => {
      hostDesktopApp();
      const btn = mountPending();
      btn.click();
      leaveVoiceChannel();
      btn.click();
      await flush();
      expect(mockRelaunch).toHaveBeenCalledTimes(1);
    });

    it("a rejected relaunch logs one error, re-enables, and the next click asks again", async () => {
      mockRelaunch.mockRejectedValueOnce(new Error("no relaunch"));
      hostDesktopApp();
      const btn = mountPending();
      btn.click();
      btn.click();
      await flush();
      expectConsole("error", /restart failed/);
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe(t("appearance.screenLayout.restart"));
      btn.click();
      await flush();
      expect(btn.textContent).toBe(t("appearance.screenLayout.restartConfirm"));
      expect(mockRelaunch).toHaveBeenCalledTimes(1);
    });
  });
});
