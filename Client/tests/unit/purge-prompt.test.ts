import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { pressComposingEnter } from "../helpers/keyEvents";
import { appendPurgeSection } from "@components/purgePrompt";

describe("appendPurgeSection", () => {
  let menu: HTMLDivElement;
  let owner: AbortController;

  beforeEach(() => {
    menu = document.createElement("div");
    document.body.appendChild(menu);
    owner = new AbortController();
  });

  afterEach(() => {
    owner.abort();
    menu.remove();
  });

  function mount(onPurge: (count: number) => void | Promise<void>): void {
    appendPurgeSection(menu, {
      itemClass: "context-menu-item",
      dangerItemClass: "context-menu-item danger",
      separatorClass: "context-menu-sep",
      onPurge,
      signal: owner.signal,
    });
  }

  const q = <T extends HTMLElement>(testId: string): T =>
    menu.querySelector(`[data-testid="${testId}"]`) as T;

  it("asks for a count before it fires and clamps to 1-100", async () => {
    const onPurge = vi.fn(async () => {});
    mount(onPurge);

    const trigger = q<HTMLElement>("ctx-purge-messages");
    expect(trigger.textContent).toBe("Purge Messages…");

    const form = q<HTMLDivElement>("purge-form");
    expect(form.style.display).toBe("none");
    trigger.click();
    expect(form.style.display).toBe("");
    expect(onPurge).not.toHaveBeenCalled();

    q<HTMLInputElement>("purge-count-input").value = "0";
    q<HTMLElement>("purge-confirm").click();

    await vi.waitFor(() => {
      expect(onPurge).toHaveBeenCalledWith(1);
    });
  });

  it("ignores an Enter in the count that commits an IME candidate", async () => {
    const onPurge = vi.fn(async () => {});
    mount(onPurge);

    q<HTMLElement>("ctx-purge-messages").click();
    const input = q<HTMLInputElement>("purge-count-input");
    input.value = "2";
    pressComposingEnter(input);
    expect(onPurge).not.toHaveBeenCalled();

    input.value = "20";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => {
      expect(onPurge).toHaveBeenCalledExactlyOnceWith(20);
    });
  });

  it("falls back to the default count for a non-numeric entry", async () => {
    const onPurge = vi.fn(async () => {});
    mount(onPurge);

    q<HTMLElement>("ctx-purge-messages").click();
    q<HTMLInputElement>("purge-count-input").value = "";
    q<HTMLElement>("purge-confirm").click();

    await vi.waitFor(() => {
      expect(onPurge).toHaveBeenCalledWith(50);
    });
  });

  it("shows an in-flight state and ignores a second click", async () => {
    let release: (() => void) | null = null;
    const onPurge = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    mount(onPurge);

    q<HTMLElement>("ctx-purge-messages").click();
    const confirm = q<HTMLElement>("purge-confirm");
    confirm.click();
    expect(confirm.textContent).toBe("Purging…");
    confirm.click();
    expect(onPurge).toHaveBeenCalledTimes(1);

    release!();
    await vi.waitFor(() => {
      expect(confirm.textContent).toBe("Confirm Purge");
    });
  });
});
