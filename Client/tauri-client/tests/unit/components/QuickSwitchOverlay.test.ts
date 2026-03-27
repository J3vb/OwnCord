import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createQuickSwitchOverlay } from "@components/QuickSwitchOverlay";

describe("QuickSwitchOverlay", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders server list from profiles", () => {
    const overlay = createQuickSwitchOverlay({
      profiles: [
        { name: "My Server", host: "localhost:8443" },
        { name: "LAN Party", host: "10.0.0.5:8443" },
      ],
      currentHost: "localhost:8443",
      onSwitch: vi.fn(),
      onAddServer: vi.fn(),
      onClose: vi.fn(),
    });
    overlay.mount(container);
    const items = container.querySelectorAll("[data-testid='server-item']");
    expect(items.length).toBe(2);
    overlay.destroy?.();
  });

  it("highlights current server", () => {
    const overlay = createQuickSwitchOverlay({
      profiles: [{ name: "My Server", host: "localhost:8443" }],
      currentHost: "localhost:8443",
      onSwitch: vi.fn(),
      onAddServer: vi.fn(),
      onClose: vi.fn(),
    });
    overlay.mount(container);
    const current = container.querySelector("[data-testid='server-item'].current");
    expect(current).not.toBeNull();
    overlay.destroy?.();
  });

  it("calls onSwitch when clicking a different server", () => {
    const onSwitch = vi.fn();
    const overlay = createQuickSwitchOverlay({
      profiles: [
        { name: "Server A", host: "a:8443" },
        { name: "Server B", host: "b:8443" },
      ],
      currentHost: "a:8443",
      onSwitch,
      onAddServer: vi.fn(),
      onClose: vi.fn(),
    });
    overlay.mount(container);
    const items = container.querySelectorAll("[data-testid='server-item']");
    (items[1] as HTMLElement).click();
    expect(onSwitch).toHaveBeenCalledWith("b:8443", "Server B");
    overlay.destroy?.();
  });

  it("calls onClose on escape key", () => {
    const onClose = vi.fn();
    const overlay = createQuickSwitchOverlay({
      profiles: [{ name: "My Server", host: "localhost:8443" }],
      currentHost: "localhost:8443",
      onSwitch: vi.fn(),
      onAddServer: vi.fn(),
      onClose,
    });
    overlay.mount(container);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();
    overlay.destroy?.();
  });
});
