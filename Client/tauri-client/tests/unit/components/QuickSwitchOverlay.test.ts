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

  it("applies dialog semantics to the modal", () => {
    const overlay = createQuickSwitchOverlay({
      profiles: [{ name: "My Server", host: "localhost:8443" }],
      currentHost: "localhost:8443",
      onSwitch: vi.fn(),
      onAddServer: vi.fn(),
      onClose: vi.fn(),
    });
    overlay.mount(container);
    const modal = container.querySelector(".quick-switch-modal");
    expect(modal?.getAttribute("role")).toBe("dialog");
    expect(modal?.getAttribute("aria-modal")).toBe("true");
    expect(modal?.getAttribute("aria-label")).toBe("Switch server");
    overlay.destroy?.();
  });

  it("gives switchable items button semantics but keeps the current row inert", () => {
    const overlay = createQuickSwitchOverlay({
      profiles: [
        { name: "Server A", host: "a:8443" },
        { name: "Server B", host: "b:8443" },
      ],
      currentHost: "a:8443",
      onSwitch: vi.fn(),
      onAddServer: vi.fn(),
      onClose: vi.fn(),
    });
    overlay.mount(container);
    const items = container.querySelectorAll("[data-testid='server-item']");
    // Current server row has no action, so it must not claim to be a button
    expect(items[0]!.hasAttribute("role")).toBe(false);
    expect(items[0]!.hasAttribute("tabindex")).toBe(false);
    expect(items[1]!.getAttribute("role")).toBe("button");
    expect(items[1]!.getAttribute("tabindex")).toBe("0");
    const addBtn = container.querySelector("[data-testid='add-server-btn']");
    expect(addBtn?.getAttribute("role")).toBe("button");
    expect(addBtn?.getAttribute("tabindex")).toBe("0");
    overlay.destroy?.();
  });

  it("Enter activates a server item", () => {
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
    items[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSwitch).toHaveBeenCalledWith("b:8443", "Server B");
    overlay.destroy?.();
  });

  it("Space activates the add-server button", () => {
    const onAddServer = vi.fn();
    const overlay = createQuickSwitchOverlay({
      profiles: [{ name: "My Server", host: "localhost:8443" }],
      currentHost: "localhost:8443",
      onSwitch: vi.fn(),
      onAddServer,
      onClose: vi.fn(),
    });
    overlay.mount(container);
    const addBtn = container.querySelector("[data-testid='add-server-btn']") as HTMLElement;
    addBtn.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(onAddServer).toHaveBeenCalledOnce();
    overlay.destroy?.();
  });

  it("moves focus into the dialog on mount and restores it on destroy", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const overlay = createQuickSwitchOverlay({
      profiles: [
        { name: "Server A", host: "a:8443" },
        { name: "Server B", host: "b:8443" },
      ],
      currentHost: "a:8443",
      onSwitch: vi.fn(),
      onAddServer: vi.fn(),
      onClose: vi.fn(),
    });
    overlay.mount(container);
    const modal = container.querySelector(".quick-switch-modal");
    expect(modal?.contains(document.activeElement)).toBe(true);

    overlay.destroy?.();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
