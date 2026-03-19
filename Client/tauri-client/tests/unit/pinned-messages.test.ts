import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPinnedMessages } from "@components/PinnedMessages";
import type { PinnedMessage, PinnedMessagesOptions } from "@components/PinnedMessages";

const samplePins: PinnedMessage[] = [
  { id: 1, content: "Hello world", author: "Alice", timestamp: "2024-01-01 12:00" },
  { id: 2, content: "Important notice", author: "Bob", timestamp: "2024-01-02 14:30" },
  { id: 3, content: "Reminder", author: "Charlie", timestamp: "2024-01-03 09:00" },
];

describe("PinnedMessages", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function makePanel(overrides?: Partial<PinnedMessagesOptions>) {
    const options: PinnedMessagesOptions = {
      channelId: 1,
      pinnedMessages: overrides?.pinnedMessages ?? samplePins,
      onUnpin: overrides?.onUnpin ?? vi.fn(),
      onJumpToMessage: overrides?.onJumpToMessage ?? vi.fn(),
      onClose: overrides?.onClose ?? vi.fn(),
    };
    const panel = createPinnedMessages(options);
    panel.mount(container);
    return { panel, options };
  }

  it("mounts with pinned-panel class", () => {
    const { panel } = makePanel();
    expect(container.querySelector(".pinned-panel")).not.toBeNull();
    panel.destroy?.();
  });

  it("renders header with title", () => {
    const { panel } = makePanel();
    const title = container.querySelector("h3");
    expect(title).not.toBeNull();
    expect(title!.textContent).toBe("Pinned Messages");
    panel.destroy?.();
  });

  it("renders close button", () => {
    const onClose = vi.fn();
    const { panel } = makePanel({ onClose });
    const closeBtn = container.querySelector(".pinned-panel__close") as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();
    closeBtn.click();
    expect(onClose).toHaveBeenCalledOnce();
    panel.destroy?.();
  });

  it("renders pinned message items", () => {
    const { panel } = makePanel();
    const items = container.querySelectorAll(".pinned-msg");
    expect(items.length).toBe(3);
    panel.destroy?.();
  });

  it("shows author, content, and timestamp for each pin", () => {
    const { panel } = makePanel();
    const authors = container.querySelectorAll(".pinned-msg__author");
    const contents = container.querySelectorAll(".pinned-msg__content");
    const times = container.querySelectorAll(".pinned-msg__time");

    expect(authors[0]!.textContent).toBe("Alice");
    expect(contents[0]!.textContent).toBe("Hello world");
    expect(times[0]!.textContent).toBe("2024-01-01 12:00");
    panel.destroy?.();
  });

  it("Jump button calls onJumpToMessage with message id", () => {
    const onJumpToMessage = vi.fn();
    const { panel } = makePanel({ onJumpToMessage });

    const jumpBtns = container.querySelectorAll(".pinned-msg__actions button");
    // Jump is the first button in each action group
    (jumpBtns[0] as HTMLButtonElement).click();
    expect(onJumpToMessage).toHaveBeenCalledWith(1);
    panel.destroy?.();
  });

  it("Unpin button calls onUnpin with message id", () => {
    const onUnpin = vi.fn();
    const { panel } = makePanel({ onUnpin });

    const unpinBtns = container.querySelectorAll(".pinned-msg__actions button");
    // Unpin is the second button in each action group
    (unpinBtns[1] as HTMLButtonElement).click();
    expect(onUnpin).toHaveBeenCalledWith(1);
    panel.destroy?.();
  });

  it("empty pinned messages shows empty state", () => {
    const { panel } = makePanel({ pinnedMessages: [] });

    const items = container.querySelectorAll(".pinned-msg");
    expect(items.length).toBe(0);

    const empty = container.querySelector(".pinned-panel__empty") as HTMLDivElement;
    expect(empty).not.toBeNull();
    expect(empty.textContent).toBe("No pinned messages");
    // Empty div should be visible (display not "none")
    expect(empty.style.display).not.toBe("none");

    // List should be hidden
    const list = container.querySelector(".pinned-panel__list") as HTMLDivElement;
    expect(list.style.display).toBe("none");
    panel.destroy?.();
  });

  it("with pinned messages, empty state is hidden", () => {
    const { panel } = makePanel();

    const empty = container.querySelector(".pinned-panel__empty") as HTMLDivElement;
    expect(empty.style.display).toBe("none");

    const list = container.querySelector(".pinned-panel__list") as HTMLDivElement;
    expect(list.style.display).not.toBe("none");
    panel.destroy?.();
  });

  it("stores message id in dataset", () => {
    const { panel } = makePanel();
    const items = container.querySelectorAll(".pinned-msg");
    expect((items[0] as HTMLDivElement).dataset.messageId).toBe("1");
    expect((items[1] as HTMLDivElement).dataset.messageId).toBe("2");
    panel.destroy?.();
  });

  it("destroy removes DOM", () => {
    const { panel } = makePanel();
    expect(container.querySelector(".pinned-panel")).not.toBeNull();
    panel.destroy?.();
    expect(container.querySelector(".pinned-panel")).toBeNull();
  });
});
