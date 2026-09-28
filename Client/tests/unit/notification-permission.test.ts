/**
 * B9-25: the Notifications settings tab reports the real OS notification
 * permission and offers the one action that can change it. These cases pin the
 * states a notifier can answer (granted, denied, unavailable) and the one where
 * it cannot observe the OS setting at all, so the panel never claims a
 * permission it did not observe (BPR-092).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockNotifier, mockPermissionGranted, mockRequestPermission } = vi.hoisted(() => {
  const mockPermissionGranted = vi.fn();
  const mockRequestPermission = vi.fn();
  return {
    mockPermissionGranted,
    mockRequestPermission,
    mockNotifier: {
      readsOsPermission: true,
      permissionGranted: mockPermissionGranted,
      requestPermission: mockRequestPermission,
    },
  };
});

vi.mock("../../src/platform/desktop", () => ({
  desktop: { notifier: mockNotifier },
}));

import { buildNotificationsTab } from "@components/settings/NotificationsTab";

let container: HTMLDivElement;
let ac: AbortController;

beforeEach(() => {
  localStorage.clear();
  mockNotifier.readsOsPermission = true;
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

/** The permission's status pill: its word and its icon's state class. */
function pill(el: HTMLDivElement): { text: string; kind: string } {
  const p = el.querySelector<HTMLElement>("[data-testid='notification-permission-status']")!;
  const icon = p.querySelector(".st-ic")!;
  const kind = ["ok", "warn", "crit", "pending"].find((k) => icon.classList.contains(`st-${k}`));
  return { text: p.textContent!, kind: kind ?? "" };
}

describe("NotificationsTab — system notification permission", () => {
  it("reports a granted permission as an Allowed pill alone, with no Allow action", async () => {
    mockPermissionGranted.mockResolvedValue(true);
    const el = row();
    await vi.waitFor(() => expect(pill(el)).toEqual({ text: "Allowed", kind: "ok" }));
    // Nothing to fix, so no sentence under it.
    expect(descText(el)).toBe("");
    const allow = el.querySelector("[data-testid='notification-permission-allow']") as HTMLElement;
    expect(allow.hidden).toBe(true);
  });

  it("reports a denial and offers the Allow action, which updates the state", async () => {
    mockPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockResolvedValue(true);
    const el = row();
    await vi.waitFor(() => {
      expect(descText(el)).toBe("Ask again, or allow OwnCord in your system settings.");
    });
    expect(pill(el)).toEqual({ text: "Blocked", kind: "crit" });

    const allow = el.querySelector(
      "[data-testid='notification-permission-allow']",
    ) as HTMLButtonElement;
    expect(allow.hidden).toBe(false);
    allow.click();

    await vi.waitFor(() => expect(pill(el)).toEqual({ text: "Allowed", kind: "ok" }));
    expect(descText(el)).toBe("");
    expect(allow.hidden).toBe(true);
  });

  it("keeps the denial state when the OS refuses the request again", async () => {
    mockPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockResolvedValue(false);
    const el = row();
    await vi.waitFor(() => {
      expect(descText(el)).toBe("Ask again, or allow OwnCord in your system settings.");
    });

    (el.querySelector("[data-testid='notification-permission-allow']") as HTMLElement).click();
    await vi.waitFor(() => {
      expect(descText(el)).toBe("Ask again, or allow OwnCord in your system settings.");
    });
  });

  it("names the limitation as unavailable, not denied, when there is no notifier", async () => {
    mockPermissionGranted.mockRejectedValue(new Error("no native notifier"));
    const el = row();
    await vi.waitFor(() => {
      expect(descText(el)).toBe("This build has no system notifier.");
    });
    expect(pill(el)).toEqual({ text: "Unavailable", kind: "pending" });
    // No Allow action: permission cannot be asked for where no notifier exists.
    const allow = el.querySelector("[data-testid='notification-permission-allow']") as HTMLElement;
    expect(allow.hidden).toBe(true);
  });

  it.each([true, false])(
    "says it cannot read the system setting when the notifier cannot observe it (reading %s)",
    async (reading) => {
      mockNotifier.readsOsPermission = false;
      mockPermissionGranted.mockResolvedValue(reading);
      const el = row();
      await vi.waitFor(() => {
        expect(descText(el)).toBe(
          "If notifications don't appear, check your system notification settings.",
        );
      });
      expect(pill(el)).toEqual({ text: "Unknown", kind: "pending" });
      const allow = el.querySelector(
        "[data-testid='notification-permission-allow']",
      ) as HTMLElement;
      expect(allow.hidden).toBe(true);
    },
  );

  it("removes the Allow action if the request itself finds no notifier", async () => {
    mockPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockRejectedValue(new Error("no native notifier"));
    const el = row();
    await vi.waitFor(() => {
      expect(descText(el)).toBe("Ask again, or allow OwnCord in your system settings.");
    });

    const allow = el.querySelector(
      "[data-testid='notification-permission-allow']",
    ) as HTMLButtonElement;
    allow.click();
    await vi.waitFor(() => {
      expect(descText(el)).toBe("This build has no system notifier.");
    });
    expect(allow.hidden).toBe(true);
  });

  it("dims Desktop Notifications with a reason while blocked, and restores it once allowed", async () => {
    mockPermissionGranted.mockResolvedValue(false);
    mockRequestPermission.mockResolvedValue(true);
    const el = row();
    const desktopRow = container
      .querySelector('.toggle[aria-label="Desktop Notifications"]')!
      .closest<HTMLElement>(".setting-row")!;
    await vi.waitFor(() => expect(desktopRow.classList.contains("blocked")).toBe(true));
    const reason = desktopRow.querySelector<HTMLElement>(".setting-blocked-reason")!;
    expect(reason.hidden).toBe(false);
    expect(reason.textContent).toBe("Blocked by your system. Allow notifications above.");

    (el.querySelector("[data-testid='notification-permission-allow']") as HTMLElement).click();
    await vi.waitFor(() => expect(desktopRow.classList.contains("blocked")).toBe(false));
    expect(reason.hidden).toBe(true);
  });
});
