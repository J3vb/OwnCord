import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServerBanner, applyConnectionStatus } from "@components/ServerBanner";

describe("ServerBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates element with reconnecting-banner class", () => {
    const banner = createServerBanner();
    expect(banner.element.classList.contains("reconnecting-banner")).toBe(true);
    banner.destroy();
  });

  it("showRestart adds visible class and shows countdown text", () => {
    const banner = createServerBanner();
    banner.showRestart(5);

    expect(banner.element.classList.contains("visible")).toBe(true);
    expect(banner.element.textContent).toBe("Server restarting in 5 seconds...");

    banner.destroy();
  });

  it('showReconnecting adds visible class with "Reconnecting..." text', () => {
    const banner = createServerBanner();
    banner.showReconnecting();

    expect(banner.element.classList.contains("visible")).toBe(true);
    expect(banner.element.textContent).toBe("Reconnecting...");

    banner.destroy();
  });

  it("hide removes visible class", () => {
    const banner = createServerBanner();
    banner.showReconnecting();
    expect(banner.element.classList.contains("visible")).toBe(true);

    banner.hide();
    expect(banner.element.classList.contains("visible")).toBe(false);

    banner.destroy();
  });

  it("showDisconnected adds visible class with the server-unreachable notice", () => {
    const banner = createServerBanner();
    banner.showDisconnected();

    expect(banner.element.classList.contains("visible")).toBe(true);
    expect(banner.element.textContent).toBe(
      "Can't reach this server right now. It may be down or blocked on this network.",
    );

    banner.destroy();
  });

  it("showDisconnected names the device's own network when it is offline", () => {
    const banner = createServerBanner();
    banner.showDisconnected({ offline: true });

    expect(banner.element.textContent).toBe(
      "This device has no network. Check your connection — your server may still be reachable on this network.",
    );
    // No retry over a network the device itself does not have.
    expect(banner.element.querySelector("button")).toBeNull();

    banner.destroy();
  });

  it("offers a Retry on a disconnect when the device has a network", () => {
    const banner = createServerBanner();
    const onRetry = vi.fn();
    banner.showDisconnected({ offline: false, onRetry });

    const retry = banner.element.querySelector("button");
    expect(retry?.textContent).toBe("Retry");
    retry!.click();
    retry!.click();
    expect(onRetry).toHaveBeenCalledTimes(1);

    banner.destroy();
  });

  it("showReconnecting keeps Reconnecting... until a dial has actually failed", () => {
    const banner = createServerBanner();
    const onRetry = vi.fn();
    banner.showReconnecting({ offline: false, onRetry });

    expect(banner.element.textContent).toBe("Reconnecting...");
    expect(banner.element.querySelector("button")).toBeNull();
    expect(banner.liveElement.textContent).toBe("Reconnecting...");

    banner.showReconnecting({ offline: false, dialFailed: true, onRetry });
    expect(banner.element.textContent).toBe(
      "Can't reach this server right now. It may be down or blocked on this network. Retry",
    );
    banner.element.querySelector("button")!.click();
    expect(onRetry).toHaveBeenCalledTimes(1);

    banner.destroy();
  });

  it("showReconnecting says the device is offline instead of promising progress", () => {
    const banner = createServerBanner();
    banner.showReconnecting({ offline: true });

    expect(banner.element.classList.contains("visible")).toBe(true);
    expect(banner.element.textContent).toBe(
      "This device has no network. Check your connection — your server may still be reachable on this network.",
    );
    // Never a Retry mid-backoff: the reconnect loop owns that.
    expect(banner.element.querySelector("button")).toBeNull();

    banner.destroy();
  });

  it("announces the notice once through its live region and clears it on hide", () => {
    const banner = createServerBanner();
    expect(banner.liveElement.getAttribute("role")).toBe("status");
    expect(banner.liveElement.textContent).toBe("");

    banner.showDisconnected();
    expect(banner.liveElement.textContent).toBe(
      "Can't reach this server right now. It may be down or blocked on this network.",
    );

    banner.hide();
    expect(banner.liveElement.textContent).toBe("");

    banner.destroy();
  });

  it("applyConnectionStatus maps each store status to the right banner state", () => {
    const banner = createServerBanner();

    applyConnectionStatus(banner, "reconnecting");
    expect(banner.element.classList.contains("visible")).toBe(true);
    expect(banner.element.textContent).toBe("Reconnecting...");

    applyConnectionStatus(banner, "disconnected");
    expect(banner.element.classList.contains("visible")).toBe(true);
    expect(banner.element.textContent).toBe(
      "Can't reach this server right now. It may be down or blocked on this network.",
    );

    applyConnectionStatus(banner, "connected");
    expect(banner.element.classList.contains("visible")).toBe(false);

    banner.destroy();
  });

  it("countdown decrements every second", () => {
    const banner = createServerBanner();
    banner.showRestart(3);

    expect(banner.element.textContent).toBe("Server restarting in 3 seconds...");

    vi.advanceTimersByTime(1000);
    expect(banner.element.textContent).toBe("Server restarting in 2 seconds...");

    vi.advanceTimersByTime(1000);
    expect(banner.element.textContent).toBe("Server restarting in 1 seconds...");

    banner.destroy();
  });

  it('countdown transitions to "Reconnecting..." at 0', () => {
    const banner = createServerBanner();
    banner.showRestart(2);

    vi.advanceTimersByTime(1000); // remaining = 1
    vi.advanceTimersByTime(1000); // remaining = 0 → showReconnecting

    expect(banner.element.textContent).toBe("Reconnecting...");

    banner.destroy();
  });

  it("signed-in-elsewhere shows a Use here action that calls back once", () => {
    const banner = createServerBanner();
    const onUseHere = vi.fn();
    banner.showSignedInElsewhere(onUseHere);

    expect(banner.element.classList.contains("visible")).toBe(true);
    expect(banner.element.textContent).toBe("Signed in elsewhere Use here");
    const button = banner.element.querySelector("button");
    button!.click();
    button!.click();
    expect(onUseHere).toHaveBeenCalledTimes(1);

    banner.showReconnecting();
    expect(banner.element.querySelector("button")).toBeNull();
    banner.destroy();
  });

  it("destroy removes element from DOM", () => {
    const banner = createServerBanner();
    const parent = document.createElement("div");
    parent.appendChild(banner.element);

    expect(parent.contains(banner.element)).toBe(true);

    banner.destroy();
    expect(parent.contains(banner.element)).toBe(false);
  });
});
