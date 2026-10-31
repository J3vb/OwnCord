import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCaptureKeyPress = vi.fn();
const mockUpdatePttKey = vi.fn();
const mockPttSupported = vi.fn(async () => true);
const mockVkName = vi.fn((vk: number) => `Key-${vk}`);

vi.mock("@lib/voice/ptt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lib/voice/ptt")>()),
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
// LP-9b: the backend the host reports; polling unless a test says otherwise.
const pollingStatus = {
  backend: "polling",
  portalVersion: 0,
  triggers: { ptt: null, mute: null, deafen: null },
  canConfigure: false,
  triggersUnnamed: false,
  sessionRefused: false,
};
const mockStatus = vi.fn(async (): Promise<unknown> => pollingStatus);
const mockBindPortal = vi.fn(async (..._args: unknown[]): Promise<unknown> => pollingStatus);
const mockConfigurePortal = vi.fn(async () => {});
const statusHandlers = new Set<(status: unknown) => void>();
vi.mock("../../src/platform/desktop/globalShortcuts", () => ({
  globalShortcuts: {
    supported: () => mockSupported(),
    start: vi.fn(async () => {}),
    setKeys: (...args: unknown[]) => mockSetKeys(...(args as [])),
    onShortcut: vi.fn(() => () => {}),
    status: () => mockStatus(),
    bindPortal: (...args: unknown[]) => mockBindPortal(...args),
    configurePortal: () => mockConfigurePortal(),
    onStatusChange: (handler: (status: unknown) => void) => {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
  },
}));

import { buildKeybindsTab } from "../../src/features/settings/KeybindsTab";
import { KEYBIND_GROUPS } from "../../src/lib/prefs/keybindCatalog";
import { settingsText as t } from "../../src/i18n/settings";

function buildTab(signal: AbortSignal = new AbortController().signal): HTMLElement {
  return buildKeybindsTab(signal);
}

function firstKbdButton(el: HTMLElement): HTMLButtonElement {
  return el.querySelectorAll(".keybind-row")[0]!.querySelector(".kbd") as HTMLButtonElement;
}

/** Makes the next key capture hang until the returned function resolves it. */
function holdCapture(): (vk: number) => void {
  let finish!: (vk: number) => void;
  mockCaptureKeyPress.mockReturnValue(
    new Promise<number>((resolve) => {
      finish = resolve;
    }),
  );
  return finish;
}

function resetShortcutMocks(): void {
  vi.clearAllMocks();
  statusHandlers.clear();
  mockStatus.mockImplementation(async () => pollingStatus);
  mockBindPortal.mockImplementation(async () => pollingStatus);
  mockSupported.mockImplementation(async () => true);
  mockPttSupported.mockImplementation(async () => true);
}

describe("KeybindsTab", () => {
  beforeEach(() => {
    resetShortcutMocks();
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

  it("saves the push-to-talk release delay from its slider, 20 ms by default", () => {
    const el = buildTab();
    const slider = el.querySelector("[data-testid='ptt-release-delay']") as HTMLInputElement;
    const value = el.querySelector("[data-testid='ptt-release-delay-value']")!;
    expect(slider.type).toBe("range");
    expect([slider.min, slider.max, slider.value]).toEqual(["0", "2000", "20"]);
    expect(slider.getAttribute("aria-label")).toBe("Push to Talk release delay");
    expect(value.textContent).toBe("20 ms");

    slider.value = "250";
    slider.dispatchEvent(new Event("input"));

    expect(localStorage.getItem("owncord:settings:pttReleaseDelayMs")).toBe("250");
    expect(value.textContent).toBe("250 ms");
    expect(slider.getAttribute("aria-valuetext")).toBe("250 ms");
  });

  it("disables the release delay where push-to-talk cannot gate the mic", async () => {
    mockPttSupported.mockResolvedValueOnce(false);
    const el = buildTab();
    const slider = el.querySelector("[data-testid='ptt-release-delay']") as HTMLInputElement;
    await vi.waitFor(() => expect(slider.disabled).toBe(true));
  });

  it("shows the shipped defaults for the global shortcuts and lets each be rebound", async () => {
    const el = buildTab();
    await vi.waitFor(() => expect(mockSupported).toHaveBeenCalled());
    const muteBtn = el.querySelector("[data-testid='keybind-global-mute']") as HTMLButtonElement;
    const deafenBtn = el.querySelector(
      "[data-testid='keybind-global-deafen']",
    ) as HTMLButtonElement;
    expect(muteBtn.textContent).toBe("Ctrl + Shift + M");
    expect(deafenBtn.textContent).toBe("Ctrl + Shift + D");

    muteBtn.click();
    capture(document, "KeyG"); // G
    expect(muteBtn.textContent).toBe("Ctrl + Shift + G");
    await vi.waitFor(() =>
      expect(mockSetKeys).toHaveBeenCalledWith({ muteVk: 0x47, deafenVk: 0x44 }),
    );
    expect(localStorage.getItem("owncord:settings:globalMuteVk")).toBe("71");
  });

  it("lists in-app mute and deafen on the global binding and follows a rebind", async () => {
    const el = buildTab();
    const commRow = (label: string): HTMLElement =>
      [...el.querySelectorAll<HTMLElement>(".keybind-row")].find(
        (row) =>
          row.querySelector(".setting-label")?.textContent === label &&
          row.querySelector("span.kbd") !== null,
      )!;
    expect(commRow("Toggle Mute").querySelector(".kbd")!.textContent).toBe("Ctrl + Shift + M");
    expect(commRow("Toggle Deafen").querySelector(".kbd")!.textContent).toBe("Ctrl + Shift + D");
    // The camera row is a capture button now, so it is found by its test id.
    expect(el.querySelector("[data-testid='keybind-toggleCamera']")!.textContent).toBe(
      "Ctrl + Shift + V",
    );

    await vi.waitFor(() => expect(mockSupported).toHaveBeenCalled());
    (el.querySelector("[data-testid='keybind-global-deafen']") as HTMLButtonElement).click();
    capture(document, "KeyG");

    expect(commRow("Toggle Deafen").querySelector(".kbd")!.textContent).toBe("Ctrl + Shift + G");
    expect(commRow("Toggle Mute").querySelector(".kbd")!.textContent).toBe("Ctrl + Shift + M");
  });

  it("rejects rebinding to a key the other global shortcut already uses", async () => {
    const el = buildTab();
    const muteBtn = el.querySelector("[data-testid='keybind-global-mute']") as HTMLButtonElement;
    muteBtn.click();
    capture(document, "KeyD"); // already deafen

    expect(muteBtn.textContent).toBe("Ctrl + Shift + M");
    expect(el.textContent).toContain("already used");
    expect(mockSetKeys).not.toHaveBeenCalled();
  });

  it("rejects rebinding to the in-app camera shortcut", async () => {
    const el = buildTab();
    const muteBtn = el.querySelector("[data-testid='keybind-global-mute']") as HTMLButtonElement;
    muteBtn.click();
    capture(document, "KeyV"); // Ctrl+Shift+V is Toggle Camera

    expect(muteBtn.textContent).toBe("Ctrl + Shift + M");
    expect(el.textContent).toContain("already used");
    expect(mockSetKeys).not.toHaveBeenCalled();
  });

  it("rejects a fixed app key or a key a text field keeps", async () => {
    const el = buildTab();
    const muteBtn = el.querySelector("[data-testid='keybind-global-mute']") as HTMLButtonElement;
    for (const code of ["KeyK", "KeyZ", "ArrowLeft"]) {
      muteBtn.click();
      capture(document, code); // quick switcher, redo, word select
      expect(muteBtn.textContent).toBe("Ctrl + Shift + M");
      expect(el.textContent).toContain("already used");
    }
    expect(mockSetKeys).not.toHaveBeenCalled();
    expect(localStorage.getItem("owncord:settings:globalMuteVk")).toBeNull();
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
    const el = buildTab();
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
    const el = buildTab();
    const muteBtn = el.querySelector("[data-testid='keybind-global-mute']") as HTMLButtonElement;
    muteBtn.click();
    expect(muteBtn.textContent).toBe("Press a supported key...");
    capture(document, "Escape");
    expect(muteBtn.textContent).toBe("Ctrl + Shift + M");
  });

  it("lets Tab move focus and cancels the capture instead of binding it", () => {
    const el = buildTab();
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

  it("says the key does nothing while Input Mode is Voice Activity", () => {
    localStorage.setItem("owncord:settings:inputMode", '"vad"');
    const tab = buildTab();
    expect(tab.querySelector('[data-testid="ptt-mode-note"]')).not.toBeNull();

    localStorage.setItem("owncord:settings:inputMode", '"ptt"');
    const ptt = buildTab();
    expect(ptt.querySelector('[data-testid="ptt-mode-note"]')).toBeNull();
  });

  it("returns a div with settings-pane class", () => {
    const el = buildTab();
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("settings-pane active");
  });

  it("renders section headers instead of h1", () => {
    const el = buildTab();
    const headers = el.querySelectorAll(".keybind-section-header");
    expect(headers.length).toBe(4);
    const headerTexts = Array.from(headers).map((h) => h.textContent);
    expect(headerTexts).toEqual(["Navigation", "Communication", "Global Shortcuts", "Messages"]);
  });

  it("renders Push to Talk keybind row", () => {
    const el = buildTab();
    const rows = el.querySelectorAll(".keybind-row");
    // 1 PTT + 10 Navigation + 5 Communication (mute, deafen, camera, screen
    // share, disconnect) + 2 Global + 7 Messages = 25
    expect(rows.length).toBe(25);
    const pttLabel = rows[0]!.querySelector(".setting-label");
    expect(pttLabel!.textContent).toBe("Push to Talk");
  });

  it("renders Quick Switcher keybind row with Ctrl + K", () => {
    const el = buildTab();
    const rows = el.querySelectorAll(".keybind-row");
    const kbd = rows[1]!.querySelector(".kbd");
    expect(kbd!.textContent).toBe("Ctrl + K");
  });

  it("shows fallback for PTT when not configured", () => {
    const el = buildTab();
    const rows = el.querySelectorAll(".keybind-row");
    const kbd = rows[0]!.querySelector(".kbd");
    expect(kbd!.textContent).toBe("Not set");
  });

  it("PTT capture control is a <button> element", () => {
    const el = buildTab();
    const rows = el.querySelectorAll(".keybind-row");
    const pttControl = rows[0]!.querySelector(".kbd");
    expect(pttControl!.tagName).toBe("BUTTON");
  });

  it("PTT capture control has an accessible label", () => {
    const el = buildTab();
    const rows = el.querySelectorAll(".keybind-row");
    const pttControl = rows[0]!.querySelector(".kbd");
    expect(pttControl!.getAttribute("aria-label")).toBeTruthy();
  });

  // --- PTT key capture flow ---

  it("shows 'Press a supported key...' when capture button is clicked", () => {
    const el = buildTab();
    mockCaptureKeyPress.mockReturnValue(new Promise(() => {})); // never resolves
    const pttBtn = firstKbdButton(el);

    pttBtn.click();

    expect(pttBtn.textContent).toBe("Press a supported key...");
    expect(pttBtn.style.borderColor).toBe("var(--accent)");
    expect(pttBtn.style.color).toBe("var(--accent)");
  });

  it("sets PTT key when captureKeyPress resolves with a VK code", async () => {
    const el = buildTab();
    mockCaptureKeyPress.mockResolvedValue(0x05); // Mouse 5
    mockVkName.mockReturnValue("Mouse 5");
    const pttBtn = firstKbdButton(el);

    pttBtn.click();

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("Mouse 5");
    });
    expect(mockUpdatePttKey).toHaveBeenCalledWith(0x05);
    expect(pttBtn.style.borderColor).toBe("");
    expect(pttBtn.style.color).toBe("");
  });

  it("ignores a capture that completes after settings closes", async () => {
    const finish = holdCapture();
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
    const finish = holdCapture();
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
    const el = buildTab();
    mockCaptureKeyPress.mockResolvedValue(0);
    const pttBtn = firstKbdButton(el);

    pttBtn.click();

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("Not set");
    });
    expect(mockUpdatePttKey).not.toHaveBeenCalled();
  });

  it("restores previous value on captureKeyPress failure (fallback path)", async () => {
    const el = buildTab();
    mockCaptureKeyPress.mockRejectedValue(new Error("No Tauri"));
    const pttBtn = firstKbdButton(el);

    pttBtn.click();

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("Not set");
    });
    expect(pttBtn.style.borderColor).toBe("");
    expect(pttBtn.style.color).toBe("");
  });

  it("ignores click when already capturing", () => {
    const el = buildTab();
    mockCaptureKeyPress.mockReturnValue(new Promise(() => {})); // never resolves
    const pttBtn = firstKbdButton(el);

    pttBtn.click();
    expect(pttBtn.textContent).toBe("Press a supported key...");

    // Second click should be ignored
    pttBtn.click();
    expect(mockCaptureKeyPress).toHaveBeenCalledTimes(1);
  });

  it("shows Clear button after setting a key and hides it after clearing", async () => {
    const el = buildTab();
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
    const el = buildTab();
    const pttRow = el.querySelectorAll(".keybind-row")[0]!;
    const pttBtn = pttRow.querySelector(".kbd") as HTMLButtonElement;
    const clearBtn = pttRow.querySelector(".ac-btn") as HTMLButtonElement;

    expect(pttBtn.textContent).toBe("F2");
    // Clear button should be visible when a key is set
    expect(clearBtn.style.display).not.toBe("none");
  });

  // --- Separators ---

  it("renders separators between sections", () => {
    const el = buildTab();
    const separators = el.querySelectorAll(".settings-separator");
    expect(separators.length).toBe(4);
  });

  // --- PTT hint text ---

  it("renders PTT hint text", () => {
    const el = buildTab();
    const hint = el.querySelector("div[style*='font-size: 11px']");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("PTT works globally");
  });

  // --- All keybinds present ---

  it("renders Close Overlay, Search Messages, Upload File, Edit Last Message keybinds", () => {
    const el = buildTab();
    const labels = Array.from(el.querySelectorAll(".setting-label")).map((l) => l.textContent);
    // "Mark as Read" used to be listed here with no feature behind it.
    expect(labels).not.toContain("Mark as Read");
    expect(labels).toContain("Close Overlay / Cancel");
    expect(labels).toContain("Search Messages");
    expect(labels).toContain("Upload File");
    expect(labels).toContain("Edit Last Message");
  });

  it("lists the chat keys with their combos, upload on Ctrl+Shift+U", () => {
    const el = buildTab();
    const rows = new Map(
      Array.from(el.querySelectorAll(".keybind-row")).map((r) => [
        r.querySelector(".setting-label")?.textContent,
        r.querySelector(".kbd")?.textContent,
      ]),
    );
    expect(rows.get("Upload File")).toBe("Ctrl + Shift + U");
    expect(rows.get("Underline")).toBe("Ctrl + U");
    expect(rows.get("Mark Channel as Read")).toBe("Escape");
    expect(rows.get("Mark Server as Read")).toBe("Shift + Escape");
    expect(rows.get("Scroll Chat")).toBe("Page Up / Page Down");
    expect(rows.get("Emoji Picker")).toBe("Ctrl + E");
    expect(rows.get("GIF Picker")).toBe("Ctrl + G");
  });

  it("lists Open Settings on Ctrl + , in the Navigation section", () => {
    const el = buildTab();
    const row = Array.from(el.querySelectorAll(".keybind-row")).find(
      (r) => r.querySelector(".setting-label")?.textContent === "Open Settings",
    );
    expect(row).toBeDefined();
    expect(row!.querySelector(".kbd")?.textContent).toBe("Ctrl + ,");
    expect(row!.className).toBe("keybind-row");
  });

  it("lists Show Keyboard Shortcuts on Ctrl + / in the Navigation section", () => {
    const el = buildTab();
    const row = Array.from(el.querySelectorAll(".keybind-row")).find(
      (r) => r.querySelector(".setting-label")?.textContent === "Show Keyboard Shortcuts",
    );
    expect(row).toBeDefined();
    expect(row!.querySelector(".kbd")?.textContent).toBe("Ctrl + /");
  });

  it("renders every catalog row, in catalog order within each group", () => {
    const el = buildTab();
    const rendered = Array.from(el.querySelectorAll(".keybind-row")).map(
      (r) =>
        `${r.querySelector(".setting-label")?.textContent}|${r.querySelector(".kbd")?.textContent}`,
    );
    let from = 0;
    for (const group of KEYBIND_GROUPS) {
      for (const r of group.rows) {
        const at = rendered.indexOf(`${t(r.action)}|${t(r.combo)}`, from);
        expect(at, t(r.action)).toBeGreaterThanOrEqual(from);
        from = at;
      }
    }
  });

  it("renders the composer formatting keybinds and their hint", () => {
    const el = buildTab();
    const labels = Array.from(el.querySelectorAll(".setting-label")).map((l) => l.textContent);
    expect(labels).toContain("Bold");
    expect(labels).toContain("Italic");
    expect(labels).toContain("Underline");
    expect(el.textContent).toContain("Formatting shortcuts wrap the selected text");
  });

  it("renders Toggle Mute, Toggle Deafen, Toggle Camera keybinds", () => {
    const el = buildTab();
    const labels = Array.from(el.querySelectorAll(".setting-label")).map((l) => l.textContent);
    expect(labels).toContain("Toggle Mute");
    expect(labels).toContain("Toggle Deafen");
    expect(labels).toContain("Toggle Camera");
  });

  // --- Clear button stopPropagation ---

  it("clear button click does not trigger parent click handlers", async () => {
    buildTab();
    // First set a key
    localStorage.setItem("owncord:settings:pttVk", "113");
    mockVkName.mockReturnValue("F2");
    const el2 = buildTab();
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

    const el = buildTab();
    const pttBtn = firstKbdButton(el);

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

    const el = buildTab();
    const pttBtn = firstKbdButton(el);

    expect(pttBtn.textContent).toBe("F2");

    pttBtn.click();

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("F2");
    });
  });

  it("promises unfocused shortcuts through the tray and the global keys when supported (U6)", async () => {
    mockSupported.mockResolvedValue(true);
    const el = buildTab();
    const hint = el.querySelector("[data-testid='keybinds-global-hint']")!;
    await vi.waitFor(() => expect(mockSupported).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(hint.textContent).toBe(
      "Mute and Deafen also work while OwnCord is unfocused — via the global shortcuts you set below (Ctrl + Shift + M / Ctrl + Shift + D by default), or the tray menu. On Linux (X11) the global keys use the key positions of a US layout.",
    );
  });

  it("discloses the missing global-key path on a desktop without it (U6)", async () => {
    mockSupported.mockResolvedValue(false);
    const el = buildTab();
    const hint = el.querySelector("[data-testid='keybinds-global-hint']")!;
    await vi.waitFor(() => {
      expect(hint.textContent).toBe(
        "Mute and Deafen work while OwnCord is unfocused through the tray menu. This desktop has no global shortcut service (macOS, or Linux on GNOME 47 or older, Sway or another wlroots desktop), so global mute/deafen shortcuts are not available.",
      );
    });
  });

  it("falls back to the tray-only hint when the host cannot answer (U6)", async () => {
    mockSupported.mockRejectedValue(new Error("no Tauri host"));
    const el = buildTab();
    const hint = el.querySelector("[data-testid='keybinds-global-hint']")!;
    await vi.waitFor(() => {
      expect(hint.textContent).toBe(
        "Mute and Deafen work while OwnCord is unfocused through the tray menu. This desktop has no global shortcut service (macOS, or Linux on GNOME 47 or older, Sway or another wlroots desktop), so global mute/deafen shortcuts are not available.",
      );
    });
  });

  it("disables PTT and discloses the gap where key polling is unsupported (voice #12)", async () => {
    mockPttSupported.mockResolvedValue(false);
    const el = buildTab();
    const pttBtn = el.querySelector(
      '[aria-label="Push to Talk keybind — click to capture"]',
    ) as HTMLButtonElement;
    await vi.waitFor(() => {
      expect(pttBtn.disabled).toBe(true);
    });
    // The hint says why, in the same region the capture button lives.
    expect(el.textContent).toContain("Push to Talk needs a global key service");
    // A key bound before (another session) can still be cleared.
    const clear = [...el.querySelectorAll("button")].find((b) => b.textContent === "Clear")!;
    expect(clear.disabled).toBe(false);
  });

  describe("Wayland portal backend", () => {
    const bound = { ptt: null, mute: "Ctrl+Alt+M", deafen: "Ctrl+Alt+D" };
    const portal = (
      triggers: { ptt: string | null; mute: string | null; deafen: string | null },
      portalVersion = 2,
    ) => ({
      backend: "portal",
      portalVersion,
      triggers,
      canConfigure: portalVersion >= 2,
      triggersUnnamed: false,
      sessionRefused: false,
    });
    const unbound = { ptt: null, mute: null, deafen: null };
    const testId = (el: HTMLElement, id: string): HTMLElement =>
      el.querySelector(`[data-testid='${id}']`) as HTMLElement;
    const kbdOf = (el: HTMLElement, label: string): string =>
      [...el.querySelectorAll(".keybind-row")]
        .find((row) => row.querySelector(".setting-label")?.textContent === label)!
        .querySelector(".kbd")!.textContent!;
    const portalErr = (code: string) => Object.assign(new Error(code), { code });

    it("tells the user the desktop refused the session, and clears it when one opens", async () => {
      mockStatus.mockResolvedValue({ ...portal(unbound), sessionRefused: true });
      const el = buildTab();
      const note = testId(el, "keybinds-portal-note");
      await vi.waitFor(() => expect(note.textContent).toContain("refused global shortcuts"));
      expect(note.style.display).toBe("");

      for (const handler of statusHandlers) handler(portal(unbound));
      expect(note.style.display).toBe("none");
      expect(note.textContent).toBe("");
    });

    it("keeps a bind error the user just got when a refused status follows or goes away", async () => {
      mockStatus.mockResolvedValue(portal(unbound));
      mockBindPortal.mockRejectedValue(portalErr("bind_cancelled"));
      const el = buildTab();
      const setUp = testId(el, "keybinds-portal-setup") as HTMLButtonElement;
      await vi.waitFor(() => expect(setUp.style.display).toBe(""));
      setUp.click();
      const note = testId(el, "keybinds-portal-note");
      await vi.waitFor(() => expect(note.textContent).toContain("cancelled"));

      for (const handler of statusHandlers) handler({ ...portal(unbound), sessionRefused: true });
      expect(note.textContent).toContain("cancelled");
      for (const handler of statusHandlers) handler(portal(unbound));
      expect(note.textContent).toContain("cancelled");
    });

    it("explains that the desktop names no keys and hides Set up", async () => {
      mockStatus.mockResolvedValue({ ...portal(unbound), triggersUnnamed: true });
      const el = buildTab();
      const unnamed = testId(el, "keybinds-portal-unnamed");
      await vi.waitFor(() => expect(unnamed.style.display).toBe(""));
      expect(unnamed.textContent).toContain("bind = CTRL SHIFT, M, global, com.owncord.client:");
      expect(unnamed.textContent).toContain("toggle-mute");
      expect(testId(el, "keybinds-portal-setup").style.display).toBe("none");
      expect(kbdOf(el, "Toggle Mute")).toBe("Set in your desktop");
      expect(kbdOf(el, "Toggle Deafen")).toBe("Set in your desktop");

      for (const handler of statusHandlers) handler(portal(unbound));
      expect(unnamed.style.display).toBe("none");
      expect(testId(el, "keybinds-portal-setup").style.display).toBe("");
      expect(kbdOf(el, "Toggle Mute")).toBe("Ctrl + Shift + M");
    });

    it("remembers a bind that left the triggers unnamed, so the next start re-binds", async () => {
      mockStatus.mockResolvedValue(portal(unbound));
      mockBindPortal.mockResolvedValue({ ...portal(unbound), triggersUnnamed: true });
      const el = buildTab();
      const setUp = testId(el, "keybinds-portal-setup") as HTMLButtonElement;
      await vi.waitFor(() => expect(setUp.style.display).toBe(""));
      setUp.click();
      await vi.waitFor(() =>
        expect(localStorage.getItem("owncord:settings:globalKeysPortalBound")).toBe("true"),
      );
      expect(testId(el, "keybinds-portal-unnamed").style.display).toBe("");
    });

    it("shows the reported triggers and hides the Ctrl+Shift capture rows", async () => {
      mockStatus.mockResolvedValue(portal(bound));
      const el = buildTab();
      await vi.waitFor(() => expect(testId(el, "keybinds-portal").style.display).toBe(""));
      expect(kbdOf(el, "Toggle Mute")).toBe("Ctrl+Alt+M");
      expect(kbdOf(el, "Toggle Deafen")).toBe("Ctrl+Alt+D");
      // The polling rows stay hidden, and the polling probe is never asked.
      expect(testId(el, "keybind-global-mute").closest("div[style]")).toHaveProperty(
        "style.display",
        "none",
      );
      expect(mockSupported).not.toHaveBeenCalled();
      // Both bound: nothing left to set up.
      expect(testId(el, "keybinds-portal-setup").style.display).toBe("none");
    });

    it("offers Change in system settings on portal v2 and calls configurePortal", async () => {
      mockStatus.mockResolvedValue(portal(bound, 2));
      const el = buildTab();
      const change = testId(el, "keybinds-portal-change") as HTMLButtonElement;
      await vi.waitFor(() => expect(change.style.display).toBe(""));
      expect(testId(el, "keybinds-portal-where").style.display).toBe("none");
      change.click();
      await vi.waitFor(() => expect(mockConfigurePortal).toHaveBeenCalledTimes(1));
    });

    it("says where to change the keys on portal v1 instead of a button", async () => {
      mockStatus.mockResolvedValue(portal(bound, 1));
      const el = buildTab();
      const where = testId(el, "keybinds-portal-where");
      await vi.waitFor(() => expect(where.style.display).toBe(""));
      expect(where.textContent).toContain("GNOME Settings > Keyboard > Shortcuts");
      expect(testId(el, "keybinds-portal-change").style.display).toBe("none");
    });

    it("offers only setup while the desktop holds no keys", async () => {
      mockStatus.mockResolvedValue(portal(unbound, 2));
      const el = buildTab();
      await vi.waitFor(() => expect(testId(el, "keybinds-portal-setup").style.display).toBe(""));
      expect(testId(el, "keybinds-portal-change").style.display).toBe("none");
      expect(testId(el, "keybinds-portal-where").style.display).toBe("none");
    });

    it("never shows the portal UI or asks the portal on a polling desktop", async () => {
      mockSupported.mockResolvedValue(true);
      const el = buildTab();
      const row = testId(el, "keybind-global-mute").closest("div[style]") as HTMLElement;
      await vi.waitFor(() => expect(row.style.display).toBe(""));
      expect(testId(el, "keybinds-portal").style.display).toBe("none");
      expect(testId(el, "ptt-portal-note").style.display).toBe("none");
      expect(kbdOf(el, "Toggle Mute")).toBe("Ctrl + Shift + M");
      expect(mockBindPortal).not.toHaveBeenCalled();
      expect(el.textContent).not.toContain("Waiting for your desktop");
    });

    it("lets a status event outrank the older first answer", async () => {
      let answer: (status: unknown) => void = () => {};
      mockStatus.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const el = buildTab();
      await vi.waitFor(() => expect(statusHandlers.size).toBe(1));
      for (const handler of statusHandlers) handler(portal(bound));
      expect(kbdOf(el, "Toggle Mute")).toBe("Ctrl+Alt+M");

      // The answer was computed before the event: it must not undo it.
      answer(pollingStatus);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(testId(el, "keybinds-portal").style.display).toBe("");
      expect(kbdOf(el, "Toggle Mute")).toBe("Ctrl+Alt+M");
      expect(mockSupported).not.toHaveBeenCalled();
    });

    it("keeps the unsupported note when no portal exists", async () => {
      mockStatus.mockResolvedValue({ ...pollingStatus, backend: "none" });
      mockSupported.mockResolvedValue(false);
      const el = buildTab();
      const hint = testId(el, "keybinds-global-hint");
      await vi.waitFor(() => expect(hint.textContent).toContain("no global shortcut service"));
      expect(testId(el, "keybinds-portal").style.display).toBe("none");
    });

    it("binds through the portal, saves the pref and shows the new triggers", async () => {
      mockStatus.mockResolvedValue(portal(unbound));
      mockBindPortal.mockResolvedValue(portal(bound));
      const el = buildTab();
      const setUp = testId(el, "keybinds-portal-setup") as HTMLButtonElement;
      await vi.waitFor(() => expect(setUp.style.display).toBe(""));
      expect(kbdOf(el, "Toggle Mute")).toBe("Ctrl + Shift + M");
      setUp.click();
      await vi.waitFor(() => expect(setUp.style.display).toBe("none"));
      expect(mockBindPortal).toHaveBeenCalledWith({ pttVk: 0, muteVk: 0x4d, deafenVk: 0x44 });
      expect(localStorage.getItem("owncord:settings:globalKeysPortalBound")).toBe("true");
      expect(kbdOf(el, "Toggle Mute")).toBe("Ctrl+Alt+M");
    });

    it("a bind resolving after unmount touches nothing and still saves the pref", async () => {
      mockStatus.mockResolvedValue(portal(unbound));
      let finish: (status: unknown) => void = () => {};
      mockBindPortal.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
      const controller = new AbortController();
      const el = buildKeybindsTab(controller.signal);
      const setUp = testId(el, "keybinds-portal-setup") as HTMLButtonElement;
      await vi.waitFor(() => expect(setUp.style.display).toBe(""));
      setUp.click();
      expect(setUp.disabled).toBe(true);
      controller.abort();
      const before = el.innerHTML;
      finish(portal(bound));
      await vi.waitFor(() =>
        expect(localStorage.getItem("owncord:settings:globalKeysPortalBound")).toBe("true"),
      );
      expect(el.innerHTML).toBe(before);
    });

    it("a cancelled bind leaves the set-up button and saves nothing", async () => {
      mockStatus.mockResolvedValue(portal(unbound));
      mockBindPortal.mockRejectedValue(portalErr("bind_cancelled"));
      const el = buildTab();
      const setUp = testId(el, "keybinds-portal-setup") as HTMLButtonElement;
      await vi.waitFor(() => expect(setUp.style.display).toBe(""));
      setUp.click();
      const note = testId(el, "keybinds-portal-note");
      await vi.waitFor(() => expect(note.textContent).toContain("cancelled"));
      expect(note.style.display).toBe("");
      expect(setUp.disabled).toBe(false);
      expect(setUp.style.display).toBe("");
      expect(localStorage.getItem("owncord:settings:globalKeysPortalBound")).toBeNull();
    });

    it("follows a status change while the tab is open and stops after it closes", async () => {
      mockStatus.mockResolvedValue(portal(unbound));
      const controller = new AbortController();
      const el = buildKeybindsTab(controller.signal);
      // The Push to Talk control and the global section share one subscription.
      await vi.waitFor(() => expect(statusHandlers.size).toBe(1));
      for (const handler of statusHandlers) handler(portal(bound));
      expect(kbdOf(el, "Toggle Mute")).toBe("Ctrl+Alt+M");
      controller.abort();
      expect(statusHandlers.size).toBe(0);
    });

    it("drops the portal controls when the portal goes away, and takes them back", async () => {
      mockStatus.mockResolvedValue(portal(bound));
      mockSupported.mockResolvedValue(false);
      mockPttSupported.mockResolvedValue(false);
      const el = buildTab();
      await vi.waitFor(() => expect(testId(el, "keybinds-portal").style.display).toBe(""));
      const ptt = el.querySelector(
        '[aria-label="Push to Talk keybind — click to capture"]',
      ) as HTMLButtonElement;
      expect(ptt.disabled).toBe(false);

      for (const handler of statusHandlers)
        handler({
          backend: "none",
          portalVersion: 0,
          triggers: unbound,
          canConfigure: false,
          triggersUnnamed: false,
          sessionRefused: false,
        });
      expect(testId(el, "keybinds-portal").style.display).toBe("none");
      expect(kbdOf(el, "Toggle Mute")).toBe("Ctrl + Shift + M");
      await vi.waitFor(() => expect(ptt.disabled).toBe(true));
      expect(testId(el, "keybinds-global-hint").style.display).toBe("");
      expect(el.textContent).toContain("Push to Talk needs a global key service");

      for (const handler of statusHandlers) handler(portal(bound));
      expect(testId(el, "keybinds-portal").style.display).toBe("");
      expect(ptt.disabled).toBe(false);
      expect(testId(el, "keybinds-portal").querySelectorAll(".keybind-section-header").length).toBe(
        1,
      );
    });

    describe("push to talk", () => {
      const pttButton = (el: HTMLElement): HTMLButtonElement =>
        el.querySelector('[aria-label="Push to Talk keybind — click to capture"]')!;

      it("accepts only function keys and binds through the portal", async () => {
        mockStatus.mockResolvedValue(portal(unbound));
        mockBindPortal.mockResolvedValue(portal({ ...bound, ptt: "F8" }));
        const el = buildTab();
        const btn = pttButton(el);
        await vi.waitFor(() => expect(testId(el, "keybinds-portal").style.display).toBe(""));
        // The slider stays usable and the unsupported note never shows.
        expect(el.textContent).not.toContain("Push to Talk needs a global key service");

        btn.click();
        expect(btn.textContent).toBe("Press a function key (F1-F24)...");
        capture(document, "Space");
        capture(document, "ControlLeft");
        expect(mockBindPortal).not.toHaveBeenCalled();
        capture(document, "F8");

        await vi.waitFor(() => expect(btn.textContent).toBe("F8"));
        expect(mockBindPortal).toHaveBeenCalledWith({ pttVk: 0x77, muteVk: 0x4d, deafenVk: 0x44 });
        expect(mockUpdatePttKey).toHaveBeenCalledWith(0x77);
        expect(localStorage.getItem("owncord:settings:globalKeysPortalBound")).toBe("true");
        expect(mockCaptureKeyPress).not.toHaveBeenCalled();
      });

      it("counts an unnamed portal as bound: arms push to talk and saves the pref", async () => {
        mockStatus.mockResolvedValue(portal(unbound));
        mockBindPortal.mockResolvedValue({ ...portal(unbound), triggersUnnamed: true });
        const el = buildTab();
        const btn = pttButton(el);
        await vi.waitFor(() => expect(testId(el, "keybinds-portal").style.display).toBe(""));
        btn.click();
        capture(document, "F8");
        await vi.waitFor(() => expect(mockUpdatePttKey).toHaveBeenCalledWith(0x77));
        expect(localStorage.getItem("owncord:settings:globalKeysPortalBound")).toBe("true");
        await vi.waitFor(() => expect(btn.textContent).toBe(mockVkName(0x77)));
        expect(btn.textContent).not.toBe("Not set");
      });

      it("reads 'Set in your desktop' on an unnamed portal until a key is picked", async () => {
        mockStatus.mockResolvedValue({ ...portal(unbound), triggersUnnamed: true });
        const el = buildTab();
        const btn = pttButton(el);
        await vi.waitFor(() => expect(btn.textContent).toBe("Set in your desktop"));
      });

      it("shows the portal trigger, not the VK name, once bound", async () => {
        localStorage.setItem("owncord:settings:pttVk", String(0x77));
        mockStatus.mockResolvedValue(portal({ ...bound, ptt: "F8" }));
        const el = buildTab();
        const btn = pttButton(el);
        await vi.waitFor(() => expect(btn.textContent).toBe("F8"));
      });

      it("a cancelled PTT bind keeps the key unset and says so", async () => {
        mockStatus.mockResolvedValue(portal(unbound));
        mockBindPortal.mockRejectedValue(portalErr("bind_cancelled"));
        const el = buildTab();
        const btn = pttButton(el);
        await vi.waitFor(() => expect(testId(el, "keybinds-portal").style.display).toBe(""));
        btn.click();
        capture(document, "F8");
        const note = testId(el, "ptt-portal-note");
        await vi.waitFor(() => expect(note.textContent).toContain("cancelled"));
        expect(btn.textContent).toBe("Not set");
        expect(mockUpdatePttKey).not.toHaveBeenCalled();
        expect(localStorage.getItem("owncord:settings:globalKeysPortalBound")).toBeNull();
      });

      it("a PTT bind resolving after the tab closes still arms push to talk and saves the pref", async () => {
        mockStatus.mockResolvedValue(portal(unbound));
        let finish: (status: unknown) => void = () => {};
        mockBindPortal.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
        const controller = new AbortController();
        const el = buildKeybindsTab(controller.signal);
        const btn = pttButton(el);
        await vi.waitFor(() => expect(testId(el, "keybinds-portal").style.display).toBe(""));
        btn.click();
        capture(document, "F8");
        controller.abort();
        finish(portal({ ...bound, ptt: "F8" }));
        await vi.waitFor(() => expect(mockUpdatePttKey).toHaveBeenCalledWith(0x77));
        expect(localStorage.getItem("owncord:settings:globalKeysPortalBound")).toBe("true");
        expect(btn.textContent).toBe("Waiting for your desktop...");
      });
    });
  });
});

describe("KeybindsTab rebindable rows (3E-3c-3)", () => {
  const portalStatus = {
    backend: "portal",
    portalVersion: 2,
    triggers: { ptt: null, mute: null, deafen: null },
    canConfigure: true,
    triggersUnnamed: false,
    sessionRefused: false,
  };

  beforeEach(() => {
    resetShortcutMocks();
    mockVkName.mockImplementation((vk: number) => {
      if (vk >= 0x41 && vk <= 0x5a) return String.fromCharCode(vk);
      if (vk >= 0x70 && vk <= 0x87) return `F${vk - 0x6f}`;
      return `Key-${vk}`;
    });
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  const press = (code: string, init: KeyboardEventInit = {}): void => {
    document.dispatchEvent(new KeyboardEvent("keydown", { code, bubbles: true, ...init }));
  };
  const byId = (el: HTMLElement, id: string): HTMLButtonElement =>
    el.querySelector(`[data-testid='${id}']`) as HTMLButtonElement;
  const mount = (): { el: HTMLDivElement; controller: AbortController } => {
    const controller = new AbortController();
    return { el: buildKeybindsTab(controller.signal), controller };
  };
  const stored = (): Record<string, unknown> =>
    (
      JSON.parse(localStorage.getItem("owncord:settings:keybinds") ?? "{}") as {
        bindings?: Record<string, unknown>;
      }
    ).bindings ?? {};

  it("makes camera, screen share, disconnect, search, upload, emoji and GIF capture buttons", () => {
    const { el } = mount();
    const shown: Record<string, string> = {
      toggleCamera: "Ctrl + Shift + V",
      toggleScreenshare: "Not set",
      disconnect: "Not set",
      search: "Ctrl + F",
      uploadFile: "Ctrl + Shift + U",
      emojiPicker: "Ctrl + E",
      gifPicker: "Ctrl + G",
    };
    for (const [id, text] of Object.entries(shown)) {
      const btn = byId(el, `keybind-${id}`);
      expect(btn.tagName, id).toBe("BUTTON");
      expect(btn.textContent, id).toBe(text);
      expect(byId(el, `keybind-${id}-reset`), id).not.toBeNull();
      expect(byId(el, `keybind-${id}-remove`), id).not.toBeNull();
    }
    // Mute and deafen stay display rows that follow the global binding.
    const mute = [...el.querySelectorAll(".keybind-row")].find(
      (r) => r.querySelector(".setting-label")?.textContent === "Toggle Mute",
    )!;
    expect(mute.querySelector("span.kbd")!.textContent).toBe("Ctrl + Shift + M");
    expect(mute.querySelector("button")).toBeNull();
  });

  it("does not list a rebindable action twice", () => {
    const { el } = mount();
    const labels = [...el.querySelectorAll(".keybind-row .setting-label")].map(
      (l) => l.textContent,
    );
    for (const label of [
      "Toggle Camera",
      "Toggle Screen Share",
      "Disconnect from Voice",
      "Search Messages",
      "Upload File",
      "Emoji Picker",
      "GIF Picker",
    ]) {
      expect(
        labels.filter((l) => l === label),
        label,
      ).toHaveLength(1);
    }
  });

  it("rebinds a row, saves it and shows it", () => {
    const { el } = mount();
    byId(el, "keybind-emojiPicker").click();
    press("KeyJ", { key: "j", ctrlKey: true });
    expect(byId(el, "keybind-emojiPicker").textContent).toBe("Ctrl + J");
    expect(stored().emojiPicker).toEqual({ vk: 0x4a, ctrl: true, shift: false, alt: false });
    // A fresh tab reads it back.
    expect(byId(mount().el, "keybind-emojiPicker").textContent).toBe("Ctrl + J");
  });

  it("shows why a combination was refused and keeps the old one", () => {
    const { el } = mount();
    byId(el, "keybind-search").click();
    press("KeyE", { key: "e", ctrlKey: true }); // the emoji picker's
    expect(byId(el, "keybind-search-alert").textContent).toBe("Already used by Emoji Picker.");
    expect(byId(el, "keybind-search").textContent).toBe("Ctrl + F");
    expect(stored().search).toBeUndefined();
  });

  it("resets one row to its default", () => {
    const { el } = mount();
    byId(el, "keybind-gifPicker").click();
    press("KeyJ", { key: "j", ctrlKey: true });
    byId(el, "keybind-gifPicker-reset").click();
    expect(byId(el, "keybind-gifPicker").textContent).toBe("Ctrl + G");
    expect(stored().gifPicker).toBeUndefined();
  });

  it("removes a binding", () => {
    const { el } = mount();
    byId(el, "keybind-uploadFile-remove").click();
    expect(byId(el, "keybind-uploadFile").textContent).toBe("Not set");
    expect(stored().uploadFile).toBeNull();
  });

  it("resets every rebindable row with Reset all keybinds", () => {
    const { el } = mount();
    byId(el, "keybind-search").click();
    press("KeyJ", { key: "j", ctrlKey: true });
    byId(el, "keybind-toggleScreenshare").click();
    press("F6", { key: "F6" });
    byId(el, "keybind-toggleCamera-remove").click();
    expect(byId(el, "keybind-toggleScreenshare").textContent).toBe("F6");

    expect(byId(el, "keybinds-reset-all").textContent).toBe("Reset all keybinds");
    byId(el, "keybinds-reset-all").click();
    expect(byId(el, "keybind-search").textContent).toBe("Ctrl + F");
    expect(byId(el, "keybind-toggleScreenshare").textContent).toBe("Not set");
    expect(byId(el, "keybind-toggleCamera").textContent).toBe("Ctrl + Shift + V");
    expect(stored()).toEqual({});
  });

  it("Reset all leaves no default that another binding now holds", () => {
    const { el } = mount();
    // Camera leaves V, then global mute takes V.
    byId(el, "keybind-toggleCamera").click();
    press("KeyX", { key: "X", ctrlKey: true, shiftKey: true });
    byId(el, "keybind-global-mute").click();
    press("KeyV");
    expect(byId(el, "keybind-global-mute").textContent).toBe("Ctrl + Shift + V");

    byId(el, "keybinds-reset-all").click();
    expect(byId(el, "keybind-toggleCamera").textContent).toBe("Not set");
    expect(byId(el, "keybind-toggleCamera-alert").textContent).toBe("Already used by Toggle Mute.");
    expect(stored().toggleCamera).toBeNull();
    // The other rows are back on their defaults.
    expect(byId(el, "keybind-uploadFile").textContent).toBe("Ctrl + Shift + U");
  });

  it("Reset all unbinds a default that the push-to-talk key now holds", () => {
    const { el } = mount();
    byId(el, "keybind-search").click();
    press("KeyJ", { key: "j", ctrlKey: true });
    localStorage.setItem("owncord:settings:pttVk", "70"); // F
    byId(el, "keybinds-reset-all").click();
    expect(byId(el, "keybind-search").textContent).toBe("Not set");
    expect(byId(el, "keybind-search-alert").textContent).toBe("That key is used by Push to Talk.");
    expect(stored().search).toBeNull();
  });

  it("Reset all judges each default against the other defaults, not their old overrides", () => {
    const { el } = mount();
    // Swap: search takes Ctrl+E after emoji moves away.
    byId(el, "keybind-emojiPicker").click();
    press("KeyJ", { key: "j", ctrlKey: true });
    byId(el, "keybind-search").click();
    press("KeyE", { key: "e", ctrlKey: true });
    byId(el, "keybinds-reset-all").click();
    expect(byId(el, "keybind-search").textContent).toBe("Ctrl + F");
    expect(byId(el, "keybind-emojiPicker").textContent).toBe("Ctrl + E");
  });

  it("names the combination in each button's accessible name", () => {
    const { el } = mount();
    expect(byId(el, "keybind-toggleCamera").getAttribute("aria-label")).toBe(
      "Toggle Camera: Ctrl + Shift + V",
    );
    expect(byId(el, "keybind-global-mute").getAttribute("aria-label")).toBe(
      "Global mute keybind: Ctrl + Shift + M",
    );
    byId(el, "keybind-search").click();
    expect(byId(el, "keybind-search").getAttribute("aria-label")).toBe(
      "Search Messages: Press a supported key...",
    );
    press("Escape", { key: "Escape" });
  });

  it("Reset all ends a capture in progress", () => {
    const { el } = mount();
    byId(el, "keybind-search").click();
    byId(el, "keybinds-reset-all").click();
    expect(byId(el, "keybind-search").textContent).toBe("Ctrl + F");
    press("KeyJ", { key: "j", ctrlKey: true });
    expect(stored()).toEqual({});
  });

  it("an in-app capture and the global capture never run together", () => {
    const { el } = mount();
    byId(el, "keybind-search").click();
    byId(el, "keybind-global-mute").click();
    expect(byId(el, "keybind-search").textContent).toBe("Ctrl + F");
    expect(byId(el, "keybind-global-mute").textContent).toBe("Press a supported key...");
    press("KeyG", { key: "g" });
    expect(byId(el, "keybind-global-mute").textContent).toBe("Ctrl + Shift + G");
    expect(stored()).toEqual({});
  });

  it("the global capture refuses a key an in-app Ctrl+Shift binding holds", () => {
    const { el } = mount();
    // Move the camera off V and onto X.
    byId(el, "keybind-toggleCamera").click();
    press("KeyX", { key: "X", ctrlKey: true, shiftKey: true });
    expect(byId(el, "keybind-toggleCamera").textContent).toBe("Ctrl + Shift + X");

    const conflict = el.querySelector<HTMLElement>("[role='alert'][style]")!;
    byId(el, "keybind-global-mute").click();
    press("KeyX");
    expect(conflict.style.display).toBe("");
    expect(byId(el, "keybind-global-mute").textContent).toBe("Ctrl + Shift + M");

    // V is free now.
    byId(el, "keybind-global-mute").click();
    press("KeyV");
    expect(byId(el, "keybind-global-mute").textContent).toBe("Ctrl + Shift + V");
  });

  it("the layout note is one plain sentence", () => {
    const { el } = mount();
    const note = byId(el, "keybinds-layout-note");
    expect(note.textContent).toBe(
      "On some keyboard layouts these keys can share a physical key with Mute or Deafen, and Mute and Deafen then win.",
    );
  });

  it("shows the desktop-priority note only on the portal backend", async () => {
    const polling = mount();
    await vi.waitFor(() => expect(mockSupported).toHaveBeenCalled());
    expect(byId(polling.el, "keybinds-portal-priority").hidden).toBe(true);

    mockStatus.mockResolvedValue(portalStatus);
    const { el } = mount();
    await vi.waitFor(() => expect(byId(el, "keybinds-portal-priority").hidden).toBe(false));
    expect(byId(el, "keybinds-portal-priority").textContent).toBe(
      "Your desktop's own shortcuts take priority over these keys.",
    );
    // The portal going away hides it again.
    for (const handler of statusHandlers) handler(pollingStatus);
    await vi.waitFor(() => expect(byId(el, "keybinds-portal-priority").hidden).toBe(true));
  });

  describe("push to talk against in-app keys", () => {
    const pttButton = (el: HTMLElement): HTMLButtonElement =>
      el.querySelector('[aria-label="Push to Talk keybind — click to capture"]')!;

    it("the portal capture rejects an F-key a bare in-app binding uses", async () => {
      mockStatus.mockResolvedValue(portalStatus);
      const { el } = mount();
      byId(el, "keybind-toggleScreenshare").click();
      press("F6", { key: "F6" });
      expect(byId(el, "keybind-toggleScreenshare").textContent).toBe("F6");

      await vi.waitFor(() => expect(byId(el, "keybinds-portal").style.display).toBe(""));
      pttButton(el).click();
      press("F6");
      const note = byId(el, "ptt-portal-note");
      expect(note.textContent).toBe("That key is already used by the Toggle Screen Share keybind.");
      expect(mockBindPortal).not.toHaveBeenCalled();
      expect(mockUpdatePttKey).not.toHaveBeenCalled();
      expect(pttButton(el).textContent).toBe("Not set");

      // A free F-key still binds.
      mockBindPortal.mockResolvedValue({
        ...portalStatus,
        triggers: { ptt: "F7", mute: null, deafen: null },
      });
      pttButton(el).click();
      press("F7");
      await vi.waitFor(() => expect(mockUpdatePttKey).toHaveBeenCalledWith(0x76));
    });

    it("starting a Keybinds row ends the portal push-to-talk capture", async () => {
      mockStatus.mockResolvedValue(portalStatus);
      const { el } = mount();
      await vi.waitFor(() => expect(byId(el, "keybinds-portal").style.display).toBe(""));
      pttButton(el).click();
      expect(pttButton(el).textContent).toBe("Press a function key (F1-F24)...");
      byId(el, "keybind-search").click();
      expect(pttButton(el).textContent).toBe("Not set");
      press("F7"); // only the Keybinds row is listening now
      expect(mockBindPortal).not.toHaveBeenCalled();
    });

    it("Clear during a portal capture lets the next capture start cleanly", async () => {
      mockStatus.mockResolvedValue(portalStatus);
      const { el } = mount();
      await vi.waitFor(() => expect(byId(el, "keybinds-portal").style.display).toBe(""));
      pttButton(el).click();
      const clear = [...el.querySelectorAll("button")].find((b) => b.textContent === "Clear")!;
      clear.click();
      pttButton(el).click();
      expect(pttButton(el).textContent).toBe("Press a function key (F1-F24)...");
      press("Escape");
      expect(pttButton(el).textContent).toBe("Not set");
    });

    it("the polling capture rejects a key an in-app binding uses", async () => {
      const { el } = mount();
      byId(el, "keybind-toggleScreenshare").click();
      press("F6", { key: "F6" });
      mockCaptureKeyPress.mockResolvedValue(0x75); // F6
      pttButton(el).click();
      await vi.waitFor(() =>
        expect(byId(el, "ptt-portal-note").textContent).toContain("Toggle Screen Share"),
      );
      expect(mockUpdatePttKey).not.toHaveBeenCalled();
      expect(pttButton(el).textContent).toBe("Not set");
    });

    it("an in-app rebind onto the push-to-talk key is refused", () => {
      localStorage.setItem("owncord:settings:pttVk", "117"); // F6
      const { el } = mount();
      byId(el, "keybind-toggleScreenshare").click();
      press("F6", { key: "F6" });
      expect(byId(el, "keybind-toggleScreenshare-alert").textContent).toBe(
        "That key is used by Push to Talk.",
      );
    });
  });
});
