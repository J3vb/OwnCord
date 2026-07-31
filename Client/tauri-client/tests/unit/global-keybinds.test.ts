import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

function makeHandlers(): {
  onSearch: ReturnType<typeof vi.fn>;
  onToggleMute: ReturnType<typeof vi.fn>;
  onToggleDeafen: ReturnType<typeof vi.fn>;
  onToggleCamera: ReturnType<typeof vi.fn>;
  onUploadFile: ReturnType<typeof vi.fn>;
} {
  return {
    onSearch: vi.fn(),
    onToggleMute: vi.fn(),
    onToggleDeafen: vi.fn(),
    onToggleCamera: vi.fn(),
    onUploadFile: vi.fn(),
  };
}

function press(key: string, opts: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
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

  it("Ctrl+U opens the file picker", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    press("u");

    expect(h.onUploadFile).toHaveBeenCalledOnce();
  });

  it("ignores voice shortcuts outside a voice channel", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds(h);

    const mute = press("m");
    const deafen = press("d");
    const camera = press("V", { shiftKey: true });

    expect(h.onToggleMute).not.toHaveBeenCalled();
    expect(h.onToggleDeafen).not.toHaveBeenCalled();
    expect(h.onToggleCamera).not.toHaveBeenCalled();
    // Untouched keys keep their default behaviour.
    expect(mute.defaultPrevented).toBe(false);
    expect(deafen.defaultPrevented).toBe(false);
    expect(camera.defaultPrevented).toBe(false);
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

  it("does nothing while suspended (settings overlay open)", () => {
    const h = makeHandlers();
    detach = attachGlobalKeybinds({ ...h, isSuspended: () => true });

    press("f");
    press("u");

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
});
