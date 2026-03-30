import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCaptureKeyPress = vi.fn();
const mockUpdatePttKey = vi.fn();
const mockVkName = vi.fn((vk: number) => `Key-${vk}`);

vi.mock("@lib/ptt", () => ({
  captureKeyPress: (...args: unknown[]) => mockCaptureKeyPress(...args),
  updatePttKey: (...args: unknown[]) => mockUpdatePttKey(...args),
  vkName: (vk: number) => mockVkName(vk),
}));

import { buildKeybindsTab } from "../../src/components/settings/KeybindsTab";

describe("KeybindsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockCaptureKeyPress.mockReset();
    mockUpdatePttKey.mockReset();
    mockVkName.mockImplementation((vk: number) => `Key-${vk}`);
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("returns a div with settings-pane class", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    expect(el.tagName).toBe("DIV");
    expect(el.className).toBe("settings-pane active");
  });

  it("renders section headers instead of h1", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const headers = el.querySelectorAll(".keybind-section-header");
    expect(headers.length).toBe(3);
    const headerTexts = Array.from(headers).map((h) => h.textContent);
    expect(headerTexts).toEqual(["Navigation", "Communication", "Messages"]);
  });

  it("renders Push to Talk keybind row", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const rows = el.querySelectorAll(".keybind-row");
    // 1 PTT + 3 Navigation + 3 Communication + 2 Messages = 9
    expect(rows.length).toBe(9);
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

  it("shows 'Press any key...' when capture button is clicked", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    mockCaptureKeyPress.mockReturnValue(new Promise(() => {})); // never resolves
    const pttBtn = el.querySelectorAll(".keybind-row")[0]!.querySelector(".kbd") as HTMLButtonElement;

    pttBtn.click();

    expect(pttBtn.textContent).toBe("Press any key...");
    expect(pttBtn.style.borderColor).toBe("var(--accent)");
    expect(pttBtn.style.color).toBe("var(--accent)");
  });

  it("sets PTT key when captureKeyPress resolves with a VK code", async () => {
    const el = buildKeybindsTab(new AbortController().signal);
    mockCaptureKeyPress.mockResolvedValue(0x05); // Mouse 5
    mockVkName.mockReturnValue("Mouse 5");
    const pttBtn = el.querySelectorAll(".keybind-row")[0]!.querySelector(".kbd") as HTMLButtonElement;

    pttBtn.click();

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("Mouse 5");
    });
    expect(mockUpdatePttKey).toHaveBeenCalledWith(0x05);
    expect(pttBtn.style.borderColor).toBe("");
    expect(pttBtn.style.color).toBe("");
  });

  it("restores previous value when captureKeyPress times out (returns 0)", async () => {
    const el = buildKeybindsTab(new AbortController().signal);
    mockCaptureKeyPress.mockResolvedValue(0);
    const pttBtn = el.querySelectorAll(".keybind-row")[0]!.querySelector(".kbd") as HTMLButtonElement;

    pttBtn.click();

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("Not set");
    });
    expect(mockUpdatePttKey).not.toHaveBeenCalled();
  });

  it("restores previous value on captureKeyPress failure (fallback path)", async () => {
    const el = buildKeybindsTab(new AbortController().signal);
    mockCaptureKeyPress.mockRejectedValue(new Error("No Tauri"));
    const pttBtn = el.querySelectorAll(".keybind-row")[0]!.querySelector(".kbd") as HTMLButtonElement;

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
    const pttBtn = el.querySelectorAll(".keybind-row")[0]!.querySelector(".kbd") as HTMLButtonElement;

    pttBtn.click();
    expect(pttBtn.textContent).toBe("Press any key...");

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
    expect(separators.length).toBe(3);
  });

  // --- PTT hint text ---

  it("renders PTT hint text", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const hint = el.querySelector("div[style*='font-size: 11px']");
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toContain("PTT works globally");
  });

  // --- All keybinds present ---

  it("renders Mark as Read, Search Messages, Upload File, Edit Last Message keybinds", () => {
    const el = buildKeybindsTab(new AbortController().signal);
    const labels = Array.from(el.querySelectorAll(".setting-label")).map((l) => l.textContent);
    expect(labels).toContain("Mark as Read");
    expect(labels).toContain("Search Messages");
    expect(labels).toContain("Upload File");
    expect(labels).toContain("Edit Last Message");
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
    const pttBtn = el.querySelectorAll(".keybind-row")[0]!.querySelector(".kbd") as HTMLButtonElement;

    expect(pttBtn.textContent).toBe("F2");

    pttBtn.click();
    expect(pttBtn.textContent).toBe("Press any key...");

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
    const pttBtn = el.querySelectorAll(".keybind-row")[0]!.querySelector(".kbd") as HTMLButtonElement;

    expect(pttBtn.textContent).toBe("F2");

    pttBtn.click();

    await vi.waitFor(() => {
      expect(pttBtn.textContent).toBe("F2");
    });
  });
});
