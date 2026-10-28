import { afterEach, describe, expect, it, vi } from "vitest";
import { showWhatsNewDialog } from "../../src/features/whats-new/WhatsNewDialog";

describe("What's new dialog backdrop", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("stays open when a drag-select ends on the backdrop, and a backdrop click still closes", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onClosed = vi.fn();
    const dialog = showWhatsNewDialog(
      container,
      { version: "1.0.0", body: "- x" },
      vi.fn(),
      onClosed,
    );
    const overlay = container.querySelector<HTMLElement>("[data-testid=whats-new-dialog]")!;
    overlay.querySelector(".modal")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClosed).not.toHaveBeenCalled();
    expect(overlay.isConnected).toBe(true);
    overlay.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onClosed).toHaveBeenCalledOnce();
    expect(overlay.isConnected).toBe(false);
    dialog.destroy();
  });
});
