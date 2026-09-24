/**
 * B9-25: the Notifications settings tab reports the real OS notification
 * permission and offers the one action that can change it. These cases pin the
 * three states the native notifier can answer (granted, denied, unavailable),
 * so the panel never claims a permission it did not observe (BPR-092).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockPermissionGranted, mockRequestPermission } = vi.hoisted(() => ({
  mockPermissionGranted: vi.fn(),
  mockRequestPermission: vi.fn(),
}));

vi.mock("../../src/platform/desktop", () => ({
  desktop: {
    notifier: {
      permissionGranted: mockPermissionGranted,
      requestPermission: mockRequestPermission,
    },
  },
}));

import { buildNotificationsTab } from "@components/settings/NotificationsTab";

let container: HTMLDivElement;
let ac: AbortController;

beforeEach(() => {
  localStorage.clear();
  mockPermissionGranted.mockReset();
  mockRequestPermission.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  ac = new AbortController();
});

afterEach(() => {
  ac.abort();
  container.remove();
});

function row(): HTMLDivElement {
  const tab = buildNotificationsTab(ac.signal);
  container.appendChild(tab);
  return tab.querySelector("[data-testid='notification-permission-row']") as HTMLDivElement;
}

function descText(el: HTMLDivElement): string {
  return el.querySelector(".setting-desc")!.textContent!;
}

describe("NotificationsTab — system notification permission", () => {
  it("reports a granted permission and offers no Allow action", async () => {
    mockPermissionGranted.mockResolvedValue(true);
    const el = row();
    await vi.waitFor(() => {
      expect(descText(el)).toContain("Your system allows OwnCord");
    });
    const allow = el.querySelector("[data-testid='notification-permission-allow']") as HTMLElement;
    expect(allow.hidden).toBe(true);
  });

  it("reports a denial and offers the Allow action, which updates the state", async () => {
    mockPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockResolvedValue(true);
    const el = row();
    await vi.waitFor(() => {
      expect(descText(el)).toContain("blocked notifications from OwnCord");
    });

    const allow = el.querySelector(
      "[data-testid='notification-permission-allow']",
    ) as HTMLButtonElement;
    expect(allow.hidden).toBe(false);
    allow.click();

    await vi.waitFor(() => {
      expect(descText(el)).toContain("Your system allows OwnCord");
    });
    expect(allow.hidden).toBe(true);
  });

  it("keeps the denial state when the OS refuses the request again", async () => {
    mockPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockResolvedValue(false);
    const el = row();
    await vi.waitFor(() => {
      expect(descText(el)).toContain("blocked notifications from OwnCord");
    });

    (el.querySelector("[data-testid='notification-permission-allow']") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(descText(el)).toContain("blocked notifications from OwnCord");
    });
  });

  it("names the limitation as unavailable, not denied, when there is no notifier", async () => {
    mockPermissionGranted.mockRejectedValue(new Error("no native notifier"));
    const el = row();
    await vi.waitFor(() => {
      expect(descText(el)).toContain("no system notifier");
    });
    // No Allow action: permission cannot be asked for where no notifier exists.
    const allow = el.querySelector("[data-testid='notification-permission-allow']") as HTMLElement;
    expect(allow.hidden).toBe(true);
  });

  it("removes the Allow action if the request itself finds no notifier", async () => {
    mockPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockRejectedValue(new Error("no native notifier"));
    const el = row();
    await vi.waitFor(() => {
      expect(descText(el)).toContain("blocked notifications from OwnCord");
    });

    const allow = el.querySelector(
      "[data-testid='notification-permission-allow']",
    ) as HTMLButtonElement;
    allow.click();
    await vi.waitFor(() => {
      expect(descText(el)).toContain("no system notifier");
    });
    expect(allow.hidden).toBe(true);
  });
});
