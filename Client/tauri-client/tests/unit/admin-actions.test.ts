import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemberContextMenu, createChannelContextMenu } from "@components/AdminActions";
import type { MemberContextMenuOptions, ChannelContextMenuOptions } from "@components/AdminActions";

describe("AdminActions", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  describe("MemberContextMenu", () => {
    function makeMenu(overrides?: Partial<MemberContextMenuOptions>) {
      const options: MemberContextMenuOptions = {
        userId: 1,
        username: "TestUser",
        currentRole: "member",
        availableRoles: ["admin", "moderator", "member"],
        showAdminActions: overrides?.showAdminActions ?? true,
        isBlocked: overrides?.isBlocked ?? false,
        onToggleBlock: overrides?.onToggleBlock ?? vi.fn(async () => {}),
        onKick: overrides?.onKick ?? vi.fn(async () => {}),
        onBan: overrides?.onBan ?? vi.fn(async () => {}),
        onChangeRole: overrides?.onChangeRole ?? vi.fn(async () => {}),
      };
      const result = createMemberContextMenu(options);
      container.appendChild(result.element);
      return { result, options };
    }

    it("creates element with context-menu class", () => {
      const { result } = makeMenu();
      expect(result.element.classList.contains("context-menu")).toBe(true);
      result.destroy();
    });

    it("renders Change Role item", () => {
      const { result } = makeMenu();
      const items = result.element.querySelectorAll(".context-menu__item");
      const texts = Array.from(items).map((i) => i.textContent);
      expect(texts.some((t) => t?.includes("Change Role"))).toBe(true);
      result.destroy();
    });

    it("renders role submenu with available roles", () => {
      const { result } = makeMenu();
      const submenu = result.element.querySelector(".context-menu__submenu");
      expect(submenu).not.toBeNull();

      const roleItems = submenu!.querySelectorAll(".context-menu__item");
      const roleTexts = Array.from(roleItems).map((r) => r.textContent);
      expect(roleTexts).toContain("admin");
      expect(roleTexts).toContain("moderator");
      expect(roleTexts).toContain("member");
      result.destroy();
    });

    it("marks current role as active in submenu", () => {
      const { result } = makeMenu();
      const submenu = result.element.querySelector(".context-menu__submenu");
      const activeRole = submenu!.querySelector(".context-menu__item--active");
      expect(activeRole).not.toBeNull();
      expect(activeRole!.textContent).toBe("member");
      result.destroy();
    });

    it("renders Kick and Ban items with danger class", () => {
      const { result } = makeMenu();
      const dangerItems = result.element.querySelectorAll(".context-menu__item--danger");
      const texts = Array.from(dangerItems).map((i) => i.textContent);
      expect(texts).toContain("Kick");
      expect(texts).toContain("Ban");
      result.destroy();
    });

    it("Kick requires double-click confirmation", () => {
      const onKick = vi.fn(async () => {});
      const { result } = makeMenu({ onKick });

      const dangerItems = result.element.querySelectorAll(".context-menu__item--danger");
      const kickItem = Array.from(dangerItems).find(
        (i) => i.textContent === "Kick",
      ) as HTMLDivElement;

      // First click changes text to confirmation
      kickItem.click();
      expect(kickItem.textContent).toBe("Are you sure?");
      expect(onKick).not.toHaveBeenCalled();

      // Second click confirms
      kickItem.click();
      expect(onKick).toHaveBeenCalledOnce();
      result.destroy();
    });

    it("Ban asks for a reason before it fires", () => {
      const onBan = vi.fn(async () => {});
      const { result } = makeMenu({ onBan });

      const dangerItems = result.element.querySelectorAll(".context-menu__item--danger");
      const banItem = Array.from(dangerItems).find(
        (i) => i.textContent === "Ban",
      ) as HTMLDivElement;

      banItem.click();
      expect(onBan).not.toHaveBeenCalled();

      const reasonInput = result.element.querySelector(
        "[data-testid='ban-reason-input']",
      ) as HTMLInputElement;
      expect(reasonInput).not.toBeNull();
      reasonInput.value = "  spamming  ";

      const confirm = result.element.querySelector("[data-testid='ban-confirm']") as HTMLDivElement;
      confirm.click();

      // The server stores and displays the reason, so it's trimmed, not raw.
      // Default duration is 0 (permanent).
      expect(onBan).toHaveBeenCalledWith("spamming", 0);
      result.destroy();
    });

    it("Ban passes the selected duration in hours", () => {
      const onBan = vi.fn(async () => {});
      const { result } = makeMenu({ onBan });

      const banItem = Array.from(
        result.element.querySelectorAll(".context-menu__item--danger"),
      ).find((i) => i.textContent === "Ban") as HTMLDivElement;
      banItem.click();

      const durationSelect = result.element.querySelector(
        "[data-testid='ban-duration-select']",
      ) as HTMLSelectElement;
      expect(durationSelect).not.toBeNull();
      durationSelect.value = "24";

      (result.element.querySelector("[data-testid='ban-confirm']") as HTMLDivElement).click();

      expect(onBan).toHaveBeenCalledWith("", 24);
      result.destroy();
    });

    it("Ban sends an empty reason when none is typed", () => {
      const onBan = vi.fn(async () => {});
      const { result } = makeMenu({ onBan });

      const banItem = Array.from(
        result.element.querySelectorAll(".context-menu__item--danger"),
      ).find((i) => i.textContent === "Ban") as HTMLDivElement;
      banItem.click();
      (result.element.querySelector("[data-testid='ban-confirm']") as HTMLDivElement).click();

      expect(onBan).toHaveBeenCalledWith("", 0);
      result.destroy();
    });

    it("Ban ignores a second click while the request is in flight", () => {
      let release: (() => void) | null = null;
      const onBan = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const { result } = makeMenu({ onBan });

      const banItem = Array.from(
        result.element.querySelectorAll(".context-menu__item--danger"),
      ).find((i) => i.textContent === "Ban") as HTMLDivElement;
      banItem.click();
      const confirm = result.element.querySelector("[data-testid='ban-confirm']") as HTMLDivElement;
      confirm.click();
      expect(confirm.textContent).toBe("Banning...");
      confirm.click();

      expect(onBan).toHaveBeenCalledTimes(1);
      release!();
      result.destroy();
    });

    it("Kick shows an in-flight state and disarms after a pause", async () => {
      vi.useFakeTimers();
      try {
        let release: (() => void) | null = null;
        const onKick = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        );
        const { result } = makeMenu({ onKick });
        const kickItem = Array.from(
          result.element.querySelectorAll(".context-menu__item--danger"),
        ).find((i) => i.textContent === "Kick") as HTMLDivElement;

        // Armed, then left alone — a stray later click must not kick anyone.
        kickItem.click();
        expect(kickItem.textContent).toBe("Are you sure?");
        vi.advanceTimersByTime(5000);
        expect(kickItem.textContent).toBe("Kick");
        kickItem.click();
        expect(onKick).not.toHaveBeenCalled();

        kickItem.click();
        expect(onKick).toHaveBeenCalledOnce();
        expect(kickItem.textContent).toBe("Kicking...");

        release!();
        await vi.waitFor(() => {
          expect(kickItem.textContent).toBe("Kick");
        });
        result.destroy();
      } finally {
        vi.useRealTimers();
      }
    });

    it("renders separator between role and danger items", () => {
      const { result } = makeMenu();
      const separator = result.element.querySelector(".context-menu__separator");
      expect(separator).not.toBeNull();
      result.destroy();
    });

    it("destroy removes element from DOM", () => {
      const { result } = makeMenu();
      expect(container.querySelector(".context-menu")).not.toBeNull();
      result.destroy();
      expect(container.querySelector(".context-menu")).toBeNull();
    });

    it("renders only the Block item when showAdminActions is false", () => {
      const { result } = makeMenu({ showAdminActions: false });
      const items = result.element.querySelectorAll(".context-menu__item");
      const texts = Array.from(items).map((i) => i.textContent);
      expect(texts).toEqual(["Block"]);
      result.destroy();
    });

    it("Block requires double-click confirmation", () => {
      const onToggleBlock = vi.fn(async () => {});
      const { result } = makeMenu({ showAdminActions: false, onToggleBlock });
      const blockItem = result.element.querySelector<HTMLElement>('[data-testid="block-toggle"]');
      expect(blockItem).not.toBeNull();
      blockItem?.click();
      expect(blockItem?.textContent).toBe("Are you sure?");
      expect(onToggleBlock).not.toHaveBeenCalled();
      blockItem?.click();
      expect(onToggleBlock).toHaveBeenCalledOnce();
      result.destroy();
    });

    it("Unblock fires on a single click when already blocked", () => {
      const onToggleBlock = vi.fn(async () => {});
      const { result } = makeMenu({ showAdminActions: false, isBlocked: true, onToggleBlock });
      const blockItem = result.element.querySelector<HTMLElement>('[data-testid="block-toggle"]');
      expect(blockItem?.textContent).toBe("Unblock");
      blockItem?.click();
      expect(onToggleBlock).toHaveBeenCalledOnce();
      result.destroy();
    });

    it("admin menu also includes the Block item", () => {
      const { result } = makeMenu();
      const blockItem = result.element.querySelector('[data-testid="block-toggle"]');
      expect(blockItem).not.toBeNull();
      result.destroy();
    });
  });

  describe("ChannelContextMenu", () => {
    function makeMenu(overrides?: Partial<ChannelContextMenuOptions>) {
      const options: ChannelContextMenuOptions = {
        channelId: 1,
        channelName: "general",
        onEdit: overrides?.onEdit ?? vi.fn(),
        onDelete: overrides?.onDelete ?? vi.fn(async () => {}),
        onCreate: overrides?.onCreate ?? vi.fn(),
      };
      const result = createChannelContextMenu(options);
      container.appendChild(result.element);
      return { result, options };
    }

    it("creates element with context-menu class", () => {
      const { result } = makeMenu();
      expect(result.element.classList.contains("context-menu")).toBe(true);
      result.destroy();
    });

    it("renders Edit Channel, Create Channel, and Delete Channel items", () => {
      const { result } = makeMenu();
      const items = result.element.querySelectorAll(".context-menu__item");
      const texts = Array.from(items).map((i) => i.textContent);

      expect(texts).toContain("Edit Channel");
      expect(texts).toContain("Create Channel");
      expect(texts).toContain("Delete Channel");
      result.destroy();
    });

    it("clicking Edit Channel calls onEdit", () => {
      const onEdit = vi.fn();
      const { result } = makeMenu({ onEdit });

      const items = result.element.querySelectorAll(".context-menu__item");
      const editItem = Array.from(items).find(
        (i) => i.textContent === "Edit Channel",
      ) as HTMLDivElement;
      editItem.click();

      expect(onEdit).toHaveBeenCalledOnce();
      result.destroy();
    });

    it("clicking Create Channel calls onCreate", () => {
      const onCreate = vi.fn();
      const { result } = makeMenu({ onCreate });

      const items = result.element.querySelectorAll(".context-menu__item");
      const createItem = Array.from(items).find(
        (i) => i.textContent === "Create Channel",
      ) as HTMLDivElement;
      createItem.click();

      expect(onCreate).toHaveBeenCalledOnce();
      result.destroy();
    });

    it("Delete Channel requires double-click confirmation", () => {
      const onDelete = vi.fn(async () => {});
      const { result } = makeMenu({ onDelete });

      const dangerItems = result.element.querySelectorAll(".context-menu__item--danger");
      const deleteItem = dangerItems[0] as HTMLDivElement;

      deleteItem.click();
      expect(deleteItem.textContent).toBe("Are you sure?");
      expect(onDelete).not.toHaveBeenCalled();

      deleteItem.click();
      expect(onDelete).toHaveBeenCalledOnce();
      result.destroy();
    });

    it("destroy removes element from DOM", () => {
      const { result } = makeMenu();
      expect(container.querySelector(".context-menu")).not.toBeNull();
      result.destroy();
      expect(container.querySelector(".context-menu")).toBeNull();
    });
  });
});
