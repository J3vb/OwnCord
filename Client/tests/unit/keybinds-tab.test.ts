import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCaptureKeyPress = vi.fn();
const mockUpdatePttKey = vi.fn();
const mockPttSupported = vi.fn(async () => true);
const mockVkName = vi.fn((vk: number) => `Key-${vk}`);

vi.mock("@lib/ptt", () => ({
  vkName: (vk: number) => mockVkName(vk),
}));
vi.mock("../../src/platform/desktop/pushToTalk", () => ({
  pushToTalk: {
    captureKeyPress: (...args: unknown[]) => mockCaptureKeyPress(...args),
    updateKey: (...args: unknown[]) => mockUpdatePttKey(...args),
    supported: () => mockPttSupported(),
  },
}));
// U6: the tab discloses whether global (unfocused) shortcuts are available.
const mockSupported = vi.fn(async () => true);
const mockSetKeys = vi.fn(async () => {});
vi.mock("../../src/platform/desktop/globalShortcuts", () => ({
  globalShortcuts: {
    supported: () => mockSupported(),
    start: vi.fn(async () => {}),
    setKeys: (...args: unknown[]) => mockSetKeys(...(args as [])),
    onShortcut: vi.fn(() => () => {}),
  },
}));

import { buildKeybindsTab } from "../../src/components/settings/KeybindsTab";

describe("KeybindsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockCaptureKeyPress.mockReset();
    mockUpdatePttKey.mockReset();
    mockVkName.mockImplementation((vk: number) => {
      if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
      return `Key-${vk}`;
    });
  });

  afterEach(() => {
    localStorage.clear();
  });

  /** Press a key as a keydown on the given element (capture listens there). */
  function capture(element: EventTarget, code: string, init: KeyboardEventInit = {}): void {
    element.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, ...init }));
  }

  it("shows the shipped defaults for the global shortcuts and lets each be rebound", async () => {
    const el = buildKeybindsTab(new AbortController().signal);
    await vi.waitFor(() => expect(mockSupported).toHaveBeenCalled());
    const muteBtn = el.querySelector("[data-testid='keybind-global-mute']") as HTMLButtonElement;
    const deafenBtn = el.querySelector(
      "[data-testid='keybind-global-deafen']",
    ) as HTMLButtonElement;
    expect(muteBtn.textContent).toBe("Ctrl + Shift + M");
    expect(deafenBtn.textContent).toBe("Ctrl + Shift + D");

    muteBtn.click();
    capture(document, "KeyK"); // K
    expect(muteBtn.textContent).toBe("Ctrl + Shift + K");
    await vi.waitFor(() =>
      expect(mockSetKeys).toHaveBeenCalledWith({ muteVk: 0x4b, deafenVk: 0x44 }),
    );
    expect(localStorage.getItem("owncord:settings:globalMuteVk")).toBe("75");
  });

  it("rejects rebinding to a key the other global shortcut already uses", async () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const muteBtn = el.querySelector("[data-testid='keybind-global-mute']") as HTMLButtonElement;
    muteBtn.click();
    capture(document, "KeyD"); // already deafen

    expect(muteBtn.textContent).toBe("Ctrl + Shift + M");
    expect(el.textContent).toContain("already used");
    expect(mockSetKeys).not.toHaveBeenCalled();
  });

  it("rejects rebinding to the in-app camera shortcut", async () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const muteBtn = el.querySelector("[data-testid='keybind-global-mute']") as HTMLButtonElement;
    muteBtn.click();
    capture(document, "KeyV"); // Ctrl+Shift+V is Toggle Camera

    expect(muteBtn.textContent).toBe("Ctrl + Shift + M");
    expect(el.textContent).toContain("already used");
    expect(mockSetKeys).not.toHaveBeenCalled();
  });

  it("ignores a capture that is not a supported key", async () => {
    const controller = new AbortController();
    const el = buildKeybindsTab(controller.signal);
    const muteBtn = el.querySelector("[data-testid='keybind-global-mute']") as HTMLButtonElement;
    muteBtn.click();
    capture(document, "ShiftLeft"); // a modifier alone is not bindable

    expect(muteBtn.textContent).toBe("Press a supported key..."); // still capturing
    expect(mockSetKeys).not.toHaveBeenCalled();
    expect(localStorage.getItem("owncord:settings:globalMuteVk")).toBeNull();
    controller.abort(); // release the capture listener the tab owns
  });

  it("stops listening for a capture once the capture is cancelled", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const deafenBtn = el.querySelector(
      "[data-testid='keybind-global-deafen']",
    ) as HTMLButtonElement;
    deafenBtn.click();
    // Escape cancels the capture and must not reach the overlay's own
    // bubble-phase Escape handler (which closes Settings).
    const bubble = vi.fn();
    document.addEventListener("keydown", bubble);
    capture(document, "Escape");
    expect(bubble).not.toHaveBeenCalled();
    document.removeEventListener("keydown", bubble);
    // A later key must not bind.
    capture(document, "KeyK");
    expect(deafenBtn.textContent).toBe("Ctrl + Shift + D");
    expect(mockSetKeys).not.toHaveBeenCalled();
  });

  it("prompts for a key while capturing and restores the label on Escape", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const muteBtn = el.querySelector("[data-testid='keybind-global-mute']") as HTMLButtonElement;
    muteBtn.click();
    expect(muteBtn.textContent).toBe("Press a supported key...");
    capture(document, "Escape");
    expect(muteBtn.textContent).toBe("Ctrl + Shift + M");
  });

  it("lets Tab move focus and cancels the capture instead of binding it", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const muteBtn = el.querySelector("[data-testid='keybind-global-mute']") as HTMLButtonElement;
    muteBtn.click();
    const tab = new KeyboardEvent("keydown", { code: "Tab", bubbles: true, cancelable: true });
    document.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(muteBtn.textContent).toBe("Ctrl + Shift + M");
    capture(document, "KeyK");
    expect(muteBtn.textContent).toBe("Ctrl + Shift + M");
    expect(mockSetKeys).not.toHaveBeenCalled();
  });

  it("does not bind Enter", () => {
    const controller = new AbortController();
    const el = buildKeybindsTab(controller.signal);
    const muteBtn = el.querySelector("[data-testid='keybind-global-mute']") as HTMLButtonElement;
    muteBtn.click();
    capture(document, "Enter");
    expect(mockSetKeys).not.toHaveBeenCalled();
    expect(localStorage.getItem("owncord:settings:globalMuteVk")).toBeNull();
    controller.abort();
  });

  it("returns a div with settings-pane class", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("settings-pane active");
  });

  it("renders section headers instead of h1", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const headers = el.querySelectorAll(".keybind-section-header");
    expect(headers.length).toBe(4);
    const headerTexts = Array.from(headers).map((h) => h.textContent);
    expect(headerTexts).toEqual(["Navigation", "Communication", "Global Shortcuts", "Messages"]);
  });

  it("renders Push to Talk keybind row", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const rows = el.querySelectorAll(".keybind-row");
    // 1 PTT + 3 Navigation + 3 Communication + 2 Global + 5 Messages = 14
    expect(rows.length).toBe(14);
    const pttLabel = rows[0]!.querySelector(".setting-label");
    expect(pttLabel!.textContent).toBe("Push to Talk");
  });

  it("renders Quick Switcher keybind row with Ctrl + K", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const rows = el.querySelectorAll(".keybind-row");
    const kbd = rows[1]!.querySelector(".kbd");
    expect(kbd!.textContent).toBe("Ctrl + K");
  });

  it("shows fallback for PTT when not configured", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const rows = el.querySelectorAll(".keybind-row");
    const kbd = rows[0]!.querySelector(".kbd");
    expect(kbd!.textContent).toBe("Not set");
  });

  it("PTT capture control is a <button> element", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const rows = el.querySelectorAll(".keybind-row");
    const pttControl = rows[0]!.querySelector(".kbd");
    expect(pttControl!.tagName).toBe("BUTTON");
  });

  it("PTT capture control has an accessible label", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const rows = el.querySelectorAll(".keybind-row");
    const pttControl = rows[0]!.querySelector(".kbd");
    expect(pttControl!.getAttribute("aria-label")).toBeTruthy();
  });

  // --- PTT key capture flow ---

  it("shows 'Press a supported key...' when capture button is clicked", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    mockCaptureKeyPress.mockReturnValue(new Promise(() => {})); // never resolves
    const pttBtn = el
      .querySelectorAll(".keybind-row")[0]!
      .querySelector(".kbd") as HTMLButtonElement;

    pttBtn.click();

    expect(pttBtn.textContent).toBe("Press a supported key...");
    expect(pttBtn.style.borderColor).toBe("var(--accent)");
    expect(pttBtn.style.color).toBe("var(--accent)");
  });

  it("sets PTT key when captureKeyPress resolves with a VK code", async () => {
    const el = buildKeybindsTab(new AbortController().signal);
    mockCaptureKeyPress.mockResolvedValue(0x05); // Mouse 5
    mockVkName.mockReturnValue("Mouse 5");
    const pttBtn = el
      .querySelectorAll(".keybind-row")[0]!
      .querySelector(".kbd") as HTMLButtonElement;

    pttBtn.click();

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("Mouse 5");
    });
    expect(mockUpdatePttKey).toHaveBeenCalledWith(0x05);
    expect(pttBtn.style.borderColor).toBe("");
    expect(pttBtn.style.color).toBe("");
  });

  it("ignores a capture that completes after settings closes", async () => {
    let finish!: (vk: number) => void;
    mockCaptureKeyPress.mockReturnValue(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );
    const controller = new AbortController();
    const el = buildKeybindsTab(controller.signal);
    const button = el.querySelector(".kbd") as HTMLButtonElement;
    button.click();
    controller.abort();
    finish(0x20);
    await Promise.resolve();

    expect(mockUpdatePttKey).not.toHaveBeenCalled();
  });

  it("does not re-enable a cleared key when the previous capture completes", async () => {
    localStorage.setItem("owncord:settings:pttVk", "113");
    let finish!: (vk: number) => void;
    mockCaptureKeyPress.mockReturnValue(
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    );
    const controller = new AbortController();
    const el = buildKeybindsTab(controller.signal);
    const button = el.querySelector(".kbd") as HTMLButtonElement;
    button.click();
    (el.querySelector(".ac-btn") as HTMLButtonElement).click();
    finish(0x20);
    await Promise.resolve();

    expect(mockUpdatePttKey).toHaveBeenCalledExactlyOnceWith(0);
    expect(button.textContent).toBe("Not set");
    expect(button.style.borderColor).toBe("");
    controller.abort();
  });

  it("restores previous value when captureKeyPress times out (returns 0)", async () => {
    const el = buildKeybindsTab(new AbortController().signal);
    mockCaptureKeyPress.mockResolvedValue(0);
    const pttBtn = el
      .querySelectorAll(".keybind-row")[0]!
      .querySelector(".kbd") as HTMLButtonElement;

    pttBtn.click();

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("Not set");
    });
    expect(mockUpdatePttKey).not.toHaveBeenCalled();
  });

  it("restores previous value on captureKeyPress failure (fallback path)", async () => {
    const el = buildKeybindsTab(new AbortController().signal);
    mockCaptureKeyPress.mockRejectedValue(new Error("No Tauri"));
    const pttBtn = el
      .querySelectorAll(".keybind-row")[0]!
      .querySelector(".kbd") as HTMLButtonElement;

    pttBtn.click();

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("Not set");
    });
    expect(pttBtn.style.borderColor).toBe("");
    expect(pttBtn.style.color).toBe("");
  });

  it("ignores click when already capturing", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    mockCaptureKeyPress.mockReturnValue(new Promise(() => {})); // never resolves
    const pttBtn = el
      .querySelectorAll(".keybind-row")[0]!
      .querySelector(".kbd") as HTMLButtonElement;

    pttBtn.click();
    expect(pttBtn.textContent).toBe("Press a supported key...");

    // Second click should be ignored
    pttBtn.click();
    expect(mockCaptureKeyPress).toHaveBeenCalledTimes(1);
  });

  it("shows Clear button after setting a key and hides it after clearing", async () => {
    const el = buildKeybindsTab(new AbortController().signal);
    mockCaptureKeyPress.mockResolvedValue(0x71); // F2
    mockVkName.mockReturnValue("F2");
    const pttRow = el.querySelectorAll(".keybind-row")[0]!;
    const pttBtn = pttRow.querySelector(".kbd") as HTMLButtonElement;
    const clearBtn = pttRow.querySelector(".ac-btn") as HTMLButtonElement;

    // Initially hidden (no key set)
    expect(clearBtn.style.display).toBe("none");

    pttBtn.click();

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("F2");
    });
    expect(clearBtn.style.display).toBe("");

    // Click clear
    clearBtn.click();
    expect(pttBtn.textContent).toBe("Not set");
    expect(clearBtn.style.display).toBe("none");
    expect(mockUpdatePttKey).toHaveBeenCalledWith(0);
  });

  it("displays stored PTT key name when a key was previously saved", () => {
    localStorage.setItem("owncord:settings:pttVk", "113"); // 0x71 = F2
    mockVkName.mockReturnValue("F2");
    const el = buildKeybindsTab(new AbortController().signal);
    const pttRow = el.querySelectorAll(".keybind-row")[0]!;
    const pttBtn = pttRow.querySelector(".kbd") as HTMLButtonElement;
    const clearBtn = pttRow.querySelector(".ac-btn") as HTMLButtonElement;

    expect(pttBtn.textContent).toBe("F2");
    // Clear button should be visible when a key is set
    expect(clearBtn.style.display).not.toBe("none");
  });

  // --- Separators ---

  it("renders separators between sections", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const separators = el.querySelectorAll(".settings-separator");
    expect(separators.length).toBe(4);
  });

  // --- PTT hint text ---

  it("renders PTT hint text", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const hint = el.querySelector("div[style*='font-size: 11px']");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("PTT works globally");
  });

  // --- All keybinds present ---

  it("renders Close Overlay, Search Messages, Upload File, Edit Last Message keybinds", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const labels = Array.from(el.querySelectorAll(".setting-label")).map((l) => l.textContent);
    // "Mark as Read" used to be listed here with no feature behind it.
    expect(labels).not.toContain("Mark as Read");
    expect(labels).toContain("Close Overlay / Cancel");
    expect(labels).toContain("Search Messages");
    expect(labels).toContain("Upload File");
    expect(labels).toContain("Edit Last Message");
  });

  it("renders the composer formatting keybinds and explains the Ctrl+U overlap", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const labels = Array.from(el.querySelectorAll(".setting-label")).map((l) => l.textContent);
    expect(labels).toContain("Bold");
    expect(labels).toContain("Italic");
    expect(labels).toContain("Underline");
    expect(el.textContent).toContain("Formatting shortcuts wrap the selected text");
  });

  it("renders Toggle Mute, Toggle Deafen, Toggle Camera keybinds", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const labels = Array.from(el.querySelectorAll(".setting-label")).map((l) => l.textContent);
    expect(labels).toContain("Toggle Mute");
    expect(labels).toContain("Toggle Deafen");
    expect(labels).toContain("Toggle Camera");
  });

  // --- Clear button stopPropagation ---

  it("clear button click does not trigger parent click handlers", async () => {
    const el = buildKeybindsTab(new AbortController().signal);
    // First set a key
    localStorage.setItem("owncord:settings:pttVk", "113");
    mockVkName.mockReturnValue("F2");
    const el2 = buildKeybindsTab(new AbortController().signal);
    const pttRow = el2.querySelectorAll(".keybind-row")[0]!;
    const clearBtn = pttRow.querySelector(".ac-btn") as HTMLButtonElement;

    // The clear button should call stopPropagation
    const clickEvent = new MouseEvent("click", { bubbles: true });
    const stopSpy = vi.spyOn(clickEvent, "stopPropagation");
    clearBtn.dispatchEvent(clickEvent);
    expect(stopSpy).toHaveBeenCalled();
  });

  // --- Timeout/catch with previously set key ---

  it("restores previous key name when captureKeyPress times out and a key was already set", async () => {
    // Simulate having F2 (0x71) already set
    localStorage.setItem("owncord:settings:pttVk", "113");
    mockVkName.mockReturnValue("F2");
    mockCaptureKeyPress.mockResolvedValue(0);

    const el = buildKeybindsTab(new AbortController().signal);
    const pttBtn = el
      .querySelectorAll(".keybind-row")[0]!
      .querySelector(".kbd") as HTMLButtonElement;

    expect(pttBtn.textContent).toBe("F2");

    pttBtn.click();
    expect(pttBtn.textContent).toBe("Press a supported key...");

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("F2");
    });
    expect(mockUpdatePttKey).not.toHaveBeenCalled();
  });

  it("restores previous key name when captureKeyPress rejects and a key was already set", async () => {
    localStorage.setItem("owncord:settings:pttVk", "113");
    mockVkName.mockReturnValue("F2");
    mockCaptureKeyPress.mockRejectedValue(new Error("No Tauri"));

    const el = buildKeybindsTab(new AbortController().signal);
    const pttBtn = el
      .querySelectorAll(".keybind-row")[0]!
      .querySelector(".kbd") as HTMLButtonElement;

    expect(pttBtn.textContent).toBe("F2");

    pttBtn.click();

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("F2");
    });
  });

  it("promises unfocused shortcuts through the tray and the global keys when supported (U6)", async () => {
    mockSupported.mockResolvedValue(true);
    const el = buildKeybindsTab(new AbortController().signal);
    const hint = el.querySelector("[data-testid='keybinds-global-hint']")!;
    await vi.waitFor(() => expect(mockSupported).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hint.textContent).toBe(
      "Mute and Deafen also work while OwnCord is unfocused — via the global shortcuts you set below (Ctrl + Shift + M / Ctrl + Shift + D by default), or the tray menu. On Linux (X11) the global keys use the key positions of a US layout.",
    );
  });

  it("discloses the missing global-key path on a desktop without it (U6)", async () => {
    mockSupported.mockResolvedValue(false);
    const el = buildKeybindsTab(new AbortController().signal);
    const hint = el.querySelector("[data-testid='keybinds-global-hint']")!;
    await vi.waitFor(() => {
      expect(hint.textContent).toBe(
        "Mute and Deafen work while OwnCord is unfocused through the tray menu. This desktop does not support global mute/deafen shortcuts.",
      );
    });
  });

  it("falls back to the tray-only hint when the host cannot answer (U6)", async () => {
    mockSupported.mockRejectedValue(new Error("no Tauri host"));
    const el = buildKeybindsTab(new AbortController().signal);
    const hint = el.querySelector("[data-testid='keybinds-global-hint']")!;
    await vi.waitFor(() => {
      expect(hint.textContent).toBe(
        "Mute and Deafen work while OwnCord is unfocused through the tray menu. This desktop does not support global mute/deafen shortcuts.",
      );
    });
  });

  it("disables PTT and discloses the gap where key polling is unsupported (voice #12)", async () => {
    mockPttSupported.mockResolvedValue(false);
    const el = buildKeybindsTab(new AbortController().signal);
    const pttBtn = el.querySelector(
      '[aria-label="Push to Talk keybind — click to capture"]',
    ) as HTMLButtonElement;
    await vi.waitFor(() => {
      expect(pttBtn.disabled).toBe(true);
    });
    // The hint says why, in the same region the capture button lives.
    expect(el.textContent).toContain("Push to Talk needs global key observation");
    // A key bound before (another session) can still be cleared.
    const clear = [...el.querySelectorAll("button")].find((b) => b.textContent === "Clear")!;
    expect(clear.disabled).toBe(false);
  });
});
