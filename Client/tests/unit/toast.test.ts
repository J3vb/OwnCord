import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createToastContainer, type ToastContainer } from "../../src/components/Toast";

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

  it("tags each toast with its type class, warning included", () => {
    toast.show("Heads up", "warning");
    toast.show("Done", "success");

    const els = container.querySelectorAll(".toast");
    expect(els[0]!.classList.contains("toast-warning")).toBe(true);
    expect(els[1]!.classList.contains("toast-success")).toBe(true);
  });

  it("auto-dismiss removes toast after duration", () => {
    toast.show("Temporary", "info", 3000);

    expect(container.querySelectorAll(".toast").length).toBe(1);

    // Advance past dismiss timer (3000ms) + transition fallback (400ms)
    vi.advanceTimersByTime(3400);

    expect(container.querySelectorAll(".toast").length).toBe(0);
  });

  it("max 5 toasts — oldest removed when exceeded", () => {
    for (let i = 0; i < 6; i++) {
      toast.show(`Toast ${i}`);
    }

    // Advance past the transition fallback so evicted toasts are removed from DOM
    vi.advanceTimersByTime(400);

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
    // Advance past transition fallback so DOM elements are removed
    vi.advanceTimersByTime(400);

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

    // Advance past dismiss timer (1ms remaining) + transition fallback (400ms)
    vi.advanceTimersByTime(401);
    expect(container.querySelectorAll(".toast").length).toBe(0);
  });

  it("mounts the container as a polite live region", () => {
    const region = container.querySelector(".toast-container");
    expect(region).not.toBeNull();
    expect(region!.getAttribute("role")).toBe("status");
    expect(region!.getAttribute("aria-live")).toBe("polite");
    expect(region!.getAttribute("aria-atomic")).toBe("false");
  });

  it("announces toasts by appending them inside the live region", () => {
    toast.show("Announced");

    const region = container.querySelector(".toast-container");
    const toastEl = container.querySelector(".toast");
    expect(toastEl!.parentElement).toBe(region);
  });

  it("destroy clears all toasts and removes root", () => {
    toast.show("Will be destroyed");
    toast.destroy?.();

    expect(container.querySelector(".toast-container")).toBeNull();
  });

  // UX-5: an error that vanishes before it can be read or acted on is worse
  // than no error at all. Errors persist until dismissed; a close button is
  // always present on them.
  it("keeps an error on screen past the default duration", () => {
    toast.show("Something broke", "error");

    vi.advanceTimersByTime(60_000);

    expect(container.querySelectorAll(".toast-error").length).toBe(1);
  });

  it("gives an error a dismiss button that removes it", () => {
    toast.show("Something broke", "error");

    const close = container.querySelector(".toast-error .toast-close");
    expect(close).not.toBeNull();
    expect(close!.getAttribute("aria-label")).toBeTruthy();

    (close as HTMLButtonElement).click();
    vi.advanceTimersByTime(400);

    expect(container.querySelectorAll(".toast-error").length).toBe(0);
  });

  it("pauses an auto-dismiss timer while the pointer is over the toast", () => {
    toast.show("Temporary", "info", 3000);
    const el = container.querySelector(".toast") as HTMLDivElement;

    // 2s in, hover: the remaining 1s must not run out under the cursor.
    vi.advanceTimersByTime(2000);
    el.dispatchEvent(new MouseEvent("mouseenter"));
    vi.advanceTimersByTime(5000);
    expect(container.querySelectorAll(".toast").length).toBe(1);

    // Leaving resumes the held 1s; the removal fallback adds 400ms.
    el.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(1399);
    expect(container.querySelectorAll(".toast").length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(container.querySelectorAll(".toast").length).toBe(0);
  });

  it("pauses an auto-dismiss timer while the toast has focus", () => {
    document.body.appendChild(container);
    toast.show("Temporary", "info", 3000);
    const el = container.querySelector(".toast") as HTMLDivElement;

    vi.advanceTimersByTime(2000);
    el.focus();
    expect(document.activeElement).toBe(el);
    vi.advanceTimersByTime(5000);
    expect(container.querySelectorAll(".toast").length).toBe(1);

    el.blur();
    vi.advanceTimersByTime(1400);
    expect(container.querySelectorAll(".toast").length).toBe(0);
    container.remove();
  });

  it("does not restart a hovered toast's timer when a duplicate arrives", () => {
    toast.show("Temporary", "info", 3000);
    const el = container.querySelector(".toast") as HTMLDivElement;

    el.dispatchEvent(new MouseEvent("mouseenter"));
    toast.show("Temporary", "info", 3000);
    vi.advanceTimersByTime(10_000);
    expect(container.querySelectorAll(".toast").length).toBe(1);

    // Leaving runs the full window the repeat topped up, then the fallback.
    el.dispatchEvent(new MouseEvent("mouseleave"));
    vi.advanceTimersByTime(3399);
    expect(container.querySelectorAll(".toast").length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(container.querySelectorAll(".toast").length).toBe(0);
  });

  it("keeps a toast held while it is still hovered after losing focus", () => {
    document.body.appendChild(container);
    toast.show("Temporary", "info", 3000);
    const el = container.querySelector(".toast") as HTMLDivElement;

    el.dispatchEvent(new MouseEvent("mouseenter"));
    el.focus();
    el.blur();
    vi.advanceTimersByTime(10_000);
    expect(container.querySelectorAll(".toast").length).toBe(1);
    container.remove();
  });

  it("coalesces identical toasts into one with a count", () => {
    for (let i = 0; i < 5; i++) toast.show("Same error", "error");

    expect(container.querySelectorAll(".toast").length).toBe(1);
    const count = container.querySelector("[data-testid='toast-count']");
    expect(count).not.toBeNull();
    expect(count!.textContent).toBe("5");
    expect(container.querySelector(".toast")!.textContent).toContain("Same error");
  });

  it("does not coalesce toasts with different text or type", () => {
    toast.show("Same error", "error");
    toast.show("Same error", "info");

    expect(container.querySelectorAll(".toast").length).toBe(2);
  });

  it("resets a coalesced toast's timer on each repeat", () => {
    toast.show("Temporary", "info", 3000);
    vi.advanceTimersByTime(2000);
    toast.show("Temporary", "info", 3000);

    // 2 more seconds: the original 3s would have elapsed at t=5s, but the
    // duplicate restarted the window.
    vi.advanceTimersByTime(2000);
    expect(container.querySelectorAll(".toast").length).toBe(1);
    vi.advanceTimersByTime(1500);
    expect(container.querySelectorAll(".toast").length).toBe(0);
  });
});
