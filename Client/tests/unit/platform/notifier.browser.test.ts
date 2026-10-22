// Browser binding for the Notifier suite (6.13d): the Web Notification API and
// the Badging API. "The native plugin" is the page's `Notification` global,
// replaced here by a fake that records what it was asked to show. The browser
// has no window to flash, so the suite runs with `windowAttention: false` and
// the tests below pin that no-op and the title-count fallback.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationTarget, Notifier } from "../../../src/platform/contracts/notifications";
import { describeNotifierSuite } from "./notifier.suite";

interface ShownOptions {
  body?: string;
  icon?: string;
  tag?: string;
  data?: NotificationTarget;
  requireInteraction?: boolean;
}

class FakeNotification {
  static permission: NotificationPermission = "granted";
  static answer: NotificationPermission = "granted";
  static instances: FakeNotification[] = [];
  static requestPermission = vi.fn(() => Promise.resolve(FakeNotification.answer));
  private readonly listeners: (() => void)[] = [];
  closed = false;
  constructor(
    readonly title: string,
    readonly options: ShownOptions = {},
  ) {
    FakeNotification.instances.push(this);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(_type: "click", listener: () => void): void {
    this.listeners.push(listener);
  }
  click(): void {
    for (const listener of this.listeners) listener();
  }
}

const badge: number[] = [];

function setBadgeApi(on: boolean): void {
  for (const name of ["setAppBadge", "clearAppBadge"]) {
    Object.defineProperty(navigator, name, {
      configurable: true,
      value: on
        ? (count?: number) => {
            badge.push(name === "setAppBadge" ? (count ?? 0) : 0);
            return Promise.resolve();
          }
        : undefined,
    });
  }
}

async function load(): Promise<Notifier> {
  vi.resetModules();
  FakeNotification.permission = "granted";
  FakeNotification.answer = "granted";
  FakeNotification.instances = [];
  FakeNotification.requestPermission.mockClear();
  badge.length = 0;
  vi.stubGlobal("Notification", FakeNotification);
  setBadgeApi(true);
  vi.spyOn(window, "focus").mockImplementation(() => undefined);
  const mod = await import("../../../src/platform/browser/notifications");
  return mod.notifier;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setBadgeApi(false);
  document.title = "";
});

describeNotifierSuite(
  async () => {
    const subject = await load();
    return {
      subject,
      native: {
        permissionIs(granted) {
          FakeNotification.permission = granted ? "granted" : "default";
        },
        userAnswers(answer) {
          FakeNotification.answer = answer;
        },
        unavailable() {
          vi.stubGlobal("Notification", undefined);
        },
        shown: () =>
          FakeNotification.instances
            .filter((n) => n.options.data === undefined)
            .map((n) => ({ title: n.title, body: n.options.body ?? "" })),
        messageShown: () =>
          FakeNotification.instances
            .filter((n) => n.options.data !== undefined)
            .map((n) => ({ title: n.title, body: n.options.body ?? "", target: n.options.data! })),
        async emitsActivation(target) {
          // The user clicks a notification raised for this target.
          if (target.messageId === undefined) await subject.showCall("t", "b", target);
          else await subject.showMessage("t", "b", target);
          FakeNotification.instances.at(-1)!.click();
        },
        attentionRequests: () => 0,
        urgentAttentionRequests: () => 0,
        badgeCounts: () => [...badge],
        ringsShown: () =>
          FakeNotification.instances
            .filter((n) => n.options.requireInteraction === true)
            .map((n) => Number(n.options.tag?.split("-").at(-1))),
        callsCleared: () =>
          FakeNotification.instances
            .filter((n) => n.closed)
            .map((n) => Number(n.options.tag?.split("-").at(-1))),
      },
    };
  },
  { windowAttention: false },
);

describe("browser notifier", () => {
  it("observes the browser's permission, which is the page's own state", async () => {
    const notifier = await load();
    expect(notifier.readsOsPermission).toBe(true);
  });

  it("shows nothing without permission, and asks for none on its own", async () => {
    const notifier = await load();
    FakeNotification.permission = "denied";
    await notifier.show("t", "b");
    await notifier.showMessage("t", "b", { host: "h", channelId: 1, messageId: 2 });
    expect(FakeNotification.instances).toEqual([]);
    expect(FakeNotification.requestPermission).not.toHaveBeenCalled();
  });

  it("brings the tab forward and closes the notification when it is clicked", async () => {
    const notifier = await load();
    const focus = vi.mocked(window.focus);
    const handler = vi.fn();
    notifier.onMessageActivated(handler);
    await notifier.showMessage("t", "b", { host: "h", channelId: 7, messageId: 42 });
    FakeNotification.instances[0]!.click();
    expect(focus).toHaveBeenCalledOnce();
    expect(FakeNotification.instances[0]!.closed).toBe(true);
    expect(handler).toHaveBeenCalledExactlyOnceWith({ host: "h", channelId: 7, messageId: 42 });
  });

  it("does nothing to flash the window", async () => {
    const notifier = await load();
    await expect(notifier.flashTaskbar()).resolves.toBeUndefined();
    await expect(notifier.requestAttention()).resolves.toBeUndefined();
    expect(FakeNotification.instances).toEqual([]);
  });

  describe("unread badge without the Badging API", () => {
    it("prefixes the tab title with the count and restores it at zero", async () => {
      const notifier = await load();
      setBadgeApi(false);
      document.title = "OwnCord";
      await notifier.setUnreadBadge(3);
      expect(document.title).toBe("(3) OwnCord");
      await notifier.setUnreadBadge(5);
      expect(document.title).toBe("(5) OwnCord");
      await notifier.setUnreadBadge(0);
      expect(document.title).toBe("OwnCord");
    });

    it("caps a large count and ignores a count of zero when nothing was set", async () => {
      const notifier = await load();
      setBadgeApi(false);
      document.title = "OwnCord";
      await notifier.setUnreadBadge(0);
      expect(document.title).toBe("OwnCord");
      await notifier.setUnreadBadge(250);
      expect(document.title).toBe("(99+) OwnCord");
    });

    it("keeps a title the page changed while a count was showing", async () => {
      const notifier = await load();
      setBadgeApi(false);
      document.title = "OwnCord";
      await notifier.setUnreadBadge(2);
      document.title = "Other page";
      await notifier.setUnreadBadge(4);
      expect(document.title).toBe("(4) Other page");
      await notifier.setUnreadBadge(0);
      expect(document.title).toBe("Other page");
    });

    it("falls back to the title when the Badging API rejects", async () => {
      const notifier = await load();
      Object.defineProperty(navigator, "setAppBadge", {
        configurable: true,
        value: () => Promise.reject(new Error("not allowed")),
      });
      document.title = "OwnCord";
      await notifier.setUnreadBadge(2);
      expect(document.title).toBe("(2) OwnCord");
    });

    it("leaves the title alone when the Badging API took the count", async () => {
      const notifier = await load();
      document.title = "OwnCord";
      await notifier.setUnreadBadge(2);
      expect(document.title).toBe("OwnCord");
      expect(badge).toEqual([2]);
    });
  });
});
