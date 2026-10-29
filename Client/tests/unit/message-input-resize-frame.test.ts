// CL-05: typing coalesces the textarea auto/measure cycle (a forced layout)
// to one per animation frame; programmatic changes still resize synchronously.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));

import { createMessageInput } from "@components/MessageInput";

describe("MessageInput textarea resize", () => {
  let container: HTMLDivElement;
  let reads: number;
  let contentHeight: number;
  let frames: FrameRequestCallback[];
  let mounted: ReturnType<typeof createMessageInput> | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    reads = 0;
    contentHeight = 40;
    frames = [];
    mounted = null;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = (): void => undefined;
    });
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        reads++;
        return contentHeight;
      },
    });
  });

  afterEach(() => {
    mounted?.destroy?.();
    delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
    vi.unstubAllGlobals();
    container.remove();
  });

  function mountInput(onDraftChange = vi.fn()) {
    const comp = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend: vi.fn(),
      onTyping: vi.fn(),
      onUploadFile: vi.fn(),
      onDraftChange,
    } as never);
    comp.mount(container);
    mounted = comp;
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    // A textarea already measured once: later input events are coalesced.
    ta.style.height = "40px";
    return { comp, ta, onDraftChange };
  }

  const flush = (): void => {
    const run = frames;
    frames = [];
    for (const cb of run) cb(0);
  };

  it("measures once per frame however many input events fire", () => {
    const { ta, onDraftChange } = mountInput();
    reads = 0;
    onDraftChange.mockClear();
    for (let i = 0; i < 20; i++) {
      ta.value += "a";
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
    expect(reads).toBe(0);
    // The draft hook still fires per keystroke.
    expect(onDraftChange).toHaveBeenCalledTimes(20);
    flush();
    expect(reads).toBe(1);
  });

  it("shrinks after deletion and caps at the max height", () => {
    const { ta } = mountInput();
    contentHeight = 500;
    ta.value = "x\n".repeat(30);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(ta.style.height).toBe("200px");
    contentHeight = 40;
    ta.value = "x";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    flush();
    expect(ta.style.height).toBe("40px");
  });

  it("resizes synchronously for a programmatic change and drops the pending frame", () => {
    const { comp, ta } = mountInput();
    ta.value = "hello";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    contentHeight = 90;
    comp.insertMention("bob");
    expect(ta.style.height).toBe("90px");
    reads = 0;
    flush();
    expect(reads).toBe(0);
  });

  it("does not touch the textarea from a frame that fires after destroy", () => {
    const { comp, ta } = mountInput();
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    comp.destroy?.();
    reads = 0;
    flush();
    expect(reads).toBe(0);
  });
});
