import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockActive, mockInstall, mockInstallState } = vi.hoisted(() => ({
  mockActive: vi.fn(),
  mockInstall: vi.fn(),
  mockInstallState: vi.fn(),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../../src/features/updates/updateChecker", () => ({ getActiveUpdateChecker: mockActive }));
vi.mock("@lib/net/updater", () => ({
  downloadAndInstallUpdate: mockInstall,
  // Like the real one: replays the app-wide install state to a new subscriber.
  subscribeToUpdateInstall: (listener: (state: unknown) => void) => {
    listener(mockInstallState());
    return () => undefined;
  },
}));

import { buildUpdateCheckRow } from "../../src/features/updates/UpdateCheckRow";
import type { UpdateOutcome } from "../../src/features/updates/updateChecker";

describe("Settings → Check for updates", () => {
  let ac: AbortController;
  let row: HTMLElement;
  let resolveCheck: (o: UpdateOutcome) => void;
  const checkNow = vi.fn();

  const button = (): HTMLButtonElement => row.querySelector("button.update-check-btn")!;
  const status = (): string => row.querySelector("[data-testid=update-check-status]")!.textContent!;
  const settle = async (outcome: UpdateOutcome): Promise<void> => {
    button().click();
    resolveCheck(outcome);
    await vi.waitFor(() => expect(button().disabled).toBe(false));
  };

  beforeEach(() => {
    ac = new AbortController();
    checkNow.mockReset();
    checkNow.mockImplementation(() => new Promise<UpdateOutcome>((r) => (resolveCheck = r)));
    mockInstall.mockReset();
    mockInstall.mockResolvedValue(undefined);
    mockInstallState.mockReturnValue({ status: "idle" });
    mockActive.mockReturnValue({ serverUrl: "https://s.example", checkNow });
    row = buildUpdateCheckRow(ac.signal);
    document.body.appendChild(row);
  });

  afterEach(() => {
    ac.abort();
    row.remove();
  });

  it("starts idle with a labelled button", () => {
    expect(button().textContent).toBe("Check for updates");
    expect(button().disabled).toBe(false);
    expect(status()).toBe("");
  });

  it("shows a checking state and runs a manual check", async () => {
    button().click();
    expect(checkNow).toHaveBeenCalledWith("manual");
    expect(button().disabled).toBe(true);
    expect(status()).toBe("Checking for updates…");
    resolveCheck({ kind: "up-to-date" });
    await vi.waitFor(() => expect(button().disabled).toBe(false));
  });

  it("says when you are up to date", async () => {
    await settle({ kind: "up-to-date" });
    expect(status()).toBe("You're up to date.");
    expect(row.querySelector(".update-check-install")).toBeNull();
  });

  it("offers the available version with the existing install action", async () => {
    await settle({ kind: "available", version: "2.0.0", body: "" });
    expect(status()).toBe("Update v2.0.0 available");

    (row.querySelector(".update-check-install") as HTMLButtonElement).click();
    expect(mockInstall).toHaveBeenCalledWith("https://s.example");
  });

  it("does not offer the install again once an install already succeeded and only a restart is pending", async () => {
    mockInstallState.mockReturnValue({ status: "failed", restartRequired: true });
    await settle({ kind: "available", version: "2.0.0", body: "" });
    expect(status()).toBe("Update installed. Please restart OwnCord to finish.");
    expect(row.querySelector(".update-check-install")).toBeNull();
  });

  it("does not offer a second install while one is downloading or restarting", async () => {
    mockInstallState.mockReturnValue({ status: "downloading", progress: null });
    await settle({ kind: "available", version: "2.0.0", body: "" });
    expect(status()).toBe("Downloading update…");
    expect(row.querySelector(".update-check-install")).toBeNull();

    mockInstallState.mockReturnValue({ status: "restarting" });
    await settle({ kind: "available", version: "2.0.0", body: "" });
    expect(status()).toBe("Update installed. Restarting…");
    expect(row.querySelector(".update-check-install")).toBeNull();
  });

  it("still offers a retry after a failed download that can be retried", async () => {
    mockInstallState.mockReturnValue({ status: "failed", restartRequired: false });
    await settle({ kind: "available", version: "2.0.0", body: "" });
    expect(row.querySelector(".update-check-install")).not.toBeNull();
  });

  it("says so when this install cannot update itself", async () => {
    await settle({ kind: "manual-upgrade" });
    expect(status()).toBe(
      "This install cannot update itself. Ask your server administrator for the new version.",
    );
  });

  it("reports a failed check as an error, never as up to date", async () => {
    await settle({ kind: "failed" });
    expect(status()).toBe("Couldn't check for updates. Try again later.");
    expect(row.querySelector("[data-testid=update-check-status]")!.className).toBe("form-error");
  });

  it("clears a stale install button on the next check", async () => {
    await settle({ kind: "available", version: "2.0.0", body: "" });
    await settle({ kind: "up-to-date" });
    expect(row.querySelector(".update-check-install")).toBeNull();
    expect(status()).toBe("You're up to date.");
  });

  it("explains when there is no server to ask", () => {
    mockActive.mockReturnValue(null);
    const offline = buildUpdateCheckRow(ac.signal);
    expect(offline.querySelector("button.update-check-btn")).toHaveProperty("disabled", true);
    expect(offline.textContent).toContain("Connect to a server to check for updates.");
  });
});
