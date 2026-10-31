import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildComboCapture } from "../../src/features/settings/comboCapture";
import { comboLabel } from "../../src/lib/prefs/keybindLabels";
import { loadEffectiveKeybinds, saveKeybind } from "../../src/lib/prefs/keybinds";

describe("buildComboCapture", () => {
  let controller: AbortController;
  let host: HTMLElement;

  beforeEach(() => {
    localStorage.clear();
    controller = new AbortController();
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    controller.abort();
    host.remove();
    localStorage.clear();
  });

  const mount = (
    action: Parameters<typeof buildComboCapture>[1]["action"],
    label: string,
    testId: string,
  ) => {
    const capture = buildComboCapture(controller.signal, { action, label, testId });
    host.appendChild(capture.element);
    const q = (suffix = ""): HTMLButtonElement =>
      host.querySelector<HTMLButtonElement>(`[data-testid='${testId}${suffix}']`)!;
    return { capture, button: q(), reset: q("-reset"), remove: q("-remove"), alert: q("-alert") };
  };

  /** A keydown on the document, as the capture listens there. */
  const press = (code: string, init: KeyboardEventInit = {}): KeyboardEvent => {
    const e = new KeyboardEvent("keydown", { code, bubbles: true, cancelable: true, ...init });
    document.dispatchEvent(e);
    return e;
  };
  const ctrlJ = { key: "j", ctrlKey: true };

  it("shows the default combination and offers neither Reset nor a clash", () => {
    const { button, reset, remove, alert } = mount("search", "Search Messages", "cap-search");
    expect(button.textContent).toBe("Ctrl + F");
    expect(reset.disabled).toBe(true); // already the default
    expect(remove.disabled).toBe(false);
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.hidden).toBe(true);
  });

  it("shows Not set for an action with no default", () => {
    const { button, remove } = mount("disconnect", "Disconnect from Voice", "cap-dc");
    expect(button.textContent).toBe("Not set");
    expect(remove.disabled).toBe(true);
  });

  it("waits through a modifier-only keydown, then captures the key with its modifiers", () => {
    const { button } = mount("search", "Search Messages", "cap-search");
    button.click();
    expect(button.textContent).toBe("Press a supported key...");
    press("ControlLeft", { key: "Control", ctrlKey: true });
    press("ShiftLeft", { key: "Shift", ctrlKey: true, shiftKey: true });
    press("AltLeft", { key: "Alt", ctrlKey: true, shiftKey: true });
    expect(button.textContent).toBe("Press a supported key...");
    expect(localStorage.getItem("owncord:settings:keybinds")).toBeNull();

    const e = press("KeyY", { key: "y", ctrlKey: true, shiftKey: true });
    expect(e.defaultPrevented).toBe(true);
    expect(button.textContent).toBe("Ctrl + Shift + Y");
    expect(loadEffectiveKeybinds().search).toEqual({
      vk: 0x59,
      ctrl: true,
      shift: true,
      alt: false,
    });
    // The capture is over: the next key is not taken.
    press("KeyK", { key: "k", ctrlKey: true });
    expect(button.textContent).toBe("Ctrl + Shift + Y");
  });

  it("captures a bare function key", () => {
    const { button } = mount("toggleScreenshare", "Toggle Screen Share", "cap-ss");
    button.click();
    press("F6", { key: "F6" });
    expect(button.textContent).toBe("F6");
    expect(loadEffectiveKeybinds().toggleScreenshare).toEqual({
      vk: 0x75,
      ctrl: false,
      shift: false,
      alt: false,
    });
  });

  it("cancels on Escape without leaving the Settings overlay", () => {
    const { button } = mount("search", "Search Messages", "cap-search");
    const reached = new AbortController();
    let bubbled = 0;
    window.addEventListener("keydown", () => bubbled++, { signal: reached.signal });
    button.click();
    const e = press("Escape", { key: "Escape" });
    reached.abort();
    expect(e.defaultPrevented).toBe(true);
    expect(bubbled).toBe(0); // propagation stopped
    expect(button.textContent).toBe("Ctrl + F");
    press("KeyJ", ctrlJ);
    expect(button.textContent).toBe("Ctrl + F"); // no longer listening
  });

  it("finishes on Tab and lets focus move on", () => {
    const { button } = mount("search", "Search Messages", "cap-search");
    button.click();
    const e = press("Tab", { key: "Tab" });
    expect(e.defaultPrevented).toBe(false);
    expect(button.textContent).toBe("Ctrl + F");
    press("KeyJ", ctrlJ);
    expect(localStorage.getItem("owncord:settings:keybinds")).toBeNull();
  });

  it("refuses a combination with Meta", () => {
    const { button, alert } = mount("search", "Search Messages", "cap-search");
    button.click();
    press("MetaLeft", { key: "Meta", metaKey: true }); // the Meta key alone just waits
    expect(alert.hidden).toBe(true);
    press("KeyJ", { key: "j", metaKey: true });
    expect(alert.hidden).toBe(false);
    expect(alert.textContent).toBe("Your system or text editing keeps that combination.");
    expect(button.textContent).toBe("Ctrl + F");
    expect(localStorage.getItem("owncord:settings:keybinds")).toBeNull();
  });

  it("refuses Ctrl+Alt, which Windows reports for AltGr", () => {
    const { button, alert } = mount("search", "Search Messages", "cap-search");
    button.click();
    press("KeyJ", { key: "j", ctrlKey: true, altKey: true });
    expect(alert.textContent).toBe("Your system or text editing keeps that combination.");
    expect(localStorage.getItem("owncord:settings:keybinds")).toBeNull();
  });

  describe("conflict alert text", () => {
    const attempt = (
      action: Parameters<typeof buildComboCapture>[1]["action"],
      code: string,
      init: KeyboardEventInit,
    ): { alert: HTMLElement; button: HTMLElement } => {
      const { button, alert } = mount(action, "Row", `cap-${action}`);
      button.click();
      press(code, init);
      return { alert, button };
    };

    it("names the action that already holds the combination", () => {
      const { alert, button } = attempt("search", "KeyV", {
        key: "V",
        ctrlKey: true,
        shiftKey: true,
      });
      expect(alert.hidden).toBe(false);
      expect(alert.textContent).toBe("Already used by Toggle Camera.");
      expect(button.textContent).toBe("Ctrl + F"); // unchanged
    });

    it("names Toggle Mute for the Ctrl+Shift+key a mute binding owns", () => {
      const { alert } = attempt("search", "KeyM", { key: "M", ctrlKey: true, shiftKey: true });
      expect(alert.textContent).toBe("Already used by Toggle Mute.");
    });

    it("says a bare letter needs Ctrl or Alt", () => {
      const { alert } = attempt("search", "KeyJ", { key: "j" });
      expect(alert.textContent).toBe(
        "Hold Ctrl or Alt with the key, or use a function key on its own.",
      );
    });

    it("says a system key is reserved", () => {
      const { alert } = attempt("search", "KeyR", { key: "r", ctrlKey: true });
      expect(alert.textContent).toBe("Your system or text editing keeps that combination.");
    });

    it("says an app key is fixed", () => {
      const { alert } = attempt("search", "KeyK", { key: "k", ctrlKey: true });
      expect(alert.textContent).toBe("That combination is a fixed shortcut in OwnCord.");
    });

    it("says the push-to-talk key is taken", () => {
      localStorage.setItem("owncord:settings:pttVk", "117"); // F6
      const { alert } = attempt("search", "F6", { key: "F6" });
      expect(alert.textContent).toBe("That key is used by Push to Talk.");
    });

    it("clears the alert when the next capture starts", () => {
      const { button, alert } = mount("search", "Search Messages", "cap-search");
      button.click();
      press("KeyK", { key: "k", ctrlKey: true });
      expect(alert.hidden).toBe(false);
      button.click();
      expect(alert.hidden).toBe(true);
    });
  });

  it("Reset restores the default and is disabled once there", () => {
    const { button, reset } = mount("search", "Search Messages", "cap-search");
    button.click();
    press("KeyJ", ctrlJ);
    expect(button.textContent).toBe("Ctrl + J");
    expect(reset.disabled).toBe(false);
    reset.click();
    expect(button.textContent).toBe("Ctrl + F");
    expect(reset.disabled).toBe(true);
    expect(loadEffectiveKeybinds().search).toEqual({
      vk: 0x46,
      ctrl: true,
      shift: false,
      alt: false,
    });
  });

  it("Reset is refused, with the clashing action named, when another binding took the default", () => {
    const upload = mount("uploadFile", "Upload File", "cap-upload");
    const emoji = mount("emojiPicker", "Emoji Picker", "cap-emoji");
    upload.button.click();
    press("KeyJ", ctrlJ); // upload leaves Ctrl+Shift+U
    emoji.button.click();
    press("KeyU", { key: "U", ctrlKey: true, shiftKey: true }); // emoji takes it
    expect(emoji.button.textContent).toBe("Ctrl + Shift + U");
    upload.reset.click();
    expect(upload.alert.hidden).toBe(false);
    expect(upload.alert.textContent).toBe("Already used by Emoji Picker.");
    expect(upload.button.textContent).toBe("Ctrl + J");
  });

  it("Remove unbinds the action and Reset brings the default back", () => {
    const { button, reset, remove } = mount("search", "Search Messages", "cap-search");
    remove.click();
    expect(button.textContent).toBe("Not set");
    expect(remove.disabled).toBe(true);
    expect(reset.disabled).toBe(false);
    expect(loadEffectiveKeybinds().search).toBeNull();
    expect(
      JSON.parse(localStorage.getItem("owncord:settings:keybinds")!).bindings.search,
    ).toBeNull();
    reset.click();
    expect(button.textContent).toBe("Ctrl + F");
  });

  it("Reset and Remove end a capture in progress on their row", () => {
    const { button, reset, remove } = mount("search", "Search Messages", "cap-search");
    button.click();
    reset.disabled = false;
    reset.click();
    expect(button.classList.contains("capturing")).toBe(false);
    press("KeyJ", ctrlJ);
    expect(button.textContent).toBe("Ctrl + F"); // no longer listening

    button.click();
    remove.click();
    expect(button.classList.contains("capturing")).toBe(false);
    press("KeyJ", ctrlJ);
    expect(button.textContent).toBe("Not set");
    expect(loadEffectiveKeybinds().search).toBeNull();
  });

  it("starting a second capture cancels the first", () => {
    const a = mount("search", "Search Messages", "cap-a");
    const b = mount("gifPicker", "GIF Picker", "cap-b");
    a.button.click();
    b.button.click();
    expect(a.button.textContent).toBe("Ctrl + F");
    expect(b.button.textContent).toBe("Press a supported key...");
    press("KeyJ", ctrlJ);
    expect(b.button.textContent).toBe("Ctrl + J");
    expect(a.button.textContent).toBe("Ctrl + F");
  });

  it("refresh redraws from the saved bindings and clears the alert", () => {
    const { capture, button, alert } = mount("search", "Search Messages", "cap-search");
    button.click();
    press("KeyK", { key: "k", ctrlKey: true });
    expect(alert.hidden).toBe(false);
    saveKeybind("search", { vk: 0x4a, ctrl: true, shift: false, alt: false });
    capture.refresh();
    expect(button.textContent).toBe("Ctrl + J");
    expect(alert.hidden).toBe(true);
  });

  it("labels modifiers in a fixed order", () => {
    expect(comboLabel({ vk: 0x70, ctrl: true, shift: true, alt: true })).toBe(
      "Ctrl + Shift + Alt + F1",
    );
  });
});
