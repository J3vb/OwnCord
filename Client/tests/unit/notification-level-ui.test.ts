/**
 * U1(b): the Notifications tab gains a "Notification level" control
 * (All / Mentions only / Nothing), global, defaulting to Mentions only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockNotifier } = vi.hoisted(() => ({
  mockNotifier: {
    readsOsPermission: true,
    permissionGranted: vi.fn().mockResolvedValue(true),
    requestPermission: vi.fn(),
  },
}));

vi.mock("../../src/platform/desktop", () => ({
  desktop: { notifier: mockNotifier },
}));

import { buildNotificationsTab } from "@components/settings/NotificationsTab";
import {
  getGlobalNotificationLevel,
  setNotificationLevelHost,
  setGlobalNotificationLevel,
} from "@lib/notificationLevel";

let container: HTMLDivElement;
let ac: AbortController;

beforeEach(() => {
  localStorage.clear();
  setNotificationLevelHost(null);
  container = document.createElement("div");
  document.body.appendChild(container);
  ac = new AbortController();
});

afterEach(() => {
  ac.abort();
  container.remove();
});

function build(): HTMLDivElement {
  const tab = buildNotificationsTab(ac.signal);
  container.appendChild(tab);
  return tab;
}

describe("NotificationsTab — notification level", () => {
  it("offers All, Mentions only and Nothing, with Mentions only selected by default", () => {
    const tab = build();
    const group = tab.querySelector<HTMLElement>("[data-testid='notification-level']")!;
    expect(group).not.toBeNull();
    const options = [...group.querySelectorAll<HTMLElement>("[role='radio']")];
    expect(options.map((o) => o.textContent)).toEqual(["All", "Mentions only", "Nothing"]);
    expect(options.map((o) => o.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  it("saves the chosen level", () => {
    const tab = build();
    const nothing = tab.querySelector<HTMLElement>("[data-testid='notification-level-nothing']")!;
    nothing.click();
    expect(getGlobalNotificationLevel()).toBe("nothing");
    expect(nothing.getAttribute("aria-checked")).toBe("true");
  });

  it("reflects a stored level on open", () => {
    setGlobalNotificationLevel("all");
    const tab = build();
    const all = tab.querySelector<HTMLElement>("[data-testid='notification-level-all']")!;
    expect(all.getAttribute("aria-checked")).toBe("true");
  });
});
