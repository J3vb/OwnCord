import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelsStore, type Channel } from "@stores/channels.store";
import type { ForwardInfo } from "@lib/types";

const jumpToMessage = vi.fn();
vi.mock("@lib/nav/messageNavigation", () => ({
  jumpToMessage: (...a: unknown[]) => jumpToMessage(...a),
}));

import { endForwardBlock, startForwardBlock } from "./forwardBlock";

const channel = (id: number, name: string): Channel => ({
  id,
  name,
  type: "text",
  category: null,
  topic: "",
  position: id,
  unreadCount: 0,
  mentionCount: 0,
  lastMessageId: null,
  canSend: true,
  slowMode: 0,
  nsfw: false,
  isPrivate: false,
  voiceMaxUsers: 0,
  voiceMaxVideo: 0,
});

const info = (over: Partial<ForwardInfo> = {}): ForwardInfo => ({
  source_channel_id: 5,
  source_message_id: 1042,
  source_timestamp: "2026-03-14T10:30:00Z",
  ...over,
});

function build(forward: ForwardInfo): HTMLElement {
  const box = startForwardBlock();
  box.appendChild(document.createElement("p")).textContent = "body";
  endForwardBlock(box, forward);
  return box;
}

describe("forward block", () => {
  beforeEach(() => {
    jumpToMessage.mockClear();
    channelsStore.setState((s) => ({ ...s, channels: new Map([[5, channel(5, "general")]]) }));
  });

  it("labels the frame Forwarded and keeps the body inside it", () => {
    const box = build(info());
    expect(box.classList.contains("msg-forward")).toBe(true);
    expect(box.querySelector(".msg-forward-head")?.textContent).toBe("Forwarded");
    expect(box.querySelector("p")?.textContent).toBe("body");
  });

  it("shows a jump chip with the source channel and time when the original is reachable", () => {
    const chip = build(info()).querySelector<HTMLElement>('[data-testid="msg-forward-jump"]');
    expect(chip).not.toBeNull();
    expect(chip!.querySelector(".mlc-channel")?.textContent).toMatch(/^#general · /);
    expect(chip!.querySelector(".mlc-action")?.textContent).toBe("Jump");
    chip!.click();
    expect(jumpToMessage).toHaveBeenCalledWith(5, 1042);
  });

  it("jumps from the keyboard with Enter and Space", () => {
    const chip = build(info()).querySelector<HTMLElement>('[data-testid="msg-forward-jump"]')!;
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    chip.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(jumpToMessage).toHaveBeenCalledTimes(2);
  });

  it("has no link once the original is gone, only the channel and time", () => {
    const box = build(info({ source_message_id: null }));
    expect(box.querySelector('[data-testid="msg-forward-jump"]')).toBeNull();
    expect(box.querySelector('[data-testid="msg-forward-source"]')?.textContent).toMatch(
      /^#general · /,
    );
  });

  it("has no link and no channel name for a channel this viewer cannot see", () => {
    const box = build(info({ source_channel_id: 99 }));
    expect(box.querySelector('[data-testid="msg-forward-jump"]')).toBeNull();
    const text = box.querySelector('[data-testid="msg-forward-source"]')?.textContent ?? "";
    expect(text).not.toContain("#");
    expect(text).not.toBe("");
  });

  it("draws a hostile channel name as text, never as markup", () => {
    const hostile = "<img src=x onerror=alert(1)>";
    channelsStore.setState((s) => ({ ...s, channels: new Map([[5, channel(5, hostile)]]) }));
    for (const forward of [info(), info({ source_message_id: null })]) {
      const source = build(forward).querySelector<HTMLElement>(
        '[data-testid="msg-forward-jump"], [data-testid="msg-forward-source"]',
      )!;
      expect(source.textContent).toContain(hostile);
      expect(source.querySelector("img")).toBeNull();
      expect(source.querySelectorAll("*").length).toBe(
        source.matches(".message-link-chip") ? 2 : 0,
      );
    }
  });
});
