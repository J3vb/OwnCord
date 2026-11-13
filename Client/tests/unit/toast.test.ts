import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createToastContainer, type ToastContainer } from "../../src/lib/ui/toastContainer";

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

  it("keeps a non-error toast shown with an infinite duration until it is dismissed", () => {
    toast.show("Key changed", "warning", Infinity);

    vi.advanceTimersByTime(60_000);
    expect(container.querySelectorAll(".toast-warning").length).toBe(1);

    (container.querySelector(".toast-warning .toast-close") as HTMLButtonElement).click();
    vi.advanceTimersByTime(400);
    expect(container.querySelectorAll(".toast-warning").length).toBe(0);
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
    const count = container.querySelector(".toast-count");
    expect(count).not.toBeNull();
    expect(count!.textContent).toBe("5");
    expect(container.querySelector(".toast")!.textContent).toContain("Same error");
  });

  it("evicts a non-error toast before an undismissed error at capacity", () => {
    toast.show("Info first", "info");
    for (let i = 0; i < 4; i++) toast.show(`Error ${i}`, "error");
    toast.show("Saved", "success");
    vi.advanceTimersByTime(400);

    const texts = [...container.querySelectorAll(".toast-text")].map((el) => el.textContent);
    expect(texts).toEqual(["Error 0", "Error 1", "Error 2", "Error 3", "Saved"]);
  });

  it("keeps five distinct errors when a success arrives, evicting the success", () => {
    for (let i = 0; i < 5; i++) toast.show(`Error ${i}`, "error");
    toast.show("Profile updated", "success");
    vi.advanceTimersByTime(400);

    const texts = [...container.querySelectorAll(".toast-text")].map((el) => el.textContent);
    expect(texts).toEqual(["Error 0", "Error 1", "Error 2", "Error 3", "Error 4"]);
  });

  it("lets a new error displace the oldest error when every slot holds one", () => {
    for (let i = 0; i < 6; i++) toast.show(`Error ${i}`, "error");
    vi.advanceTimersByTime(400);

    const texts = [...container.querySelectorAll(".toast-text")].map((el) => el.textContent);
    expect(texts).toEqual(["Error 1", "Error 2", "Error 3", "Error 4", "Error 5"]);
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

  it("renders an action button that runs the action and dismisses the toast", () => {
    const run = vi.fn();
    toast.show("Camera stopped", "warning", Infinity, { label: "Turn on again", run });

    const btn = container.querySelector<HTMLButtonElement>(".toast .toast-action");
    expect(btn?.textContent).toBe("Turn on again");
    expect(btn?.type).toBe("button");
    // Sticky, so it also keeps its close button.
    expect(container.querySelector(".toast .toast-close")).not.toBeNull();

    btn!.click();
    expect(run).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(400);
    expect(container.querySelectorAll(".toast").length).toBe(0);
  });

  it("returns a function that removes the toast", () => {
    const remove = toast.show("Share stopped", "warning", Infinity, {
      label: "Share again",
      run: vi.fn(),
    });
    remove();
    vi.advanceTimersByTime(400);
    expect(container.querySelectorAll(".toast").length).toBe(0);
  });

  it("shows a detail line, an icon and a dismiss button on an auto-dismissing toast", () => {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    toast.show("Title", "info", 3000, undefined, { detail: "More", icon, closable: true });
    const el = container.querySelector(".toast")!;
    expect(el.querySelector(".toast-title")?.textContent).toBe("Title");
    expect(el.querySelector(".toast-detail")?.textContent).toBe("More");
    expect(el.classList.contains("toast--detailed")).toBe(true);
    expect(el.firstElementChild).toBe(icon);
    expect(icon.classList.contains("toast-icon")).toBe(true);
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    el.querySelector<HTMLButtonElement>(".toast-close")!.click();
    vi.advanceTimersByTime(400);
    expect(container.querySelector(".toast")).toBeNull();
    toast.show("Again", "info", 3000, undefined, { detail: "x", closable: true });
    vi.advanceTimersByTime(3400);
    expect(container.querySelector(".toast")).toBeNull();
  });

  it("coalesces only toasts whose detail line matches too", () => {
    toast.show("Title", "info", 3000, undefined, { detail: "A" });
    toast.show("Title", "info", 3000, undefined, { detail: "B" });
    toast.show("Title", "info", 3000, undefined, { detail: "B" });
    const els = container.querySelectorAll(".toast");
    expect(els.length).toBe(2);
    expect(els[1]!.querySelector(".toast-count")?.textContent).toBe("2");
  });

  it("shows no action button on a plain toast", () => {
    toast.show("Hello");
    expect(container.querySelector(".toast-action")).toBeNull();
    expect(container.querySelector(".toast--detailed")).toBeNull();
  });

  describe("anchorTo", () => {
    function anchorWithBox(box: { top: number; left: number; width: number; height: number }) {
      const el = document.createElement("div");
      el.getBoundingClientRect = () => DOMRect.fromRect({ x: box.left, y: box.top, ...box });
      return el;
    }
    const root = () => container.querySelector<HTMLElement>(".toast-container")!;

    it("stacks the toasts just above the composer and centres them on it", () => {
      vi.stubGlobal("innerHeight", 900);
      try {
        toast.anchorTo(anchorWithBox({ top: 834, left: 318, width: 882, height: 66 }));
        toast.show("Hello");
        expect(root().style.getPropertyValue("--toast-bottom")).toBe("66px");
        expect(root().style.getPropertyValue("--toast-center")).toBe("759px");
        expect(root().style.getPropertyValue("--toast-room")).toBe("882px");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("re-measures on a window resize, so a moved composer carries the stack", () => {
      vi.stubGlobal("innerHeight", 900);
      try {
        const box = { top: 834, left: 0, width: 400, height: 66 };
        toast.anchorTo(anchorWithBox(box));
        box.top = 700;
        box.height = 200;
        window.dispatchEvent(new Event("resize"));
        expect(root().style.getPropertyValue("--toast-bottom")).toBe("200px");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("keeps the stack on screen when the composer's top is above the window", () => {
      vi.stubGlobal("innerHeight", 600);
      try {
        toast.anchorTo(anchorWithBox({ top: -40, left: 0, width: 400, height: 700 }));
        expect(root().style.getPropertyValue("--toast-bottom")).toBe("536px");
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("falls back to the stylesheet's placement when the view has no composer", () => {
      toast.anchorTo(anchorWithBox({ top: 0, left: 0, width: 0, height: 0 }));
      toast.show("Hello");
      expect(root().style.getPropertyValue("--toast-bottom")).toBe("");
      expect(root().style.getPropertyValue("--toast-center")).toBe("");
      expect(root().style.getPropertyValue("--toast-room")).toBe("");
    });

    it("an empty composer slot keeps the centre but not the height", () => {
      toast.anchorTo(anchorWithBox({ top: 900, left: 100, width: 600, height: 0 }));
      expect(root().style.getPropertyValue("--toast-bottom")).toBe("");
      expect(root().style.getPropertyValue("--toast-center")).toBe("400px");
    });

    it("a new anchor replaces the old one's listeners", () => {
      const first = anchorWithBox({ top: 834, left: 0, width: 400, height: 66 });
      const measure = vi.spyOn(first, "getBoundingClientRect");
      toast.anchorTo(first);
      toast.anchorTo(anchorWithBox({ top: 800, left: 0, width: 400, height: 100 }));
      measure.mockClear();
      window.dispatchEvent(new Event("resize"));
      expect(measure).not.toHaveBeenCalled();
    });
  });

  describe("cover classes", () => {
    const microtask = (): Promise<void> => Promise.resolve();
    const root = (): HTMLElement => container.querySelector<HTMLElement>(".toast-container")!;
    const addOverlay = (cls: string): HTMLElement => {
      const el = document.createElement("div");
      el.className = cls;
      document.body.appendChild(el);
      return el;
    };
    afterEach(() => document.body.replaceChildren());

    it("sets the dialog and sheet classes when a toast shows over an overlay", () => {
      addOverlay("modal-overlay");
      toast.show("Hi");
      expect(root().classList.contains("toast-container--under-dialog")).toBe(true);
      expect(root().classList.contains("toast-container--over-sheet")).toBe(true);
    });

    it("sets only the sheet class for a bottom sheet, and only the dialog class for settings", async () => {
      addOverlay("bottom-sheet-overlay");
      toast.show("Hi", "info", Infinity);
      expect(root().classList.contains("toast-container--under-dialog")).toBe(false);
      expect(root().classList.contains("toast-container--over-sheet")).toBe(true);
      document.body.replaceChildren();
      await microtask();
      const settings = addOverlay("settings-overlay");
      await microtask();
      expect(root().classList.contains("toast-container--under-dialog")).toBe(false);
      settings.classList.add("open");
      await microtask();
      expect(root().classList.contains("toast-container--under-dialog")).toBe(true);
      expect(root().classList.contains("toast-container--over-sheet")).toBe(false);
    });

    it("follows an overlay opening and closing while a toast is on screen", async () => {
      toast.show("Hi", "info", Infinity);
      expect(root().classList.contains("toast-container--under-dialog")).toBe(false);
      const modal = addOverlay("modal-overlay");
      await microtask();
      expect(root().classList.contains("toast-container--under-dialog")).toBe(true);
      modal.remove();
      await microtask();
      expect(root().classList.contains("toast-container--under-dialog")).toBe(false);
      expect(root().classList.contains("toast-container--over-sheet")).toBe(false);
    });

    it("clears the classes for the next toast after the dialog closed behind the last one", async () => {
      const modal = addOverlay("modal-overlay");
      toast.show("Hi");
      vi.advanceTimersByTime(5400);
      modal.remove();
      await microtask();
      toast.show("Next");
      expect(root().classList.contains("toast-container--under-dialog")).toBe(false);
    });

    it("stops watching the page after the last toast leaves and on destroy", async () => {
      const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
      toast.show("Hi");
      vi.advanceTimersByTime(5400);
      await microtask();
      addOverlay("modal-overlay");
      await microtask();
      expect(disconnect).toHaveBeenCalledTimes(1);
      disconnect.mockClear();
      toast.show("Again", "info", Infinity);
      toast.destroy?.();
      expect(disconnect).toHaveBeenCalledTimes(1);
      disconnect.mockRestore();
    });
  });
});
