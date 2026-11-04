import { describe, it, expect, vi, beforeEach } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";

const fetchImageAsObjectUrl = vi.hoisted(() => vi.fn());

vi.mock("../../src/features/messaging/content/attachments", () => ({
  fetchImageAsObjectUrl,
  // No cached bytes: every avatar here is a still picture (WP 8.7).
  cachedImageBytes: () => null,
  recoverEvictedImage: () => {},
  isSafeUrl: (url: string) => url.startsWith("https://") || url.startsWith("http://"),
  resolveServerUrl: (url: string) => (url.startsWith("http") ? url : `https://server.test${url}`),
}));

import { createPinnedMessages } from "@components/PinnedMessages";
import { setMembers } from "@stores/members.store";
import type { PinnedMessage, PinnedMessagesOptions } from "@components/PinnedMessages";

const samplePins: PinnedMessage[] = [
  {
    id: 1,
    content: "Hello world",
    author: "Alice",
    avatar: null,
    timestamp: "2024-01-01T12:00:00Z",
    avatarColor: "#5865f2",
  },
  {
    id: 2,
    content: "Important notice",
    author: "Bob",
    avatar: null,
    timestamp: "2024-01-02T14:30:00Z",
    avatarColor: "#e74c3c",
  },
  {
    id: 3,
    content: "Reminder",
    author: "Charlie",
    avatar: null,
    timestamp: "2024-01-03T09:00:00Z",
    avatarColor: "#2ecc71",
  },
];

describe("PinnedMessages", () => {
  let container: HTMLDivElement;

  useMountContainer((c) => {
    container = c;
  });

  beforeEach(() => {
    fetchImageAsObjectUrl.mockReset();
    fetchImageAsObjectUrl.mockResolvedValue(null);
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
    expect(title!.querySelector('svg[data-icon="pin"]')).not.toBeNull();
    expect(title!.textContent).toContain("Pinned Messages");
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
    // Timestamp is formatted by formatPinTime (locale-dependent output)
    expect(times[0]!.textContent).toBeTruthy();
    panel.destroy?.();
  });

  it("formats a bare SQLite timestamp (no timezone) the same as its Z-suffixed equivalent", () => {
    // GetPinnedMessages returns the raw "YYYY-MM-DD HH:MM:SS" column, i.e.
    // UTC with no zone designator. `new Date(iso)` would read that as local
    // wall-clock, mislabelling the date near the UTC day boundary.
    const pins: PinnedMessage[] = [
      {
        id: 1,
        content: "a",
        author: "Alice",
        avatar: null,
        timestamp: "2024-01-02 23:30:00",
        avatarColor: "#5865f2",
      },
      {
        id: 2,
        content: "b",
        author: "Bob",
        avatar: null,
        timestamp: "2024-01-02T23:30:00Z",
        avatarColor: "#e74c3c",
      },
    ];
    const { panel } = makePanel({ pinnedMessages: pins });
    const times = container.querySelectorAll(".pinned-msg__time");
    expect(times[0]!.textContent).toBe(times[1]!.textContent);
    panel.destroy?.();
  });

  it("shows the author's letter on their colour when they have no avatar", () => {
    const { panel } = makePanel();
    const avatar = container.querySelector<HTMLElement>(".pinned-msg__avatar")!;
    expect(avatar.textContent).toBe("A");
    expect(avatar.style.background).toBe("rgb(88, 101, 242)");
    expect(avatar.querySelector("img")).toBeNull();
    expect(fetchImageAsObjectUrl).not.toHaveBeenCalled();
    panel.destroy?.();
  });

  it("shows the author's profile picture when they have one", async () => {
    fetchImageAsObjectUrl.mockResolvedValue("blob:alice");
    const pins: PinnedMessage[] = [{ ...samplePins[0]!, avatar: "/api/v1/files/abc" }];
    const { panel } = makePanel({ pinnedMessages: pins });
    const avatar = container.querySelector<HTMLElement>(".pinned-msg__avatar")!;

    await vi.waitFor(() => expect(avatar.querySelector("img")).not.toBeNull());
    expect(fetchImageAsObjectUrl).toHaveBeenCalledWith("https://server.test/api/v1/files/abc");
    const img = avatar.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("blob:alice");
    expect(img.getAttribute("alt")).toBe("Alice");
    expect(avatar.querySelector(".avatar-initial")).toBeNull();
    panel.destroy?.();
  });

  it("keeps the letter when the profile picture fails to load", async () => {
    const pins: PinnedMessage[] = [{ ...samplePins[0]!, avatar: "/api/v1/files/abc" }];
    const { panel } = makePanel({ pinnedMessages: pins });
    await vi.waitFor(() => expect(fetchImageAsObjectUrl).toHaveBeenCalled());
    await Promise.resolve();
    const avatar = container.querySelector<HTMLElement>(".pinned-msg__avatar")!;
    expect(avatar.querySelector("img")).toBeNull();
    expect(avatar.textContent).toBe("A");
    expect(avatar.style.background).toBe("rgb(88, 101, 242)");
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

    // Empty state rendered, list not rendered
    const empty = container.querySelector(".pinned-panel__empty");
    expect(empty).not.toBeNull();
    const list = container.querySelector(".pinned-panel__list");
    expect(list).toBeNull();
    panel.destroy?.();
  });

  it("with pinned messages, empty state is not rendered", () => {
    const { panel } = makePanel();

    // List rendered, empty state not rendered
    const empty = container.querySelector(".pinned-panel__empty");
    expect(empty).toBeNull();
    const list = container.querySelector(".pinned-panel__list");
    expect(list).not.toBeNull();
    panel.destroy?.();
  });

  it("stores message id in dataset", () => {
    const { panel } = makePanel();
    const items = container.querySelectorAll(".pinned-msg");
    expect((items[0] as HTMLDivElement).dataset.messageId).toBe("1");
    expect((items[1] as HTMLDivElement).dataset.messageId).toBe("2");
    panel.destroy?.();
  });

  // ── accessibility (DC-13): landmark panel, not a modal ─────────────────────

  it("exposes the panel as a labeled complementary landmark", () => {
    const { panel } = makePanel();
    const root = container.querySelector(".pinned-panel") as HTMLElement;
    expect(root.getAttribute("role")).toBe("complementary");
    expect(root.getAttribute("aria-label")).toBe("Pinned messages");
    // A side panel is not modal — it must never claim aria-modal.
    expect(root.getAttribute("aria-modal")).toBeNull();
    panel.destroy?.();
  });

  it("labels the icon-only buttons for screen readers", () => {
    const { panel } = makePanel();

    const closeBtn = container.querySelector(".pinned-panel__close") as HTMLButtonElement;
    expect(closeBtn.getAttribute("aria-label")).toBe("Close pinned messages");

    const actionBtns = container.querySelectorAll(".pinned-msg__actions button");
    // Jump is the first button in each action group, unpin the second
    expect(actionBtns[0]!.getAttribute("aria-label")).toBe("Jump to message");
    expect(actionBtns[1]!.getAttribute("aria-label")).toBe("Unpin message");
    panel.destroy?.();
  });

  it("destroy removes DOM", () => {
    const { panel } = makePanel();
    expect(container.querySelector(".pinned-panel")).not.toBeNull();
    panel.destroy?.();
    expect(container.querySelector(".pinned-panel")).toBeNull();
  });

  it("renders message content as markdown, not plain text", () => {
    const { panel } = makePanel({
      pinnedMessages: [{ ...samplePins[0]!, content: "**bold** and `code`" }],
    });
    const content = container.querySelector(".pinned-msg__content")!;
    expect(content.querySelector("strong")?.textContent).toBe("bold");
    expect(content.querySelector("code")?.textContent).toBe("code");
    expect(content.textContent).not.toContain("**");
    panel.destroy?.();
  });

  it("renders mentions as plain text, not as controls the panel cannot open", () => {
    setMembers([{ id: 11, username: "Bob", avatar: null, role: "member", status: "online" }]);
    const { panel } = makePanel({
      pinnedMessages: [{ ...samplePins[0]!, content: "hi @Bob" }],
    });
    const chips = container.querySelectorAll(".pinned-msg__content .mention");
    expect(chips.length).toBeGreaterThan(0);
    for (const chip of chips) {
      expect(chip.getAttribute("role")).toBeNull();
      expect(chip.getAttribute("tabindex")).toBeNull();
    }
    panel.destroy?.();
  });

  it("removePin drops one card in place and updates the count", () => {
    const { panel } = makePanel();
    panel.removePin(2);
    const ids = [...container.querySelectorAll<HTMLElement>(".pinned-msg")].map(
      (el) => el.dataset.messageId,
    );
    expect(ids).toEqual(["1", "3"]);
    expect(container.querySelector(".pinned-panel__count")?.textContent).toBe("2");
    panel.destroy?.();
  });

  it("removing the last pin shows the empty state, and setPins brings the list back", () => {
    const { panel } = makePanel({ pinnedMessages: [samplePins[0]!] });
    panel.removePin(1);
    expect(container.querySelector(".pinned-msg")).toBeNull();
    expect(container.querySelector(".pinned-panel__empty")).not.toBeNull();
    expect(container.querySelector(".pinned-panel__count")?.textContent).toBe("0");

    panel.setPins(samplePins);
    expect(container.querySelector(".pinned-panel__empty")).toBeNull();
    expect(container.querySelectorAll(".pinned-msg").length).toBe(3);
    expect(container.querySelector(".pinned-panel__count")?.textContent).toBe("3");
    panel.destroy?.();
  });

  it("jump and unpin still reach their handlers after a re-render", () => {
    const onUnpin = vi.fn();
    const onJumpToMessage = vi.fn();
    const { panel } = makePanel({ onUnpin, onJumpToMessage });
    panel.removePin(1);
    container.querySelector<HTMLButtonElement>('[data-message-id="2"] .pinned-msg__unpin')!.click();
    container.querySelector<HTMLButtonElement>('[data-message-id="3"] .pinned-msg__jump')!.click();
    expect(onUnpin).toHaveBeenCalledExactlyOnceWith(2);
    expect(onJumpToMessage).toHaveBeenCalledExactlyOnceWith(3);
    panel.destroy?.();
  });

  it("setOnUnpin withdraws and restores the Unpin buttons live", () => {
    const onUnpin = vi.fn();
    const { panel } = makePanel({ onUnpin });
    expect(container.querySelectorAll(".pinned-msg__unpin").length).toBe(3);

    panel.setOnUnpin(undefined);
    expect(container.querySelectorAll(".pinned-msg__unpin").length).toBe(0);

    panel.setOnUnpin(onUnpin);
    expect(container.querySelectorAll(".pinned-msg__unpin").length).toBe(3);
    panel.destroy?.();
  });
});
