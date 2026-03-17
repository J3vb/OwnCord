import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createReactionBar } from "@components/ReactionBar";
import type { ReactionDisplay, ReactionBarOptions } from "@components/ReactionBar";

describe("ReactionBar", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function makeBar(reactions: ReactionDisplay[], onToggle = vi.fn()) {
    const bar = createReactionBar({ reactions, onToggle });
    container.appendChild(bar);
    return { bar, onToggle };
  }

  it("creates element with msg-reactions class", () => {
    const { bar } = makeBar([]);
    expect(bar.classList.contains("msg-reactions")).toBe(true);
  });

  it("renders reaction pills for each reaction", () => {
    const reactions: ReactionDisplay[] = [
      { emoji: "👍", count: 3, me: false },
      { emoji: "❤️", count: 1, me: true },
    ];
    const { bar } = makeBar(reactions);

    const pills = bar.querySelectorAll(".reaction-chip:not(.add-reaction)");
    expect(pills.length).toBe(2);
  });

  it("shows emoji and count in each pill", () => {
    const reactions: ReactionDisplay[] = [
      { emoji: "🔥", count: 5, me: false },
    ];
    const { bar } = makeBar(reactions);

    const pill = bar.querySelector(".reaction-chip:not(.add-reaction)") as HTMLButtonElement;
    expect(pill.textContent).toContain("🔥");
    const countSpan = pill.querySelector(".rc-count");
    expect(countSpan?.textContent).toBe("5");
  });

  it("adds 'me' class when user has reacted", () => {
    const reactions: ReactionDisplay[] = [
      { emoji: "👍", count: 1, me: true },
      { emoji: "👎", count: 1, me: false },
    ];
    const { bar } = makeBar(reactions);

    const pills = bar.querySelectorAll(".reaction-chip:not(.add-reaction)");
    expect(pills[0]!.classList.contains("me")).toBe(true);
    expect(pills[1]!.classList.contains("me")).toBe(false);
  });

  it("clicking a pill calls onToggle with emoji", () => {
    const onToggle = vi.fn();
    const reactions: ReactionDisplay[] = [
      { emoji: "🎉", count: 2, me: false },
    ];
    const { bar } = makeBar(reactions, onToggle);

    const pill = bar.querySelector(".reaction-chip:not(.add-reaction)") as HTMLButtonElement;
    pill.click();

    expect(onToggle).toHaveBeenCalledWith("🎉");
  });

  it("renders add-reaction button", () => {
    const { bar } = makeBar([]);
    const addBtn = bar.querySelector(".add-reaction");
    expect(addBtn).not.toBeNull();
    expect(addBtn!.textContent).toBe("+");
  });

  it("add-reaction button dispatches custom event", () => {
    const { bar } = makeBar([]);
    const addBtn = bar.querySelector(".add-reaction") as HTMLButtonElement;

    const handler = vi.fn();
    bar.addEventListener("add-reaction", handler);
    addBtn.click();

    expect(handler).toHaveBeenCalledOnce();
  });

  it("add-reaction button has aria-label", () => {
    const { bar } = makeBar([]);
    const addBtn = bar.querySelector(".add-reaction");
    expect(addBtn!.getAttribute("aria-label")).toBe("Add reaction");
  });

  it("renders only add button when no reactions", () => {
    const { bar } = makeBar([]);
    const allButtons = bar.querySelectorAll("button");
    expect(allButtons.length).toBe(1); // only the add-reaction button
    expect(allButtons[0]!.classList.contains("add-reaction")).toBe(true);
  });
});
