import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let stickerOpts: {
  onSelect: (s: { id: number; name: string }) => void;
  onClose: () => void;
  canManage: boolean;
} | null = null;

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => {
    const element = document.createElement("div");
    element.classList.add("emoji-picker");
    return { element, destroy: vi.fn() };
  },
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => {
    const element = document.createElement("div");
    element.classList.add("gif-picker");
    return { element, destroy: vi.fn() };
  },
}));
vi.mock("@components/StickerPicker", () => ({
  createStickerPicker: (opts: NonNullable<typeof stickerOpts>) => {
    stickerOpts = opts;
    const element = document.createElement("div");
    element.classList.add("sticker-picker");
    return { element, destroy: vi.fn() };
  },
}));

import { createMessageInput, type MessageInputOptions } from "@components/MessageInput";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/serverCapabilities";
import type { GifApi, GifFavoritesApi } from "@lib/gifProvider";

const gifApi: GifApi & GifFavoritesApi = {
  gifSearch: vi.fn(async () => ({ results: [] })),
  gifTrending: vi.fn(async () => ({ results: [] })),
  gifFavorites: vi.fn(async () => ({ favorites: [] })),
  addGifFavorite: vi.fn(async () => undefined),
  removeGifFavorite: vi.fn(async () => undefined),
};

describe("expression popup", () => {
  let container: HTMLDivElement;
  let comp: ReturnType<typeof createMessageInput>;
  const onSendSticker = vi.fn();
  const onSend = vi.fn();

  function mount(overrides: Partial<MessageInputOptions> = {}): void {
    comp = createMessageInput({
      channelId: 1,
      channelName: "general",
      gifApi,
      onSend,
      onTyping: vi.fn(),
      onSendSticker,
      ...overrides,
    });
    comp.mount(container);
  }
  const btn = (name: string): HTMLButtonElement => container.querySelector(`.${name}-btn`)!;
  const popup = (): HTMLElement | null => container.querySelector(".expression-popup");
  const tab = (name: string): HTMLElement =>
    container.querySelector(`[data-testid="xp-tab-${name}"]`)!;
  const selected = (): string | undefined =>
    container.querySelector<HTMLElement>('.xp-tab[aria-selected="true"]')?.dataset["tab"];
  async function settle(): Promise<void> {
    await vi.dynamicImportSettled();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    applyReadyCapabilities({ stickers: true });
    stickerOpts = null;
    onSendSticker.mockClear();
    onSend.mockClear();
  });
  afterEach(() => {
    comp.destroy?.();
    container.remove();
    resetServerCapabilities();
  });

  it("puts the sticker button between the emoji and GIF buttons", () => {
    mount();
    const order = ["emoji-btn", "sticker-btn", "gif-btn"].map((c) =>
      Array.from(container.querySelectorAll("button")).findIndex((b) => b.classList.contains(c)),
    );
    expect(order[0]).toBeGreaterThan(-1);
    expect(order[0]!).toBeLessThan(order[1]!);
    expect(order[1]!).toBeLessThan(order[2]!);
  });

  it("hides the sticker button without the capability or the handler", () => {
    resetServerCapabilities();
    mount();
    expect(container.querySelector(".sticker-btn")).toBeNull();
    comp.destroy?.();
    container.replaceChildren();
    applyReadyCapabilities({ stickers: true });
    mount({ onSendSticker: undefined });
    expect(container.querySelector(".sticker-btn")).toBeNull();
  });

  it("each button opens the popup on its own tab", async () => {
    mount();
    for (const [name, expected, panel] of [
      ["gif", "gif", ".gif-picker"],
      ["sticker", "sticker", ".sticker-picker"],
      ["emoji", "emoji", ".emoji-picker"],
    ] as const) {
      btn(name).click();
      await settle();
      expect(selected()).toBe(expected);
      expect(container.querySelector(`.xp-panel ${panel}`)).not.toBeNull();
      btn(name).click();
      expect(popup()).toBeNull();
    }
  });

  it("clicking another button switches tabs in the same popup, and the active one closes it", async () => {
    mount();
    btn("emoji").click();
    await settle();
    btn("sticker").click();
    await settle();
    expect(container.querySelectorAll(".expression-popup")).toHaveLength(1);
    expect(selected()).toBe("sticker");
    expect(container.querySelector(".emoji-picker")).toBeNull();
    btn("sticker").click();
    expect(popup()).toBeNull();
  });

  it("clicking a tab switches to its picker", async () => {
    mount();
    btn("emoji").click();
    await settle();
    tab("gif").click();
    await settle();
    expect(selected()).toBe("gif");
    expect(container.querySelector(".gif-picker")).not.toBeNull();
    expect(container.querySelector(".emoji-picker")).toBeNull();
  });

  it("is a proper tablist with arrow-key navigation", async () => {
    mount();
    btn("gif").click();
    await settle();
    const list = container.querySelector('[role="tablist"]')!;
    expect(list.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(tab("gif").getAttribute("aria-selected")).toBe("true");
    expect(tab("gif").tabIndex).toBe(0);
    expect(tab("sticker").tabIndex).toBe(-1);
    expect(container.querySelector('[role="tabpanel"]')!.getAttribute("aria-labelledby")).toBe(
      "xp-tab-gif",
    );

    const press = (key: string): void => {
      list.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    };
    press("ArrowRight");
    await settle();
    expect(selected()).toBe("sticker");
    press("ArrowRight");
    await settle();
    expect(selected()).toBe("emoji");
    press("ArrowRight");
    await settle();
    expect(selected()).toBe("gif");
    press("ArrowLeft");
    await settle();
    expect(selected()).toBe("emoji");
    press("Home");
    await settle();
    expect(selected()).toBe("gif");
    press("End");
    await settle();
    expect(selected()).toBe("emoji");
  });

  it("Escape closes the popup and returns focus to the button of the active tab", async () => {
    mount();
    btn("sticker").click();
    await settle();
    tab("sticker").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(btn("sticker"));
  });

  it("a picker asking to close hands focus back to its button", async () => {
    mount();
    btn("sticker").click();
    await settle();
    stickerOpts!.onClose();
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(btn("sticker"));
  });

  it("offers no GIF tab when GIFs are unavailable", async () => {
    mount({ gifApi: undefined });
    expect(btn("gif").disabled).toBe(true);
    btn("emoji").click();
    await settle();
    expect(tab("gif")).toBeNull();
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    btn("emoji").click();
    comp.togglePicker("gif");
    await settle();
    expect(popup()).toBeNull();
  });

  it("offers no sticker tab on a server without stickers", async () => {
    resetServerCapabilities();
    mount();
    btn("emoji").click();
    await settle();
    expect(tab("sticker")).toBeNull();
  });

  it("togglePicker opens the sticker tab like its button", async () => {
    mount();
    comp.togglePicker("sticker");
    await settle();
    expect(selected()).toBe("sticker");
    comp.togglePicker("sticker");
    expect(popup()).toBeNull();
  });

  it("tells the sticker picker whether the viewer can manage the server", async () => {
    mount();
    btn("sticker").click();
    await settle();
    expect(stickerOpts!.canManage).toBe(false);
  });

  it("picking a sticker sends it at once and closes the popup", async () => {
    mount();
    btn("sticker").click();
    await settle();
    stickerOpts!.onSelect({ id: 7, name: "Wave" });
    expect(onSendSticker).toHaveBeenCalledWith({ id: 7, name: "Wave" }, null, false);
    expect(onSend).not.toHaveBeenCalled();
    expect(popup()).toBeNull();
  });

  it("a sticker picked with a reply pending is sent as that reply", async () => {
    mount();
    comp.setReplyTo(9, "Alice");
    btn("sticker").click();
    await settle();
    stickerOpts!.onSelect({ id: 7, name: "Wave" });
    expect(onSendSticker).toHaveBeenCalledWith({ id: 7, name: "Wave" }, 9, true);
  });

  it("a sticker sent while the composer is disabled is refused", async () => {
    mount();
    btn("sticker").click();
    await settle();
    comp.setDisabled("Offline");
    stickerOpts!.onSelect({ id: 7, name: "Wave" });
    expect(onSendSticker).not.toHaveBeenCalled();
  });

  it("clicking outside the popup closes it", async () => {
    mount();
    btn("emoji").click();
    await settle();
    await new Promise((r) => setTimeout(r, 5));
    document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(popup()).toBeNull();
  });
});
