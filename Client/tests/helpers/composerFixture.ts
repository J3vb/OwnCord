import { afterEach, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";
import { createMessageInput } from "@components/MessageInput";
import type { MessageInputOptions } from "@components/MessageInput";

/**
 * Gives each test a mounted composer for channel 1 in a fresh container, and
 * afterwards destroys it and removes the container. `bind` receives the
 * container, the composer and its `onSend` spy.
 */
export function useMountedComposer(
  bind: (
    container: HTMLDivElement,
    input: ReturnType<typeof createMessageInput>,
    onSend: Mock<MessageInputOptions["onSend"]>,
  ) => void,
): void {
  let container: HTMLDivElement;
  let input: ReturnType<typeof createMessageInput>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    const onSend = vi.fn<MessageInputOptions["onSend"]>();
    input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend,
      onTyping: vi.fn(),
    });
    input.mount(container);
    bind(container, input, onSend);
  });

  afterEach(() => {
    input.destroy?.();
    container.remove();
  });
}
