import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loggerMock } from "../helpers/loggerMock";

// The notifier re-checks while the app runs (interval, reconnect, manual) and
// must not nag: one banner per version, and a dismiss holds for that version.

const { mockCheckForUpdate, mockSubscribeToUpdateInstall } = vi.hoisted(() => ({
  mockCheckForUpdate: vi.fn(),
  mockSubscribeToUpdateInstall: vi.fn(),
}));

vi.mock("@lib/logger", () => loggerMock());

vi.mock("@lib/net/updater", () => ({
  checkForUpdate: mockCheckForUpdate,
  downloadAndInstallUpdate: vi.fn(),
  subscribeToUpdateInstall: mockSubscribeToUpdateInstall,
}));

import { createUpdateNotifier } from "../../src/components/UpdateNotifier";
import {
  MIN_BACKGROUND_GAP_MS,
  RECONNECT_SPREAD_MS,
  UPDATE_CHECK_INTERVAL_MS,
  getActiveUpdateChecker,
} from "../../src/features/updates/updateChecker";
import { setConnectionStatus } from "../../src/stores/ui.store";
import type { UpdateInstallState } from "../../src/lib/net/updater";

const NONE = { available: false, version: null, body: null, manual_upgrade: false };
const update = (version: string) => ({ available: true, version, body: "", manual_upgrade: false });

describe("createUpdateNotifier while the app keeps running", () => {
  let host: HTMLElement;
  let notifier: ReturnType<typeof createUpdateNotifier>;

  const banners = (): number => host.querySelectorAll(".update-banner").length;
  const bannerText = (): string | null | undefined =>
    host.querySelector(".update-banner-text")?.textContent;
  const click = (selector: string): void =>
    (host.querySelector(selector) as HTMLButtonElement).click();

  beforeEach(() => {
    vi.useFakeTimers();
    mockCheckForUpdate.mockReset();
    mockCheckForUpdate.mockResolvedValue(NONE);
    mockSubscribeToUpdateInstall.mockImplementation(
      (listener: (state: UpdateInstallState) => void) => {
        listener({ status: "idle" });
        return vi.fn();
      },
    );
    setConnectionStatus("connected");
    host = document.createElement("div");
    document.body.appendChild(host);
    notifier = createUpdateNotifier({ serverUrl: "https://s.example", keepChecking: true });
    notifier.mount(host);
  });

  afterEach(() => {
    notifier.destroy?.();
    vi.useRealTimers();
    host.remove();
  });

  it("offers an update that appears after startup, when the interval fires", async () => {
    await vi.advanceTimersByTimeAsync(3000);
    expect(mockCheckForUpdate).toHaveBeenCalledTimes(1);
    expect(banners()).toBe(0);

    mockCheckForUpdate.mockResolvedValue(update("2.0.0"));
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 1.25);

    expect(bannerText()).toBe("OwnCord 2.0.0 is ready to install");
  });

  it("re-checks after a reconnect, so an updated server's new client is offered", async () => {
    await vi.advanceTimersByTimeAsync(3000);
    expect(banners()).toBe(0);
    mockCheckForUpdate.mockResolvedValue(update("2.0.0"));

    setConnectionStatus("reconnecting");
    await vi.advanceTimersByTimeAsync(60_000);
    setConnectionStatus("connected");
    await vi.advanceTimersByTimeAsync(RECONNECT_SPREAD_MS);

    expect(bannerText()).toBe("OwnCord 2.0.0 is ready to install");
  });

  it("does not check on the initial connected state or while still reconnecting", async () => {
    await vi.advanceTimersByTimeAsync(3000);
    mockCheckForUpdate.mockClear();

    setConnectionStatus("reconnecting");
    setConnectionStatus("disconnected");
    await vi.advanceTimersByTimeAsync(0);
    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });

  it("shows one banner for a version however often it is re-detected", async () => {
    mockCheckForUpdate.mockResolvedValue(update("2.0.0"));
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 1.25);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 1.25);

    expect(mockCheckForUpdate.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(banners()).toBe(1);
  });

  it("keeps a dismissed version dismissed, but offers a newer one", async () => {
    mockCheckForUpdate.mockResolvedValue(update("2.0.0"));
    await vi.advanceTimersByTimeAsync(3000);
    click(".update-banner-later");
    expect(banners()).toBe(0);

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 1.25);
    expect(mockCheckForUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(banners()).toBe(0);

    const before = mockCheckForUpdate.mock.calls.length;
    setConnectionStatus("reconnecting");
    await vi.advanceTimersByTimeAsync(MIN_BACKGROUND_GAP_MS);
    setConnectionStatus("connected");
    await vi.advanceTimersByTimeAsync(RECONNECT_SPREAD_MS);
    expect(mockCheckForUpdate.mock.calls.length).toBe(before + 1);
    expect(banners()).toBe(0);

    mockCheckForUpdate.mockResolvedValue(update("2.1.0"));
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 1.25);
    expect(bannerText()).toBe("OwnCord 2.1.0 is ready to install");
  });

  it("offers a newer version after a retryable download failure, even once the failure is dismissed", async () => {
    let push!: (state: UpdateInstallState) => void;
    mockSubscribeToUpdateInstall.mockImplementation(
      (listener: (state: UpdateInstallState) => void) => {
        push = listener;
        listener({ status: "idle" });
        return vi.fn();
      },
    );
    notifier.destroy?.();
    host.replaceChildren();
    notifier = createUpdateNotifier({ serverUrl: "https://s.example", keepChecking: true });
    notifier.mount(host);

    mockCheckForUpdate.mockResolvedValue(update("2.0.0"));
    await vi.advanceTimersByTimeAsync(3000);
    push({ status: "failed", restartRequired: false });
    click(".update-banner-later");
    expect(banners()).toBe(0);

    mockCheckForUpdate.mockResolvedValue(update("2.1.0"));
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(bannerText()).toBe("OwnCord 2.1.0 is ready to install");
  });

  it("a manual check shows the banner again even for a dismissed version", async () => {
    mockCheckForUpdate.mockResolvedValue(update("2.0.0"));
    await vi.advanceTimersByTimeAsync(3000);
    click(".update-banner-later");
    expect(banners()).toBe(0);

    await getActiveUpdateChecker()?.checkNow("manual");

    expect(bannerText()).toBe("OwnCord 2.0.0 is ready to install");
  });

  it("stops checking and drops the active checker when destroyed", async () => {
    notifier.destroy?.();
    expect(getActiveUpdateChecker()).toBeNull();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(mockCheckForUpdate).not.toHaveBeenCalled();
  });
});
