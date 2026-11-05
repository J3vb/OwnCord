import { afterEach, describe, expect, it, vi } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import { createMessageInput } from "../../src/features/messaging/MessageInput";
import { stubGifApi as gifApi } from "../helpers/messageInputHarness";

function mountComposer(container: HTMLElement): ReturnType<typeof createMessageInput> {
  const input = createMessageInput({
    channelId: 1,
    channelName: "general",
    gifApi,
    onSend: vi.fn(),
    onTyping: vi.fn(),
  });
  input.mount(container);
  return input;
}

describe("composer focus when a channel opens", () => {
  let container: HTMLDivElement;
  useMountContainer((mounted) => {
    container = mounted;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("takes focus on a desktop, so typing goes straight in", () => {
    const input = mountComposer(container);
    expect(document.activeElement).toBe(container.querySelector(".msg-textarea"));
    input.destroy?.();
  });

  it("stays unfocused on a phone, so the keyboard does not cover the chat", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    const input = mountComposer(container);
    expect(document.activeElement).not.toBe(container.querySelector(".msg-textarea"));
    input.destroy?.();
  });
});
