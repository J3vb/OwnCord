import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createConnectedOverlay } from "@components/ConnectedOverlay";

describe("ConnectedOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeOverlay(onReady = vi.fn()) {
    return createConnectedOverlay({
      serverName: "TestServer",
      username: "testuser",
      motd: "Welcome to the test server!",
      onReady,
    });
  }

  it("creates overlay element with connected-overlay class", () => {
    const overlay = makeOverlay();
    expect(overlay.element.classList.contains("connected-overlay")).toBe(true);
    overlay.destroy();
  });

  it("is hidden by default (no visible class)", () => {
    const overlay = makeOverlay();
    expect(overlay.element.classList.contains("visible")).toBe(false);
    overlay.destroy();
  });

  it("show() adds visible class", () => {
    const overlay = makeOverlay();
    overlay.show();
    expect(overlay.element.classList.contains("visible")).toBe(true);
    overlay.destroy();
  });

  it("renders server icon with first letter", () => {
    const overlay = makeOverlay();
    const icon = overlay.element.querySelector(".connected-srv-icon");
    expect(icon).not.toBeNull();
    expect(icon!.textContent).toBe("T");
    overlay.destroy();
  });

  it("renders connected text", () => {
    const overlay = makeOverlay();
    const text = overlay.element.querySelector(".connected-text");
    expect(text).not.toBeNull();
    expect(text!.textContent).toBe("Connected!");
    overlay.destroy();
  });

  it("renders username", () => {
    const overlay = makeOverlay();
    const user = overlay.element.querySelector(".connected-user");
    expect(user).not.toBeNull();
    expect(user!.textContent).toBe("Logged in as testuser");
    overlay.destroy();
  });

  it("renders MOTD", () => {
    const overlay = makeOverlay();
    const motd = overlay.element.querySelector(".connected-motd");
    expect(motd).not.toBeNull();
    expect(motd!.textContent).toBe("Welcome to the test server!");
    overlay.destroy();
  });

  it("renders loading spinner text", () => {
    const overlay = makeOverlay();
    const loader = overlay.element.querySelector(".connected-loader span");
    expect(loader).not.toBeNull();
    expect(loader!.textContent).toBe("Loading server data...");
    overlay.destroy();
  });

  it("renders check badge SVG", () => {
    const overlay = makeOverlay();
    const badge = overlay.element.querySelector(".connected-check-badge");
    expect(badge).not.toBeNull();
    const svg = badge!.querySelector("svg");
    expect(svg).not.toBeNull();
    overlay.destroy();
  });

  it("markReady() changes loader text", () => {
    const overlay = makeOverlay();
    overlay.markReady();
    const loader = overlay.element.querySelector(".connected-loader span");
    expect(loader!.textContent).toContain("Ready!");
    overlay.destroy();
  });

  it("markReady() hides spinner", () => {
    const overlay = makeOverlay();
    overlay.markReady();
    const spinner = overlay.element.querySelector(".spinner") as HTMLElement;
    expect(spinner.style.display).toBe("none");
    overlay.destroy();
  });

  it("markReady() calls onReady after delay", () => {
    const onReady = vi.fn();
    const overlay = makeOverlay(onReady);
    overlay.markReady();
    expect(onReady).not.toHaveBeenCalled();
    vi.advanceTimersByTime(800);
    expect(onReady).toHaveBeenCalledOnce();
    overlay.destroy();
  });

  it("destroy() prevents onReady callback", () => {
    const onReady = vi.fn();
    const overlay = makeOverlay(onReady);
    overlay.markReady();
    overlay.destroy();
    vi.advanceTimersByTime(800);
    expect(onReady).not.toHaveBeenCalled();
  });

  it("empty MOTD renders empty motd div", () => {
    const overlay = createConnectedOverlay({
      serverName: "Server",
      username: "user",
      motd: "",
      onReady: vi.fn(),
    });
    const motd = overlay.element.querySelector(".connected-motd");
    expect(motd).not.toBeNull();
    expect(motd!.textContent).toBe("");
    overlay.destroy();
  });
});
