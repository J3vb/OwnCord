import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMessageActionsBar } from "../../src/components/MessageActionsBar";
import type { MessageActionsBarOptions } from "../../src/components/MessageActionsBar";

function makeOptions(overrides: Partial<MessageActionsBarOptions> = {}): MessageActionsBarOptions {
  return {
    messageId: 1,
    isOwn: false,
    canManageMessages: false,
    onReply: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onReact: vi.fn(),
    onPin: vi.fn(),
    onMore: vi.fn(),
    ...overrides,
  };
}

describe("MessageActionsBar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders React, Reply, and More buttons for non-own messages", () => {
    const bar = createMessageActionsBar(makeOptions());
    container.appendChild(bar);

    const buttons = bar.querySelectorAll("button");
    const labels = Array.from(buttons).map((b) => b.getAttribute("aria-label"));

    expect(labels).toContain("React");
    expect(labels).toContain("Reply");
    expect(labels).toContain("More");
    expect(labels).not.toContain("Edit");
    expect(labels).not.toContain("Delete");
    expect(labels).not.toContain("Pin");
  });

  it("shows Edit and Delete buttons for own messages", () => {
    const bar = createMessageActionsBar(makeOptions({ isOwn: true }));
    container.appendChild(bar);

    const labels = Array.from(bar.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label"),
    );
    expect(labels).toContain("Edit");
    expect(labels).toContain("Delete");
  });

  it("shows Delete and Pin buttons for users with manage permissions", () => {
    const bar = createMessageActionsBar(makeOptions({ canManageMessages: true }));
    container.appendChild(bar);

    const labels = Array.from(bar.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label"),
    );
    expect(labels).toContain("Delete");
    expect(labels).toContain("Pin");
    expect(labels).not.toContain("Edit");
  });

  it("shows all actions for own message with manage permissions", () => {
    const bar = createMessageActionsBar(makeOptions({
      isOwn: true,
      canManageMessages: true,
    }));
    container.appendChild(bar);

    const labels = Array.from(bar.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label"),
    );
    expect(labels).toContain("React");
    expect(labels).toContain("Reply");
    expect(labels).toContain("Edit");
    expect(labels).toContain("Delete");
    expect(labels).toContain("Pin");
    expect(labels).toContain("More");
  });

  it("calls onReply when Reply button is clicked", () => {
    const onReply = vi.fn();
    const bar = createMessageActionsBar(makeOptions({ onReply }));
    container.appendChild(bar);

    const replyBtn = Array.from(bar.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Reply",
    )!;
    replyBtn.click();
    expect(onReply).toHaveBeenCalledOnce();
  });

  it("calls onReact when React button is clicked", () => {
    const onReact = vi.fn();
    const bar = createMessageActionsBar(makeOptions({ onReact }));
    container.appendChild(bar);

    const reactBtn = Array.from(bar.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "React",
    )!;
    reactBtn.click();
    expect(onReact).toHaveBeenCalledOnce();
  });

  it("calls onEdit when Edit button is clicked", () => {
    const onEdit = vi.fn();
    const bar = createMessageActionsBar(makeOptions({ isOwn: true, onEdit }));
    container.appendChild(bar);

    const editBtn = Array.from(bar.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Edit",
    )!;
    editBtn.click();
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("calls onDelete when Delete button is clicked", () => {
    const onDelete = vi.fn();
    const bar = createMessageActionsBar(makeOptions({ isOwn: true, onDelete }));
    container.appendChild(bar);

    const deleteBtn = Array.from(bar.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === "Delete",
    )!;
    deleteBtn.click();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("has msg-actions-bar class", () => {
    const bar = createMessageActionsBar(makeOptions());
    expect(bar.classList.contains("msg-actions-bar")).toBe(true);
  });
});
