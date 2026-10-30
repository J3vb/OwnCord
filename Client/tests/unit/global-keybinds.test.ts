import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished, type Mock } from "vitest";

const { mockVoiceGetState } = vi.hoisted(() => ({
  mockVoiceGetState: vi.fn(() => ({ currentChannelId: null as number | null })),
}));

vi.mock("@lib/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("@stores/voice.store", () => ({
  voiceStore: { getState: mockVoiceGetState },
}));

const { attachGlobalKeybinds } = await import("../../src/pages/main-page/GlobalKeybinds");
const { saveGlobalShortcutVk } = await import("../../src/lib/voice/voiceShortcuts");
const { parseKeybinds, saveKeybind } = await import("../../src/lib/prefs/keybinds");

function makeHandlers(): {
  onSearch: Mock<() => void>;
  onOpenSettings: Mock<() => void>;
  onOpenShortcuts: Mock<() => void>;
  onToggleMute: Mock<() => void>;
  onToggleDeafen: Mock<() => void>;
  onToggleCamera: Mock<() => void>;
  onUploadFile: Mock<() => void>;
  onStepChannel: Mock<(direction: 1 | -1, unreadOnly: boolean) => void>;
  onTogglePicker: Mock<(kind: "emoji" | "gif") => void>;
  onMarkChannelRead: Mock<() => void>;
  onMarkServerRead: Mock<() => void>;
  onScrollMessages: Mock<(direction: 1 | -1) => void>;
} {
  return {
    onSearch: vi.fn<() => void>(),
    onOpenSettings: vi.fn<() => void>(),
    onOpenShortcuts: vi.fn<() => void>(),
    onToggleMute: vi.fn<() => void>(),
    onToggleDeafen: vi.fn<() => void>(),
    onToggleCamera: vi.fn<() => void>(),
    onUploadFile: vi.fn<() => void>(),
    onStepChannel: vi.fn<(direction: 1 | -1, unreadOnly: boolean) => void>(),
    onTogglePicker: vi.fn<(kind: "emoji" | "gif") => void>(),
    onMarkChannelRead: vi.fn<() => void>(),
    onMarkServerRead: vi.fn<() => void>(),
    onScrollMessages: vi.fn<(direction: 1 | -1) => void>(),
  };
}

/** The `code` a real keydown carries for a letter or digit. */
function codeFor(key: string): string {
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return "";
}

function press(key: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: codeFor(key),
    ctrlKey: true,
    cancelable: true,
    ...opts,
  });
  document.dispatchEvent(event);
  return event;
}

describe("global keybinds", () => {
  let detach: (() => void) | null = null;

  beforeEach(() => {
    mockVoiceGetState.mockReturnValue({ currentChannelId: null });
  });

  afterEach(() => {
    detach?.();
    detach = null;
  });

  it("Ctrl+F opens search and swallows the browser default", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    const event = press("f");

    expect(h.onSearch).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("Ctrl+Shift+U opens the file picker; Ctrl+U alone does not", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    const plain = press("u", { code: "KeyU" });
    expect(h.onUploadFile).not.toHaveBeenCalled();
    expect(plain.defaultPrevented).toBe(false);

    const upload = press("U", { shiftKey: true, code: "KeyU" });
    expect(h.onUploadFile).toHaveBeenCalledOnce();
    expect(upload.defaultPrevented).toBe(true);
  });

  describe("from the thread panel's composer", () => {
    function panelComposer(): HTMLTextAreaElement {
      const panel = document.createElement("div");
      panel.className = "thread-panel";
      const box = document.createElement("textarea");
      box.className = "msg-textarea";
      panel.appendChild(box);
      document.body.appendChild(panel);
      onTestFinished(() => panel.remove());
      return box;
    }
    function keyFrom(
      target: HTMLElement,
      key: string,
      opts: KeyboardEventInit = {},
    ): KeyboardEvent {
      const event = new KeyboardEvent("keydown", {
        key,
        code: codeFor(key),
        bubbles: true,
        cancelable: true,
        ...opts,
      });
      target.dispatchEvent(event);
      return event;
    }

    it("leaves Ctrl+Shift+U to itself, where the channel's composer would take it", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);
      keyFrom(panelComposer(), "U", { ctrlKey: true, shiftKey: true, code: "KeyU" });
      expect(h.onUploadFile).not.toHaveBeenCalled();
    });

    it("does not mark the parent channel read on Escape or scroll it on Page Down", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);
      const box = panelComposer();
      keyFrom(box, "Escape");
      keyFrom(box, "PageDown");
      expect(h.onMarkChannelRead).not.toHaveBeenCalled();
      expect(h.onScrollMessages).not.toHaveBeenCalled();
    });

    it("still does both from the channel's own composer", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);
      const own = document.createElement("textarea");
      own.className = "msg-textarea";
      document.body.appendChild(own);
      onTestFinished(() => own.remove());
      keyFrom(own, "Escape");
      keyFrom(own, "PageDown");
      expect(h.onMarkChannelRead).toHaveBeenCalledOnce();
      expect(h.onScrollMessages).toHaveBeenCalledWith(1);
    });
  });

  it("a mute already bound to U keeps Ctrl+Shift+U", () => {
    saveGlobalShortcutVk("mute", 0x55);
    onTestFinished(() => {
      saveGlobalShortcutVk("mute", 0x4d);
    });
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    press("U", { shiftKey: true, code: "KeyU" });

    expect(h.onToggleMute).toHaveBeenCalledOnce();
    expect(h.onUploadFile).not.toHaveBeenCalled();
  });

  it("does not fire while a dialog/modal owns focus (#17)", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    // A modal (Create Channel, report dialog, confirm) is open. Ctrl+F must
    // not fire behind it and swallow the key from the field.
    const dialog = document.createElement("div");
    dialog.className = "modal-overlay visible";
    document.body.appendChild(dialog);

    press("f");
    expect(h.onSearch).not.toHaveBeenCalled();

    dialog.remove();
  });

  it("still fires while a hidden aria-modal panel stays mounted (the closed Settings overlay)", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    const overlay = document.createElement("div");
    overlay.style.display = "none";
    const panel = document.createElement("div");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    press("f");
    expect(h.onSearch).toHaveBeenCalledOnce();

    overlay.remove();
  });

  it("fires from the focused message composer", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "f", code: "KeyF", ctrlKey: true, bubbles: true }),
    );

    expect(h.onSearch).toHaveBeenCalledOnce();

    composer.remove();
  });

  // WP 1D-1: mute and deafen work outside a call (they set the state the next
  // join starts with); the camera still needs a call.
  it("toggles mute and deafen outside a voice channel, but not the camera", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    const mute = press("m");
    const deafen = press("d");
    const camera = press("V", { shiftKey: true });

    expect(h.onToggleMute).toHaveBeenCalledOnce();
    expect(h.onToggleDeafen).toHaveBeenCalledOnce();
    expect(h.onToggleCamera).not.toHaveBeenCalled();
    expect(mute.defaultPrevented).toBe(true);
    expect(deafen.defaultPrevented).toBe(true);
    // An untouched key keeps its default behaviour.
    expect(camera.defaultPrevented).toBe(false);
  });

  it("leaves Ctrl+M and Ctrl+D to a text field", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);
    const composer = document.createElement("textarea");
    document.body.appendChild(composer);
    composer.focus();

    const d = new KeyboardEvent("keydown", {
      key: "d",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    composer.dispatchEvent(d);
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "m", ctrlKey: true, bubbles: true, cancelable: true }),
    );

    expect(h.onToggleMute).not.toHaveBeenCalled();
    expect(h.onToggleDeafen).not.toHaveBeenCalled();
    expect(d.defaultPrevented).toBe(false);
    composer.remove();
  });

  it("fires voice shortcuts while connected to voice", () => {
    mockVoiceGetState.mockReturnValue({ currentChannelId: 7 });
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    press("m");
    press("d");
    // Shift uppercases the key — the handler must not miss it.
    press("V", { shiftKey: true });

    expect(h.onToggleMute).toHaveBeenCalledOnce();
    expect(h.onToggleDeafen).toHaveBeenCalledOnce();
    expect(h.onToggleCamera).toHaveBeenCalledOnce();
  });

  describe("rebindable actions", () => {
    const GLOBALS = { mute: 0x4d, deafen: 0x44 };
    const F9 = 0x78;
    const X = 0x58;

    function bindings(
      overrides: Record<string, { vk: number; ctrl: boolean; shift: boolean; alt: boolean } | null>,
    ): ReturnType<typeof parseKeybinds> {
      return parseKeybinds({ v: 1, bindings: overrides }, GLOBALS, 0);
    }

    function attachWith(
      h: ReturnType<typeof makeHandlers>,
      keybinds: () => ReturnType<typeof parseKeybinds>,
    ): {
      onToggleScreenshare: Mock<() => void>;
      onDisconnect: Mock<() => void>;
    } {
      const extra = {
        onToggleScreenshare: vi.fn<() => void>(),
        onDisconnect: vi.fn<() => void>(),
      };
      detach = attachGlobalKeybinds({
        ...h,
        ...extra,
        keybinds,
        voiceShortcutKeys: () => GLOBALS,
        isGlobalPollerActive: () => false,
      });
      return extra;
    }

    beforeEach(() => {
      mockVoiceGetState.mockReturnValue({ currentChannelId: 7 });
      localStorage.clear();
    });

    afterEach(() => {
      localStorage.clear();
    });

    it("a rebound camera fires on its new key and no longer on Ctrl+Shift+V", () => {
      const h = makeHandlers();
      attachWith(h, () =>
        bindings({ toggleCamera: { vk: X, ctrl: true, shift: true, alt: false } }),
      );

      const old = press("V", { shiftKey: true, code: "KeyV" });
      expect(h.onToggleCamera).not.toHaveBeenCalled();
      expect(old.defaultPrevented).toBe(false);

      const moved = press("X", { shiftKey: true, code: "KeyX" });
      expect(h.onToggleCamera).toHaveBeenCalledOnce();
      expect(moved.defaultPrevented).toBe(true);
    });

    it("an unbound default does nothing and leaves the key alone", () => {
      const h = makeHandlers();
      attachWith(h, () => bindings({ search: null }));

      const event = press("f", { code: "KeyF" });

      expect(h.onSearch).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it("a bare F-key screen share fires in a call", () => {
      const h = makeHandlers();
      const extra = attachWith(h, () =>
        bindings({ toggleScreenshare: { vk: F9, ctrl: false, shift: false, alt: false } }),
      );

      const event = press("F9", { ctrlKey: false, code: "F9" });

      expect(extra.onToggleScreenshare).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
    });

    it("an Alt+key disconnect fires only in voice and leaves the key alone outside it", () => {
      const h = makeHandlers();
      const extra = attachWith(h, () =>
        bindings({ disconnect: { vk: 0x58, ctrl: false, shift: false, alt: true } }),
      );

      mockVoiceGetState.mockReturnValue({ currentChannelId: null });
      const outside = press("x", { ctrlKey: false, altKey: true, code: "KeyX" });
      expect(extra.onDisconnect).not.toHaveBeenCalled();
      expect(outside.defaultPrevented).toBe(false);

      mockVoiceGetState.mockReturnValue({ currentChannelId: 7 });
      const inside = press("x", { ctrlKey: false, altKey: true, code: "KeyX" });
      expect(extra.onDisconnect).toHaveBeenCalledOnce();
      expect(inside.defaultPrevented).toBe(true);
    });

    it("voice-only actions do nothing outside a call, camera included", () => {
      const h = makeHandlers();
      const extra = attachWith(h, () =>
        bindings({ toggleScreenshare: { vk: F9, ctrl: false, shift: false, alt: false } }),
      );
      mockVoiceGetState.mockReturnValue({ currentChannelId: null });

      const cam = press("V", { shiftKey: true, code: "KeyV" });
      const share = press("F9", { ctrlKey: false, code: "F9" });

      expect(h.onToggleCamera).not.toHaveBeenCalled();
      expect(extra.onToggleScreenshare).not.toHaveBeenCalled();
      expect(cam.defaultPrevented).toBe(false);
      expect(share.defaultPrevented).toBe(false);
    });

    it("swallows an auto-repeating press without toggling", () => {
      const h = makeHandlers();
      attachWith(h, () => bindings({}));

      press("V", { shiftKey: true, code: "KeyV" });
      const repeat = press("V", { shiftKey: true, code: "KeyV", repeat: true });

      expect(h.onToggleCamera).toHaveBeenCalledOnce();
      expect(repeat.defaultPrevented).toBe(true);
    });

    it("mute wins when a camera binding shares its Ctrl+Shift key", () => {
      const h = makeHandlers();
      attachWith(h, () =>
        bindings({ toggleCamera: { vk: GLOBALS.mute, ctrl: true, shift: true, alt: false } }),
      );

      press("M", { shiftKey: true, code: "KeyM" });

      expect(h.onToggleMute).toHaveBeenCalledOnce();
      expect(h.onToggleCamera).not.toHaveBeenCalled();
    });

    it("keeps the mute stand-down while the poller is active, ahead of the table", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds({
        ...h,
        keybinds: () =>
          bindings({ toggleCamera: { vk: GLOBALS.mute, ctrl: true, shift: true, alt: false } }),
        voiceShortcutKeys: () => GLOBALS,
        isGlobalPollerActive: () => true,
      });

      const event = press("M", { shiftKey: true, code: "KeyM" });

      expect(h.onToggleMute).not.toHaveBeenCalled();
      expect(h.onToggleCamera).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(true);
    });

    it("ignores a key pressed during an IME composition", () => {
      const h = makeHandlers();
      attachWith(h, () => bindings({}));

      const event = press("f", { code: "KeyF", isComposing: true });

      expect(h.onSearch).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it("does not let Meta stand in for Ctrl", () => {
      const h = makeHandlers();
      attachWith(h, () => bindings({}));

      const event = press("f", { ctrlKey: false, metaKey: true, code: "KeyF" });

      expect(h.onSearch).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it("does not fire behind a dialog", () => {
      const h = makeHandlers();
      attachWith(h, () => bindings({}));
      const dialog = document.createElement("div");
      dialog.className = "modal-overlay visible";
      document.body.appendChild(dialog);
      onTestFinished(() => dialog.remove());

      press("f", { code: "KeyF" });

      expect(h.onSearch).not.toHaveBeenCalled();
    });

    it("still gives the pickers the text-field rule", () => {
      const h = makeHandlers();
      attachWith(h, () => bindings({}));
      const field = document.createElement("input");
      document.body.appendChild(field);
      onTestFinished(() => field.remove());

      field.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "e",
          code: "KeyE",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );

      expect(h.onTogglePicker).not.toHaveBeenCalled();
    });

    it("reads the persisted bindings and drops its cache on a keybinds pref change", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      press("V", { shiftKey: true, code: "KeyV" });
      expect(h.onToggleCamera).toHaveBeenCalledOnce();

      // saveKeybind dispatches owncord:pref-change for "keybinds".
      saveKeybind("toggleCamera", { vk: X, ctrl: true, shift: true, alt: false });

      press("V", { shiftKey: true, code: "KeyV" });
      expect(h.onToggleCamera).toHaveBeenCalledOnce();
      press("X", { shiftKey: true, code: "KeyX" });
      expect(h.onToggleCamera).toHaveBeenCalledTimes(2);
    });

    it("drops its cache when the mute key changes", () => {
      saveGlobalShortcutVk("mute", X);
      // Camera on mute's key conflicts, so it reverts to Ctrl+Shift+V.
      saveKeybind("toggleCamera", { vk: X, ctrl: true, shift: true, alt: false });
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);
      press("V", { shiftKey: true, code: "KeyV" });
      expect(h.onToggleCamera).toHaveBeenCalledOnce();

      saveGlobalShortcutVk("mute", 0x4d);

      press("X", { shiftKey: true, code: "KeyX" });
      expect(h.onToggleCamera).toHaveBeenCalledTimes(2);
    });

    it("stops listening for pref changes once detached", () => {
      const h = makeHandlers();
      const add = vi.spyOn(window, "addEventListener");
      onTestFinished(() => add.mockRestore());
      detach = attachGlobalKeybinds(h);
      const call = add.mock.calls.find(([type]) => type === "owncord:pref-change");
      const opts = call?.[2] as AddEventListenerOptions | undefined;

      expect(opts?.signal).toBeInstanceOf(AbortSignal);
      detach();
      detach = null;
      expect(opts?.signal?.aborted).toBe(true);
    });
  });

  describe("mute/deafen on the global shortcut binding", () => {
    beforeEach(() => {
      mockVoiceGetState.mockReturnValue({ currentChannelId: 7 });
      localStorage.clear();
    });

    afterEach(() => {
      localStorage.clear();
    });

    it("Ctrl+Shift+M mutes and Ctrl+Shift+D deafens, once each", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const mute = press("M", { shiftKey: true, code: "KeyM" });
      const deafen = press("D", { shiftKey: true, code: "KeyD" });

      expect(h.onToggleMute).toHaveBeenCalledOnce();
      expect(h.onToggleDeafen).toHaveBeenCalledOnce();
      expect(mute.defaultPrevented).toBe(true);
      expect(deafen.defaultPrevented).toBe(true);
    });

    it("keeps Ctrl+M and Ctrl+D as aliases that toggle once each", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      press("m", { code: "KeyM" });
      press("d", { code: "KeyD" });

      expect(h.onToggleMute).toHaveBeenCalledOnce();
      expect(h.onToggleDeafen).toHaveBeenCalledOnce();
    });

    it("a held Ctrl+M or Ctrl+D alias toggles once (auto-repeat is ignored)", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      press("m", { code: "KeyM" });
      const muteRepeat = press("m", { code: "KeyM", repeat: true });
      press("m", { code: "KeyM", repeat: true });
      press("d", { code: "KeyD" });
      const deafenRepeat = press("d", { code: "KeyD", repeat: true });

      expect(h.onToggleMute).toHaveBeenCalledOnce();
      expect(h.onToggleDeafen).toHaveBeenCalledOnce();
      expect(muteRepeat.defaultPrevented).toBe(true);
      expect(deafenRepeat.defaultPrevented).toBe(true);
    });

    it("stands down while the global poller is active, still swallowing the key", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds({ ...h, isGlobalPollerActive: () => true });

      const mute = press("M", { shiftKey: true, code: "KeyM" });
      const deafen = press("D", { shiftKey: true, code: "KeyD" });

      expect(h.onToggleMute).not.toHaveBeenCalled();
      expect(h.onToggleDeafen).not.toHaveBeenCalled();
      expect(mute.defaultPrevented).toBe(true);
      expect(deafen.defaultPrevented).toBe(true);
    });

    it("leaves a Super+Shift combo to the OS while the poller is active", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds({ ...h, isGlobalPollerActive: () => true });

      const meta = press("M", { ctrlKey: false, metaKey: true, shiftKey: true, code: "KeyM" });

      expect(h.onToggleMute).not.toHaveBeenCalled();
      expect(meta.defaultPrevented).toBe(false);
    });

    it("toggles once while the combo is held (auto-repeat is ignored)", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds({ ...h, isGlobalPollerActive: () => false });

      press("M", { shiftKey: true, code: "KeyM" });
      const repeat = press("M", { shiftKey: true, code: "KeyM", repeat: true });

      expect(h.onToggleMute).toHaveBeenCalledOnce();
      expect(repeat.defaultPrevented).toBe(true);
    });

    it("toggles in-app when the poller reports unsupported (macOS, Wayland)", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds({ ...h, isGlobalPollerActive: () => false });

      press("M", { shiftKey: true, code: "KeyM" });

      expect(h.onToggleMute).toHaveBeenCalledOnce();
    });

    it("follows a rebind persisted in Settings", () => {
      saveGlobalShortcutVk("mute", 0x4b); // K
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const old = press("M", { shiftKey: true, code: "KeyM" });
      press("K", { shiftKey: true, code: "KeyK" });

      expect(h.onToggleMute).toHaveBeenCalledOnce();
      expect(old.defaultPrevented).toBe(false);
    });

    it("reads the binding from the voiceShortcutKeys handler on every press", () => {
      let keys = { mute: 0x4d, deafen: 0x44 };
      const h = makeHandlers();
      detach = attachGlobalKeybinds({ ...h, voiceShortcutKeys: () => keys });

      press("M", { shiftKey: true, code: "KeyM" });
      keys = { mute: 0x70, deafen: 0x44 }; // F1
      press("M", { shiftKey: true, code: "KeyM" });
      press("F1", { shiftKey: true, code: "F1" });

      expect(h.onToggleMute).toHaveBeenCalledTimes(2);
    });

    it("toggles mute on Ctrl+Shift+M outside a voice channel too", () => {
      mockVoiceGetState.mockReturnValue({ currentChannelId: null });
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const mute = press("M", { shiftKey: true, code: "KeyM" });
      const deafen = press("D", { shiftKey: true, code: "KeyD" });

      expect(h.onToggleMute).toHaveBeenCalledOnce();
      expect(h.onToggleDeafen).toHaveBeenCalledOnce();
      expect(mute.defaultPrevented).toBe(true);
      expect(deafen.defaultPrevented).toBe(true);
    });

    it("does not treat an unbound Ctrl+Shift key as a voice shortcut", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const other = press("J", { shiftKey: true, code: "KeyJ" });

      expect(h.onToggleMute).not.toHaveBeenCalled();
      expect(h.onToggleDeafen).not.toHaveBeenCalled();
      expect(other.defaultPrevented).toBe(false);
    });
  });

  it("does nothing while suspended (settings overlay open)", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds({ ...h, isSuspended: () => true });

    press("f");
    press("U", { shiftKey: true, code: "KeyU" });

    expect(h.onSearch).not.toHaveBeenCalled();
    expect(h.onUploadFile).not.toHaveBeenCalled();
  });

  it("ignores plain keys and Alt combos", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    press("f", { ctrlKey: false });
    press("f", { altKey: true });

    expect(h.onSearch).not.toHaveBeenCalled();
  });

  it("typing in the member search does not move focus to the composer", () => {
    detach = attachGlobalKeybinds(makeHandlers());
    const composer = document.createElement("textarea");
    composer.className = "msg-textarea";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "member-search";
    document.body.append(composer, search);
    onTestFinished(() => {
      composer.remove();
      search.remove();
    });

    // Control: from an idle page the same key does reach the composer.
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(composer);

    search.focus();
    search.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }),
    );
    expect(document.activeElement).toBe(search);
  });

  // DP-35: Alt+↑/↓ steps to the previous/next channel, Alt+Shift+↑/↓ to the
  // previous/next unread channel (Discord's shortcuts).
  it("steps channels on Alt+ArrowDown / Alt+ArrowUp", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    press("ArrowDown", { ctrlKey: false, altKey: true });
    press("ArrowUp", { ctrlKey: false, altKey: true });

    expect(h.onStepChannel).toHaveBeenNthCalledWith(1, 1, false);
    expect(h.onStepChannel).toHaveBeenNthCalledWith(2, -1, false);
  });

  it("steps to unread channels on Alt+Shift+ArrowDown / Alt+Shift+ArrowUp", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    press("ArrowDown", { ctrlKey: false, altKey: true, shiftKey: true });
    press("ArrowUp", { ctrlKey: false, altKey: true, shiftKey: true });

    expect(h.onStepChannel).toHaveBeenNthCalledWith(1, 1, true);
    expect(h.onStepChannel).toHaveBeenNthCalledWith(2, -1, true);
  });

  function altArrowIn(el: HTMLElement, init: KeyboardEventInit = {}): void {
    document.body.appendChild(el);
    el.focus();
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowDown",
        altKey: true,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
    el.remove();
  }

  it("steps channels while typing in the message composer", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    const composer = document.createElement("textarea");
    composer.className = "msg-textarea";
    altArrowIn(composer);

    expect(h.onStepChannel).toHaveBeenCalledWith(1, false);
  });

  it("moves focus to the new channel's composer after stepping from the composer", () => {
    const h = makeHandlers();
    const next = document.createElement("textarea");
    next.className = "msg-textarea";
    h.onStepChannel.mockImplementation(() => {
      document.body.appendChild(next);
    });
    detach = attachGlobalKeybinds(h);

    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const composer = document.createElement("textarea");
    composer.className = "msg-textarea";
    altArrowIn(composer);
    vi.runAllTimers();

    expect(document.activeElement).toBe(next);
    next.remove();
  });

  it("leaves Alt+Arrow to a composer popup that already handled it", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    const composer = document.createElement("textarea");
    composer.className = "msg-textarea";
    composer.addEventListener("keydown", (e) => e.preventDefault());
    altArrowIn(composer);

    expect(h.onStepChannel).not.toHaveBeenCalled();
  });

  it("does not step from the composer during an IME composition", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    const composer = document.createElement("textarea");
    composer.className = "msg-textarea";
    altArrowIn(composer, { isComposing: true });

    expect(h.onStepChannel).not.toHaveBeenCalled();
  });

  it("does not step while typing in another text field", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    const search = document.createElement("input");
    search.type = "search";
    altArrowIn(search);
    altArrowIn(document.createElement("textarea"));

    expect(h.onStepChannel).not.toHaveBeenCalled();
  });

  it("keeps a handler error from escaping to the document", () => {
    const h = makeHandlers();
    h.onSearch.mockImplementation(() => {
      throw new Error("boom");
    });
    detach = attachGlobalKeybinds(h);

    expect(() => press("f")).not.toThrow();
  });

  it("detaching stops the shortcuts", () => {
    const h = makeHandlers();
    const stop = attachGlobalKeybinds(h);
    stop();

    press("f");

    expect(h.onSearch).not.toHaveBeenCalled();
  });
  // 3A-1: Discord's chat keys.
  describe("chat keys", () => {
    /** A key pressed on `el` (focused, in the page), bubbling like a real one. */
    function keyOn(
      el: HTMLElement | Document,
      key: string,
      init: KeyboardEventInit = {},
    ): KeyboardEvent {
      if (el instanceof HTMLElement) {
        if (!el.isConnected) document.body.appendChild(el);
        el.focus();
      }
      const event = new KeyboardEvent("keydown", {
        key,
        code: codeFor(key),
        bubbles: true,
        cancelable: true,
        ...init,
      });
      el.dispatchEvent(event);
      return event;
    }

    function composer(): HTMLTextAreaElement {
      const ta = document.createElement("textarea");
      ta.className = "msg-textarea";
      document.body.appendChild(ta);
      onTestFinished(() => ta.remove());
      return ta;
    }

    describe("a ringing call (3B-4)", () => {
      function ringHandlers(active = true) {
        return {
          ...makeHandlers(),
          ringActive: vi.fn(() => active),
          onAcceptRing: vi.fn<() => void>(),
          onDeclineRing: vi.fn<() => void>(),
        };
      }

      it("Ctrl+Enter accepts and Escape declines, ahead of mark-read", () => {
        const h = ringHandlers();
        detach = attachGlobalKeybinds(h);

        const enter = keyOn(document.body, "Enter", { ctrlKey: true });
        const esc = keyOn(document.body, "Escape");

        expect(h.onAcceptRing).toHaveBeenCalledOnce();
        expect(h.onDeclineRing).toHaveBeenCalledOnce();
        expect(h.onMarkChannelRead).not.toHaveBeenCalled();
        expect(enter.defaultPrevented).toBe(true);
        expect(esc.defaultPrevented).toBe(true);
      });

      it("Ctrl+Enter in the message box answers the ring and never sends the draft", () => {
        const h = ringHandlers();
        detach = attachGlobalKeybinds(h);
        const box = document.createElement("textarea");
        box.className = "msg-textarea";
        box.value = "half-typed draft";
        const onSend = vi.fn();
        // The message box sends on Enter, Ctrl held or not, in its own listener.
        box.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        });
        document.body.appendChild(box);
        box.focus();

        try {
          keyOn(box, "Enter", { ctrlKey: true });

          expect(h.onAcceptRing).toHaveBeenCalledOnce();
          expect(onSend).not.toHaveBeenCalled();
          expect(box.value).toBe("half-typed draft");
        } finally {
          box.remove();
        }
      });

      it("with no ring, Ctrl+Enter is left alone and Escape still marks read", () => {
        const h = ringHandlers(false);
        detach = attachGlobalKeybinds(h);

        const enter = keyOn(document.body, "Enter", { ctrlKey: true });
        keyOn(document.body, "Escape");

        expect(h.onAcceptRing).not.toHaveBeenCalled();
        expect(h.onDeclineRing).not.toHaveBeenCalled();
        expect(enter.defaultPrevented).toBe(false);
        expect(h.onMarkChannelRead).toHaveBeenCalledOnce();
      });

      it("a dialog open keeps both keys for itself", () => {
        const h = ringHandlers();
        detach = attachGlobalKeybinds(h);
        const dialog = document.createElement("div");
        dialog.setAttribute("aria-modal", "true");
        document.body.appendChild(dialog);
        onTestFinished(() => dialog.remove());

        keyOn(document.body, "Enter", { ctrlKey: true });
        keyOn(document.body, "Escape");

        expect(h.onAcceptRing).not.toHaveBeenCalled();
        expect(h.onDeclineRing).not.toHaveBeenCalled();
        expect(h.onMarkChannelRead).not.toHaveBeenCalled();
      });

      it("Escape already used by another handler does not also decline", () => {
        const h = ringHandlers();
        detach = attachGlobalKeybinds(h);
        const claim = (e: Event): void => e.preventDefault();
        document.body.addEventListener("keydown", claim);
        onTestFinished(() => document.body.removeEventListener("keydown", claim));

        keyOn(document.body, "Escape");

        expect(h.onDeclineRing).not.toHaveBeenCalled();
      });
    });

    it("Escape marks the channel read; Shift+Escape the server", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const esc = keyOn(document.body, "Escape");
      keyOn(document.body, "Escape", { shiftKey: true });

      expect(h.onMarkChannelRead).toHaveBeenCalledOnce();
      expect(h.onMarkServerRead).toHaveBeenCalledOnce();
      expect(esc.defaultPrevented).toBe(true);
    });

    it("Escape from the message box marks read, from another field does not", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      keyOn(composer(), "Escape");
      const search = document.createElement("input");
      onTestFinished(() => search.remove());
      keyOn(search, "Escape");

      expect(h.onMarkChannelRead).toHaveBeenCalledOnce();
    });

    it("an Escape another handler used (cancel an edit, close a popup) marks nothing", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const box = composer();
      box.addEventListener("keydown", (e) => e.preventDefault());
      keyOn(box, "Escape");

      expect(h.onMarkChannelRead).not.toHaveBeenCalled();
    });

    it("an Escape that closes a dialog marks nothing, though the dialog is gone after", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const dialog = document.createElement("div");
      dialog.className = "modal-overlay visible";
      document.body.appendChild(dialog);
      // Like modalFactory: closes on Escape without preventDefault.
      const owner = new AbortController();
      document.addEventListener(
        "keydown",
        (e) => {
          if (e.key === "Escape") dialog.remove();
        },
        { signal: owner.signal },
      );

      keyOn(document.body, "Escape");

      expect(dialog.isConnected).toBe(false);
      expect(h.onMarkChannelRead).not.toHaveBeenCalled();

      keyOn(document.body, "Escape");
      expect(h.onMarkChannelRead).toHaveBeenCalledOnce();
      owner.abort();
    });

    it("Escape does nothing while suspended, held down, or with Ctrl", () => {
      let suspended = true;
      const h = makeHandlers();
      detach = attachGlobalKeybinds({ ...h, isSuspended: () => suspended });

      keyOn(document.body, "Escape");
      suspended = false;
      keyOn(document.body, "Escape", { repeat: true });
      keyOn(document.body, "Escape", { ctrlKey: true });

      expect(h.onMarkChannelRead).not.toHaveBeenCalled();
    });

    it("PageUp/PageDown from the message box scroll the messages", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const box = composer();
      const down = keyOn(box, "PageDown");
      keyOn(box, "PageUp");
      keyOn(document.body, "PageDown");

      expect(h.onScrollMessages.mock.calls).toEqual([[1], [-1], [1]]);
      expect(down.defaultPrevented).toBe(true);
    });

    it("PageDown on another focused element is left to that element", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const scroller = document.createElement("div");
      scroller.tabIndex = 0;
      onTestFinished(() => scroller.remove());
      const search = document.createElement("input");
      onTestFinished(() => search.remove());
      keyOn(scroller, "PageDown");
      keyOn(search, "PageDown");

      expect(h.onScrollMessages).not.toHaveBeenCalled();
    });

    it("typing with nothing focused moves focus to the message box", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);
      const box = composer();
      box.blur();

      const typed = keyOn(document.body, "h");

      expect(document.activeElement).toBe(box);
      // The character itself must still land: the key is not cancelled.
      expect(typed.defaultPrevented).toBe(false);
    });

    it("typing leaves focus alone on a control, for Space, shortcuts and a read-only box", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);
      const box = composer();

      const button = document.createElement("button");
      onTestFinished(() => button.remove());
      keyOn(button, "h");
      expect(document.activeElement).toBe(button);

      button.blur();
      keyOn(document.body, " ");
      keyOn(document.body, "Shift");
      expect(document.activeElement).not.toBe(box);

      box.readOnly = true;
      keyOn(document.body, "h");
      expect(document.activeElement).not.toBe(box);
    });

    it("the push-to-talk key and a held key do not pull focus into the message box", () => {
      localStorage.setItem("owncord:settings:inputMode", JSON.stringify("ptt"));
      localStorage.setItem("owncord:settings:pttVk", JSON.stringify(0x56));
      onTestFinished(() => {
        localStorage.removeItem("owncord:settings:inputMode");
        localStorage.removeItem("owncord:settings:pttVk");
      });
      mockVoiceGetState.mockReturnValue({ currentChannelId: 7 });
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);
      const box = composer();
      box.blur();

      keyOn(document.body, "v", { keyCode: 0x56 });
      keyOn(document.body, "h", { repeat: true });
      expect(document.activeElement).not.toBe(box);

      keyOn(document.body, "h", { keyCode: 0x48 });
      expect(document.activeElement).toBe(box);

      // Outside a call the key is just a letter.
      mockVoiceGetState.mockReturnValue({ currentChannelId: null });
      box.blur();
      keyOn(document.body, "v", { keyCode: 0x56 });
      expect(document.activeElement).toBe(box);
    });

    it("a character typed with AltGr (Ctrl+Alt on Windows) starts a message", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);
      const box = composer();
      box.blur();

      keyOn(document.body, "@", { ctrlKey: true, altKey: true, modifierAltGraph: true });

      expect(document.activeElement).toBe(box);
      expect(h.onSearch).not.toHaveBeenCalled();
    });

    it("Ctrl+E and Ctrl+G toggle the emoji and GIF pickers, also from the message box", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const e = keyOn(document.body, "e", { ctrlKey: true });
      keyOn(composer(), "g", { ctrlKey: true });

      expect(h.onTogglePicker.mock.calls).toEqual([["emoji"], ["gif"]]);
      expect(e.defaultPrevented).toBe(true);
    });

    it("Ctrl+E and Ctrl+G reach an open picker's own search field", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const picker = document.createElement("div");
      picker.className = "emoji-picker";
      const search = document.createElement("input");
      picker.appendChild(search);
      document.body.appendChild(picker);
      onTestFinished(() => picker.remove());
      keyOn(search, "e", { ctrlKey: true });
      keyOn(search, "g", { ctrlKey: true });

      expect(h.onTogglePicker.mock.calls).toEqual([["emoji"], ["gif"]]);
    });

    it("another text field keeps Ctrl+E and Ctrl+G", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const search = document.createElement("input");
      onTestFinished(() => search.remove());
      keyOn(search, "e", { ctrlKey: true });
      keyOn(search, "g", { ctrlKey: true });

      expect(h.onTogglePicker).not.toHaveBeenCalled();
    });
  });
  describe("Ctrl+, opens Settings", () => {
    /** Dispatch on `el` so the target is where focus really is. */
    function keyOn(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
      if (!el.isConnected) document.body.appendChild(el);
      el.focus();
      const event = new KeyboardEvent("keydown", {
        key: ",",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      el.dispatchEvent(event);
      return event;
    }

    it("Ctrl+, opens Settings and swallows the browser default", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const event = press(",");

      expect(h.onOpenSettings).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
    });

    it("Cmd+, does the same (macOS)", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      press(",", { ctrlKey: false, metaKey: true });

      expect(h.onOpenSettings).toHaveBeenCalledOnce();
    });

    it("a bare comma and Ctrl+Alt+, are not the shortcut", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const bare = press(",", { ctrlKey: false });
      press(",", { altKey: true });

      expect(h.onOpenSettings).not.toHaveBeenCalled();
      expect(bare.defaultPrevented).toBe(false);
    });

    it("works from the message composer, like Ctrl+F", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const composer = document.createElement("textarea");
      composer.className = "msg-textarea";
      onTestFinished(() => composer.remove());
      keyOn(composer, { ctrlKey: true });

      expect(h.onOpenSettings).toHaveBeenCalledOnce();
    });

    it("does nothing while Settings is open (isSuspended)", () => {
      const h = makeHandlers();
      let settingsOpen = true;
      detach = attachGlobalKeybinds({ ...h, isSuspended: () => settingsOpen });

      const event = press(",");
      expect(h.onOpenSettings).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);

      settingsOpen = false;
      press(",");
      expect(h.onOpenSettings).toHaveBeenCalledOnce();
    });

    it("does nothing while a dialog is open", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);
      const dialog = document.createElement("div");
      dialog.className = "modal-overlay visible";
      document.body.appendChild(dialog);
      onTestFinished(() => dialog.remove());

      press(",");

      expect(h.onOpenSettings).not.toHaveBeenCalled();
    });

    it("ignores an auto-repeating key", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      press(",", { repeat: true });

      expect(h.onOpenSettings).not.toHaveBeenCalled();
    });
  });

  describe("Ctrl+/ opens the shortcuts overlay", () => {
    function keyOn(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
      if (!el.isConnected) document.body.appendChild(el);
      el.focus();
      const event = new KeyboardEvent("keydown", {
        key: "/",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      el.dispatchEvent(event);
      return event;
    }

    it("Ctrl+/ opens it and swallows the browser default", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const event = press("/");

      expect(h.onOpenShortcuts).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(true);
    });

    it("Cmd+/ does the same (macOS)", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      press("/", { ctrlKey: false, metaKey: true });

      expect(h.onOpenShortcuts).toHaveBeenCalledOnce();
    });

    it("a bare slash and Ctrl+Alt+/ are not the shortcut", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      const bare = press("/", { ctrlKey: false });
      press("/", { altKey: true });

      expect(h.onOpenShortcuts).not.toHaveBeenCalled();
      expect(bare.defaultPrevented).toBe(false);
    });

    it("works from the message composer", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);
      const composer = document.createElement("textarea");
      composer.className = "msg-textarea";
      onTestFinished(() => composer.remove());

      keyOn(composer, { ctrlKey: true });

      expect(h.onOpenShortcuts).toHaveBeenCalledOnce();
    });

    it("does nothing while Settings is open (isSuspended)", () => {
      const h = makeHandlers();
      let settingsOpen = true;
      detach = attachGlobalKeybinds({ ...h, isSuspended: () => settingsOpen });

      const event = press("/");
      expect(h.onOpenShortcuts).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);

      settingsOpen = false;
      press("/");
      expect(h.onOpenShortcuts).toHaveBeenCalledOnce();
    });

    it("does nothing while a dialog is open", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);
      const dialog = document.createElement("div");
      dialog.className = "modal-overlay visible";
      document.body.appendChild(dialog);
      onTestFinished(() => dialog.remove());

      press("/");

      expect(h.onOpenShortcuts).not.toHaveBeenCalled();
    });

    it("ignores an auto-repeating key", () => {
      const h = makeHandlers();
      detach = attachGlobalKeybinds(h);

      press("/", { repeat: true });

      expect(h.onOpenShortcuts).not.toHaveBeenCalled();
    });
  });
});
