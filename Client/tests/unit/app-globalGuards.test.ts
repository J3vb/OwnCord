/**
 * Tests for src/app/globalGuards.ts: the document-level guards main.ts
 * installs once at startup. The module has no top-level effect, so nothing is
 * registered until installGlobalGuards() is called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const open = vi.hoisted(() => vi.fn<(url: string) => Promise<void>>());
const devToolsOpen = vi.hoisted(() => vi.fn<() => Promise<void>>());
const guardMaskedLink = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());
const installFileDropGuard = vi.hoisted(() => vi.fn());
const installTouchInput = vi.hoisted(() => vi.fn());

vi.mock("../../src/platform/desktop", () => ({
  desktop: { urlOpener: { open }, devTools: { open: devToolsOpen } },
}));
vi.mock("../../src/features/messaging/fileDropGuard", () => ({ installFileDropGuard }));
vi.mock("@lib/ui/toast", () => ({ showToast }));
vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
}));
vi.mock("@components/MaskedLinkGuard", () => ({ guardMaskedLink }));
vi.mock("@lib/ui/touchInput", () => ({ installTouchInput }));

import { installGlobalGuards, lockPageZoom } from "../../src/app/globalGuards";
import { connectText } from "../../src/i18n/connect";

let added: Array<[string, EventListenerOrEventListenerObject]> = [];
const realAdd = document.addEventListener.bind(document);

function link(href: string, masked: boolean): HTMLAnchorElement {
  const a = document.createElement("a");
  a.href = href;
  a.target = "_blank";
  if (masked) a.className = "masked";
  document.body.append(a);
  return a;
}

function click(el: Element): MouseEvent {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

beforeEach(() => {
  vi.clearAllMocks();
  open.mockResolvedValue(undefined);
  devToolsOpen.mockResolvedValue(undefined);
  added = [];
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, opts) => {
    added.push([type, listener]);
    realAdd(type, listener, opts);
  });
});

afterEach(() => {
  for (const [type, listener] of added) document.removeEventListener(type, listener);
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("installGlobalGuards", () => {
  it("registers nothing at import time, then three document listeners and the drop guard on install", async () => {
    vi.resetModules();
    const fresh = await import("../../src/app/globalGuards");
    expect(added).toEqual([]);
    expect(installFileDropGuard).not.toHaveBeenCalled();
    fresh.installGlobalGuards();
    expect(added.map(([type]) => type)).toEqual(["contextmenu", "keydown", "click"]);
    expect(installFileDropGuard).toHaveBeenCalledOnce();
  });

  it("blocks the context menu except on text fields", () => {
    installGlobalGuards();
    const input = document.createElement("input");
    document.body.append(input);
    const plain = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    document.body.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(true);
    const field = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    input.dispatchEvent(field);
    expect(field.defaultPrevented).toBe(false);
  });

  it("blocks F5 and Ctrl+R in either case", () => {
    installGlobalGuards();
    for (const init of [{ key: "F5" }, { key: "r", ctrlKey: true }, { key: "R", ctrlKey: true }]) {
      const ev = new KeyboardEvent("keydown", { ...init, cancelable: true });
      document.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(devToolsOpen).not.toHaveBeenCalled();
  });

  it("opens DevTools on F12 and Ctrl+Shift+I in dev builds and logs a failed open", async () => {
    vi.stubEnv("DEV", true);
    devToolsOpen.mockRejectedValueOnce(new Error("boom"));
    installGlobalGuards();
    const f12 = new KeyboardEvent("keydown", { key: "F12", cancelable: true });
    document.dispatchEvent(f12);
    expect(f12.defaultPrevented).toBe(true);
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith("devtools open failed", expect.any(Error)),
    );
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "I", ctrlKey: true, shiftKey: true, cancelable: true }),
    );
    expect(devToolsOpen).toHaveBeenCalledTimes(2);
  });

  it("leaves F12 alone in production builds", () => {
    vi.stubEnv("DEV", false);
    installGlobalGuards();
    const f12 = new KeyboardEvent("keydown", { key: "F12", cancelable: true });
    document.dispatchEvent(f12);
    expect(f12.defaultPrevented).toBe(false);
    expect(devToolsOpen).not.toHaveBeenCalled();
  });

  it("opens a plain external link in the default browser and logs a failed open", async () => {
    installGlobalGuards();
    const ev = click(link("https://example.com/a", false));
    expect(ev.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith("https://example.com/a");
    expect(guardMaskedLink).not.toHaveBeenCalled();
    open.mockRejectedValueOnce(new Error("nope"));
    click(link("http://example.com/b", false));
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith("external link open failed", expect.any(Error)),
    );
  });

  it("ignores clicks outside a target=_blank link and links that are not http(s)", () => {
    installGlobalGuards();
    const plain = click(document.body);
    expect(plain.defaultPrevented).toBe(false);
    const mail = click(link("mailto:a@example.com", false));
    expect(mail.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("routes a masked link through the lazily loaded guard", async () => {
    installGlobalGuards();
    click(link("https://masked.example/p", true));
    await vi.waitFor(() => expect(guardMaskedLink).toHaveBeenCalledOnce());
    expect(guardMaskedLink.mock.calls[0]![0]).toBe("https://masked.example/p");
    expect(open).not.toHaveBeenCalled();
  });

  it("warns and toasts when the masked-link dialog fails to load", async () => {
    vi.resetModules();
    vi.doMock("@components/MaskedLinkGuard", () => {
      throw new Error("chunk failed");
    });
    const fresh = await import("../../src/app/globalGuards");
    fresh.installGlobalGuards();
    click(link("https://masked.example/q", true));
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith("masked link warning failed to load", expect.any(Error)),
    );
    expect(showToast).toHaveBeenCalledExactlyOnceWith(connectText("link.openFailed"), "error");
    expect(guardMaskedLink).not.toHaveBeenCalled();
    vi.doUnmock("@components/MaskedLinkGuard");
  });

  describe("touch input", () => {
    function stubPointer(coarse: boolean): void {
      vi.stubGlobal(
        "matchMedia",
        vi.fn((q: string) => ({ matches: coarse && q === "(any-pointer: coarse)" })),
      );
    }
    afterEach(() => vi.unstubAllGlobals());

    it("loads and installs the touch module when a coarse pointer exists", async () => {
      stubPointer(true);
      installGlobalGuards();
      await vi.waitFor(() => expect(installTouchInput).toHaveBeenCalledOnce());
      expect(installTouchInput.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    });

    it("never loads it on a fine-pointer device", async () => {
      stubPointer(false);
      installGlobalGuards();
      await Promise.resolve();
      expect(installTouchInput).not.toHaveBeenCalled();
    });

    it("logs and ignores a failed chunk load", async () => {
      stubPointer(true);
      vi.resetModules();
      vi.doMock("@lib/ui/touchInput", () => {
        throw new Error("chunk failed");
      });
      const fresh = await import("../../src/app/globalGuards");
      expect(() => fresh.installGlobalGuards()).not.toThrow();
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith("touch input failed to load", expect.any(Error)),
      );
      vi.doMock("@lib/ui/touchInput", () => ({ installTouchInput }));
    });
  });
});

describe("lockPageZoom", () => {
  it("adds the no-zoom terms to the viewport meta once", () => {
    const meta = document.createElement("meta");
    meta.name = "viewport";
    meta.content = "width=device-width, initial-scale=1";
    document.head.append(meta);
    try {
      lockPageZoom();
      lockPageZoom();
      expect(meta.content).toBe(
        "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no",
      );
    } finally {
      meta.remove();
    }
  });

  it("does nothing without a viewport meta", () => {
    expect(() => lockPageZoom()).not.toThrow();
  });
});
