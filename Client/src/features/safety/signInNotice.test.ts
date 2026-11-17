import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionInfo } from "@lib/api";
import { createToastContainer, type ToastContainer } from "@lib/ui/toastContainer";
import { initToast, teardownToast } from "@lib/ui/toast";
import { uiStore } from "@stores/ui.store";
import { SIGN_IN_NOTICE_MS, showSignInNotice, signInNoticeDetail } from "./signInNotice";

const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.8127.18 Safari/537.36";

/** The detail line with its no-break spaces read as plain ones. */
const plain = (text: string | null | undefined): string => (text ?? "").replace(/\u00a0/g, " ");

function session(patch: Partial<SessionInfo>): SessionInfo {
  return {
    id: 1,
    device: CHROME_WINDOWS,
    ip: "203.0.113.7",
    created_at: "2026-11-13 09:09:00",
    last_used: "2026-11-13 09:09:00",
    is_current: false,
    unseen: true,
    ...patch,
  };
}

describe("signInNoticeDetail", () => {
  it("names the newest sign-in's device, address and time, without the raw User-Agent", () => {
    const detail = plain(signInNoticeDetail([session({})]));
    expect(detail).toMatch(/^Chrome on Windows · 203\.0\.113\.7 · .+/);
    expect(detail).not.toContain("Mozilla");
    expect(detail).not.toContain("more");
  });

  it("breaks the line only between parts, never inside one", () => {
    const parts = signInNoticeDetail([session({})]).split(" · ");
    expect(parts).toHaveLength(3);
    for (const part of parts) expect(part).not.toMatch(/ /);
    expect(plain(parts[0])).toBe("Chrome on Windows");
  });

  it("leaves the address out only when the session has none", () => {
    const detail = plain(signInNoticeDetail([session({ ip: "" })]));
    expect(detail).toMatch(/^Chrome on Windows · [^·]+$/);
    expect(plain(signInNoticeDetail([session({ device: "curl/8.0" })]))).toMatch(
      /^Unknown device · 203\.0\.113\.7 · /,
    );
  });

  it("counts the other unreviewed sign-ins after the newest", () => {
    const detail = plain(
      signInNoticeDetail([
        session({ id: 3 }),
        session({ id: 2, device: "OwnCord-Client/1.4.0" }),
        session({ id: 1, device: "" }),
      ]),
    );
    expect(detail).toMatch(/^Chrome on Windows · 203\.0\.113\.7 · .+, and 2 more$/);
    expect(signInNoticeDetail([])).toBe("");
  });
});

describe("showSignInNotice", () => {
  let host: HTMLDivElement;
  let toasts: ToastContainer;
  const toastEl = () => host.querySelector<HTMLElement>("[data-testid='toast']");

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement("div");
    toasts = createToastContainer();
    toasts.mount(host);
    initToast(toasts);
    uiStore.setState((s) => ({ ...s, settingsOpen: false, settingsTab: null }));
  });

  afterEach(() => {
    teardownToast();
    toasts.destroy?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shows a two-line alert with a shield, Review devices and a dismiss button", () => {
    showSignInNotice([session({})]);
    const el = toastEl()!;
    expect(el.querySelector(".toast-title")?.textContent).toBe(
      "Unreviewed sign-in to your account",
    );
    expect(el.querySelector(".toast-title")?.textContent).not.toMatch(/\bnew\b/i);
    expect(plain(el.querySelector(".toast-detail")?.textContent)).toMatch(
      /^Chrome on Windows · 203\.0\.113\.7 · /,
    );
    expect(el.querySelector("svg.toast-icon")).not.toBeNull();
    expect(el.querySelector(".toast-action")?.textContent).toBe("Review devices");
    expect(el.querySelector(".toast-close")?.getAttribute("aria-label")).toBeTruthy();
  });

  it("Review devices opens Settings on the devices list and dismisses the alert", () => {
    showSignInNotice([session({})]);
    toastEl()!.querySelector<HTMLButtonElement>(".toast-action")!.click();
    expect(uiStore.getState().settingsOpen).toBe(true);
    expect(uiStore.getState().settingsTab).toBe("Devices");
    vi.advanceTimersByTime(400);
    expect(toastEl()).toBeNull();
  });

  it("shows several unreviewed sign-ins as one alert that clears itself after the same time as before", () => {
    showSignInNotice([session({ device: "" }), session({ id: 2 })]);
    expect(host.querySelectorAll("[data-testid='toast']")).toHaveLength(1);
    expect(plain(toastEl()?.querySelector(".toast-detail")?.textContent)).toMatch(
      /^Unknown device · 203\.0\.113\.7 · .+, and 1 more$/,
    );
    vi.advanceTimersByTime(SIGN_IN_NOTICE_MS - 1);
    expect(toastEl()).not.toBeNull();
    vi.advanceTimersByTime(401);
    expect(toastEl()).toBeNull();
  });

  it("uses the short title at phone width", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    showSignInNotice([session({})]);
    expect(toastEl()?.querySelector(".toast-title")?.textContent).toBe("Unreviewed sign-in");
  });

  it("shows nothing for an empty listing", () => {
    showSignInNotice([]);
    expect(toastEl()).toBeNull();
  });
});
