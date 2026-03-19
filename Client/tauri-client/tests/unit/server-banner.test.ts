import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServerBanner } from "@components/ServerBanner";

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

  it("destroy removes element from DOM", () => {
    const banner = createServerBanner();
    const parent = document.createElement("div");
    parent.appendChild(banner.element);

    expect(parent.contains(banner.element)).toBe(true);

    banner.destroy();
    expect(parent.contains(banner.element)).toBe(false);
  });
});
