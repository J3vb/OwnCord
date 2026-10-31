import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStatusPicker, type StatusPickerComponent } from "@components/StatusPicker";
import { closeBottomSheet } from "@lib/ui/bottomSheet";

const sheet = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-testid="status-sheet"]');
const option = (status: string): HTMLElement =>
  sheet()!.querySelector<HTMLElement>(`[data-testid="status-sheet-${status}"]`)!;
const customInput = (): HTMLInputElement =>
  sheet()!.querySelector<HTMLInputElement>('[data-testid="custom-status-input"]')!;

async function settleHistory(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("StatusPicker on a phone", () => {
  let container: HTMLDivElement;
  let picker: StatusPickerComponent | null = null;
  let phone = true;
  const onStatusChange = vi.fn();
  const onCustomStatusChange = vi.fn();

  const dot = (): HTMLElement => container.querySelector<HTMLElement>(".status-picker-dot")!;
  const dropdown = (): HTMLElement =>
    container.querySelector<HTMLElement>(".status-picker-dropdown")!;

  function mount(currentStatus: "online" | "idle" = "online"): void {
    picker = createStatusPicker({
      currentStatus,
      currentCustomStatus: "heads down",
      onStatusChange,
      onCustomStatusChange,
    });
    picker.mount(container);
  }

  beforeEach(() => {
    phone = true;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((q: string) => ({ matches: phone && q.includes("pointer: coarse") })),
    );
    onStatusChange.mockReset();
    onCustomStatusChange.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    picker?.destroy?.();
    picker = null;
    closeBottomSheet();
    await settleHistory();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens a sheet with the same four statuses, not the popover", () => {
    mount("idle");
    dot().click();

    expect(sheet()).not.toBeNull();
    expect(sheet()!.getAttribute("aria-label")).toBe("Change status");
    expect(dropdown().classList.contains("status-picker-dropdown--open")).toBe(false);
    const radios = [...sheet()!.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((r) => r.querySelector(".menu-sheet-label")?.textContent)).toEqual([
      "Online",
      "Idle",
      "Do Not Disturb",
      "Invisible",
    ]);
    // The current one is the checked one.
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
      "false",
    ]);
    expect(dot().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the popover on a desktop", () => {
    phone = false;
    mount();
    dot().click();
    expect(sheet()).toBeNull();
    expect(dropdown().classList.contains("status-picker-dropdown--open")).toBe(true);
  });

  it("sends the status tapped, closes the sheet and updates the dot", () => {
    mount();
    dot().click();
    option("dnd").click();

    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("dnd");
    expect(sheet()).toBeNull();
    expect(dot().getAttribute("aria-expanded")).toBe("false");
    expect(dot().style.background).toBe("var(--red)");
  });

  it("seeds the custom status field and commits it with Enter, closing the sheet", () => {
    mount();
    dot().click();
    const input = customInput();
    expect(input.value).toBe("heads down");

    input.value = "in a meeting";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    expect(onCustomStatusChange).toHaveBeenCalledExactlyOnceWith("in a meeting");
    expect(sheet()).toBeNull();
  });

  it("seeds a reopened sheet from the latest custom status, not the one it was built with", () => {
    mount();
    dot().click();
    customInput().value = "in a meeting";
    customInput().dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    dot().click();
    expect(customInput().value).toBe("in a meeting");
    closeBottomSheet();

    // A change from elsewhere (another device) reaches the next sheet too.
    picker!.setCustomStatus("lunch");
    dot().click();
    expect(customInput().value).toBe("lunch");
    customInput().dispatchEvent(new FocusEvent("blur"));
    expect(onCustomStatusChange).toHaveBeenCalledTimes(1);
  });

  it("restores the typed text and closes on Escape in the field, sending nothing", () => {
    mount();
    dot().click();
    const input = customInput();
    input.value = "half typed";
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(sheet()).toBeNull();
    expect(onCustomStatusChange).not.toHaveBeenCalled();
    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it("does not open while the picker is disabled, and closes if it becomes disabled", () => {
    mount();
    picker!.setEnabled(false);
    dot().click();
    expect(sheet()).toBeNull();

    picker!.setEnabled(true);
    dot().click();
    expect(sheet()).not.toBeNull();
    picker!.setEnabled(false);
    expect(sheet()).toBeNull();
  });

  it("closes with the picker", () => {
    mount();
    dot().click();
    picker!.destroy?.();
    picker = null;
    expect(sheet()).toBeNull();
  });
});
