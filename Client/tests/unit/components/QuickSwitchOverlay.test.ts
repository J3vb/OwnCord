import { describe, it, expect, vi } from "vitest";
import { createQuickSwitchOverlay } from "@components/QuickSwitchOverlay";
import type { QuickSwitchOverlayOptions } from "@components/QuickSwitchOverlay";
import { useMountContainer } from "../../helpers/mountContainer";

const ONE_SERVER = {
  profiles: [{ name: "My Server", host: "localhost:8443" }],
  currentHost: "localhost:8443",
};
const TWO_SERVERS = {
  profiles: [
    { name: "Server A", host: "a:8443" },
    { name: "Server B", host: "b:8443" },
  ],
  currentHost: "a:8443",
};

describe("QuickSwitchOverlay", () => {
  let container: HTMLDivElement;
  useMountContainer((mounted) => {
    container = mounted;
  });

  function mountOverlay(
    opts: Pick<QuickSwitchOverlayOptions, "profiles" | "currentHost"> &
      Partial<QuickSwitchOverlayOptions>,
  ) {
    const overlay = createQuickSwitchOverlay({
      onSwitch: vi.fn(),
      onAddServer: vi.fn(),
      onClose: vi.fn(),
      ...opts,
    });
    overlay.mount(container);
    return overlay;
  }

  it("renders server list from profiles", () => {
    const overlay = mountOverlay({
      profiles: [
        { name: "My Server", host: "localhost:8443" },
        { name: "LAN Party", host: "10.0.0.5:8443" },
      ],
      currentHost: "localhost:8443",
    });
    const items = container.querySelectorAll("[data-testid='server-item']");
    expect(items.length).toBe(2);
    overlay.destroy?.();
  });

  it("stays open when a drag-select ends on the backdrop, and a backdrop click still closes", () => {
    const onClose = vi.fn();
    const overlay = mountOverlay({
      ...ONE_SERVER,
      onClose,
    });
    const root = container.querySelector<HTMLElement>("[data-testid='quick-switch-overlay']")!;
    root
      .querySelector(".quick-switch-modal")!
      .dispatchEvent(new Event("pointerdown", { bubbles: true }));
    root.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    root.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    root.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
    overlay.destroy?.();
  });

  it("highlights current server", () => {
    const overlay = mountOverlay({
      ...ONE_SERVER,
    });
    const current = container.querySelector("[data-testid='server-item'].current");
    expect(current).not.toBeNull();
    overlay.destroy?.();
  });

  it("calls onSwitch when clicking a different server", () => {
    const onSwitch = vi.fn();
    const overlay = mountOverlay({
      ...TWO_SERVERS,
      onSwitch,
    });
    const items = container.querySelectorAll("[data-testid='server-item']");
    (items[1] as HTMLElement).click();
    expect(onSwitch).toHaveBeenCalledWith("b:8443", "Server B");
    overlay.destroy?.();
  });

  it("calls onClose on escape key", () => {
    const onClose = vi.fn();
    const overlay = mountOverlay({
      ...ONE_SERVER,
      onClose,
    });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalled();
    overlay.destroy?.();
  });

  it("applies dialog semantics to the modal", () => {
    const overlay = mountOverlay({
      ...ONE_SERVER,
    });
    const modal = container.querySelector(".quick-switch-modal");
    expect(modal?.getAttribute("role")).toBe("dialog");
    expect(modal?.getAttribute("aria-modal")).toBe("true");
    expect(modal?.getAttribute("aria-label")).toBe("Switch server");
    overlay.destroy?.();
  });

  it("gives switchable items button semantics but keeps the current row inert", () => {
    const overlay = mountOverlay({
      ...TWO_SERVERS,
    });
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
    const overlay = mountOverlay({
      ...TWO_SERVERS,
      onSwitch,
    });
    const items = container.querySelectorAll("[data-testid='server-item']");
    items[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onSwitch).toHaveBeenCalledWith("b:8443", "Server B");
    overlay.destroy?.();
  });

  it("Space activates the add-server button", () => {
    const onAddServer = vi.fn();
    const overlay = mountOverlay({
      ...ONE_SERVER,
      onAddServer,
    });
    const addBtn = container.querySelector("[data-testid='add-server-btn']") as HTMLElement;
    addBtn.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(onAddServer).toHaveBeenCalledOnce();
    overlay.destroy?.();
  });

  it("moves focus into the dialog on mount and restores it on destroy", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();

    const overlay = mountOverlay({
      ...TWO_SERVERS,
    });
    const modal = container.querySelector(".quick-switch-modal");
    expect(modal?.contains(document.activeElement)).toBe(true);

    overlay.destroy?.();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
