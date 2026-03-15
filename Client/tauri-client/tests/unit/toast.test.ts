import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createToastContainer,
  type ToastContainer,
} from "../../src/components/Toast";

describe("ToastContainer", () => {
  let container: HTMLDivElement;
  let toast: ToastContainer;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    toast = createToastContainer();
    toast.mount(container);
  });

  afterEach(() => {
    toast.destroy?.();
    vi.useRealTimers();
  });

  it("show adds a toast to the container", () => {
    toast.show("Hello world");

    const toastEl = container.querySelector(".toast");
    expect(toastEl).not.toBeNull();
    expect(toastEl!.textContent).toBe("Hello world");
  });

  it("auto-dismiss removes toast after duration", () => {
    toast.show("Temporary", "info", 3000);

    expect(container.querySelectorAll(".toast").length).toBe(1);

    vi.advanceTimersByTime(3000);

    expect(container.querySelectorAll(".toast").length).toBe(0);
  });

  it("max 5 toasts — oldest removed when exceeded", () => {
    for (let i = 0; i < 6; i++) {
      toast.show(`Toast ${i}`);
    }

    const toasts = container.querySelectorAll(".toast");
    expect(toasts.length).toBe(5);

    // The oldest (Toast 0) should have been evicted; Toast 1 should be first
    expect(toasts[0]!.textContent).toBe("Toast 1");
    expect(toasts[4]!.textContent).toBe("Toast 5");
  });

  it("clear removes all toasts", () => {
    toast.show("One");
    toast.show("Two");
    toast.show("Three");

    expect(container.querySelectorAll(".toast").length).toBe(3);

    toast.clear();

    expect(container.querySelectorAll(".toast").length).toBe(0);
  });

  it("different types get correct CSS class", () => {
    toast.show("Error msg", "error");
    toast.show("Info msg", "info");
    toast.show("Success msg", "success");

    expect(container.querySelector(".toast-error")).not.toBeNull();
    expect(container.querySelector(".toast-info")).not.toBeNull();
    expect(container.querySelector(".toast-success")).not.toBeNull();
  });

  it("defaults to info type when type is omitted", () => {
    toast.show("Default type");

    const toastEl = container.querySelector(".toast-info");
    expect(toastEl).not.toBeNull();
  });

  it("defaults to 5000ms duration when omitted", () => {
    toast.show("Default duration");

    vi.advanceTimersByTime(4999);
    expect(container.querySelectorAll(".toast").length).toBe(1);

    vi.advanceTimersByTime(1);
    expect(container.querySelectorAll(".toast").length).toBe(0);
  });

  it("destroy clears all toasts and removes root", () => {
    toast.show("Will be destroyed");
    toast.destroy?.();

    expect(container.querySelector(".toast-container")).toBeNull();
  });
});
