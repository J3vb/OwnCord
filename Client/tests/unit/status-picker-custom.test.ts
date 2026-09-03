import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStatusPicker, type StatusPickerComponent } from "@components/StatusPicker";
import { MAX_CUSTOM_STATUS_LEN } from "@lib/userStatus";

/**
 * Phase 6 gave the picker two new jobs: offer "invisible" as a real status
 * (instead of "offline" wearing that label), and take a custom status line.
 */

describe("StatusPicker", () => {
  let container: HTMLDivElement;
  let picker: StatusPickerComponent | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    picker?.destroy?.();
    picker = null;
    container.remove();
  });

  function labels(): string[] {
    return Array.from(container.querySelectorAll(".status-picker-option-label")).map(
      (el) => el.textContent ?? "",
    );
  }

  function clickOption(label: string): void {
    const row = Array.from(container.querySelectorAll(".status-picker-option")).find(
      (el) => el.querySelector(".status-picker-option-label")?.textContent === label,
    );
    (row as HTMLElement).click();
  }

  it("offers Invisible and sends it as its own value", () => {
    const onStatusChange = vi.fn();
    picker = createStatusPicker({ currentStatus: "online", onStatusChange });
    picker.mount(container);

    expect(labels()).toEqual(["Online", "Idle", "Do Not Disturb", "Invisible"]);

    clickOption("Invisible");
    // The picker used to send "offline" here, which the server could not tell
    // apart from a dropped connection.
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("invisible");
  });

  it("renders no custom status input when no handler is supplied", () => {
    picker = createStatusPicker({ currentStatus: "online", onStatusChange: vi.fn() });
    picker.mount(container);
    expect(container.querySelector('[data-testid="custom-status-input"]')).toBeNull();
  });

  it("pre-fills the custom status input and commits it on Enter", () => {
    const onCustomStatusChange = vi.fn();
    picker = createStatusPicker({
      currentStatus: "online",
      onStatusChange: vi.fn(),
      currentCustomStatus: "shipping",
      onCustomStatusChange,
    });
    picker.mount(container);

    const input = container.querySelector<HTMLInputElement>('[data-testid="custom-status-input"]')!;
    expect(input.value).toBe("shipping");
    expect(input.getAttribute("maxlength")).toBe(String(MAX_CUSTOM_STATUS_LEN));

    input.value = "  in a meeting  ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onCustomStatusChange).toHaveBeenCalledExactlyOnceWith("in a meeting");
    expect(input.value).toBe("in a meeting");
  });

  it("commits on blur and clears with an empty value", () => {
    const onCustomStatusChange = vi.fn();
    picker = createStatusPicker({
      currentStatus: "online",
      onStatusChange: vi.fn(),
      currentCustomStatus: "busy",
      onCustomStatusChange,
    });
    picker.mount(container);

    const input = container.querySelector<HTMLInputElement>('[data-testid="custom-status-input"]')!;
    input.value = "";
    input.dispatchEvent(new FocusEvent("blur"));

    expect(onCustomStatusChange).toHaveBeenCalledExactlyOnceWith("");
  });

  it("does not re-send an unchanged value", () => {
    const onCustomStatusChange = vi.fn();
    picker = createStatusPicker({
      currentStatus: "online",
      onStatusChange: vi.fn(),
      currentCustomStatus: "busy",
      onCustomStatusChange,
    });
    picker.mount(container);

    const input = container.querySelector<HTMLInputElement>('[data-testid="custom-status-input"]')!;
    // Enter then the blur it causes: without the guard this would burn two
    // presence updates against a one-per-ten-seconds limit.
    input.value = "busy";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur"));

    expect(onCustomStatusChange).not.toHaveBeenCalled();
  });

  it("restores the last committed text on Escape", () => {
    const onCustomStatusChange = vi.fn();
    picker = createStatusPicker({
      currentStatus: "online",
      onStatusChange: vi.fn(),
      currentCustomStatus: "busy",
      onCustomStatusChange,
    });
    picker.mount(container);

    const input = container.querySelector<HTMLInputElement>('[data-testid="custom-status-input"]')!;
    input.value = "half-typed";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    expect(input.value).toBe("busy");
    expect(onCustomStatusChange).not.toHaveBeenCalled();
  });

  it("setCustomStatus updates the input without firing the handler", () => {
    const onCustomStatusChange = vi.fn();
    picker = createStatusPicker({
      currentStatus: "online",
      onStatusChange: vi.fn(),
      onCustomStatusChange,
    });
    picker.mount(container);

    picker.setCustomStatus("from the server");
    const input = container.querySelector<HTMLInputElement>('[data-testid="custom-status-input"]')!;
    expect(input.value).toBe("from the server");
    expect(onCustomStatusChange).not.toHaveBeenCalled();
  });

  it("does not clobber in-progress typing when the input is focused (OC-0369)", () => {
    const onCustomStatusChange = vi.fn();
    picker = createStatusPicker({
      currentStatus: "online",
      currentCustomStatus: "",
      onStatusChange: vi.fn(),
      onCustomStatusChange,
    });
    picker.mount(container);

    const input = container.querySelector<HTMLInputElement>('[data-testid="custom-status-input"]')!;
    input.focus();
    input.value = "on vacation";

    // An unrelated store push (e.g. a role change) re-seeds the picker mid-edit.
    picker.setCustomStatus("");

    expect(input.value).toBe("on vacation");

    // The pending commit must still fire with what was typed, not silently
    // no-op against a watermark the push would otherwise have reset.
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onCustomStatusChange).toHaveBeenCalledExactlyOnceWith("on vacation");
  });
});
