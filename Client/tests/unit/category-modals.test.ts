import { afterEach, describe, expect, it, vi } from "vitest";
import { createCategoryNameModal, createDeleteCategoryModal } from "@components/CategoryModals";
import type { MountableComponent } from "@lib/text/safeRender";

describe("category dialogs close on their backdrop", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  const dialogs: ReadonlyArray<
    readonly [string, string, (onClose: () => void) => MountableComponent]
  > = [
    [
      "create",
      "create-category-modal",
      (onClose) =>
        createCategoryNameModal({ mode: "create", initialName: "", onSubmit: vi.fn(), onClose }),
    ],
    [
      "rename",
      "rename-category-modal",
      (onClose) =>
        createCategoryNameModal({ mode: "rename", initialName: "Old", onSubmit: vi.fn(), onClose }),
    ],
    [
      "delete",
      "delete-category-modal",
      (onClose) => createDeleteCategoryModal({ categoryName: "Old", onConfirm: vi.fn(), onClose }),
    ],
  ];

  it.each(dialogs)(
    "%s stays open when a drag-select ends on the backdrop, and a backdrop click still closes",
    (_name, testId, make) => {
      const onClose = vi.fn();
      const dialog = make(onClose);
      const container = document.createElement("div");
      document.body.appendChild(container);
      dialog.mount(container);
      const overlay = container.querySelector<HTMLElement>(`[data-testid='${testId}']`)!;
      overlay.querySelector(".modal")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(onClose).not.toHaveBeenCalled();
      overlay.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(onClose).toHaveBeenCalledOnce();
      dialog.destroy?.();
    },
  );

  it.each(dialogs)(
    "%s ignores Escape that cancels an IME candidate, and a plain Escape still closes",
    (_name, _testId, make) => {
      const onClose = vi.fn();
      const dialog = make(onClose);
      const container = document.createElement("div");
      document.body.appendChild(container);
      dialog.mount(container);
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }),
      );
      expect(onClose).not.toHaveBeenCalled();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(onClose).toHaveBeenCalledOnce();
      dialog.destroy?.();
    },
  );
});
