import { describe, it, expect, vi } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import { createMessageInput } from "@components/MessageInput";
import { wantsNativeMenu } from "@lib/dom";
import { stubGifApi as gifApi } from "../helpers/messageInputHarness";

describe("composer spelling menu", () => {
  let container: HTMLDivElement;
  useMountContainer((mounted) => {
    container = mounted;
  });

  it("composer textarea keeps the native menu and spellcheck", () => {
    const input = createMessageInput({
      channelId: 1,
      channelName: "general",
      gifApi,
      onSend: vi.fn(),
      onTyping: vi.fn(),
    });
    input.mount(container);
    const area = container.querySelector<HTMLTextAreaElement>(".msg-textarea")!;
    // The webview's own menu is where the spelling suggestions live: main.ts
    // leaves it on for exactly the targets wantsNativeMenu accepts.
    expect(wantsNativeMenu(area)).toBe(true);
    // Spell checking is on by default; only "false" (or "off") turns it off.
    expect([null, "", "true"]).toContain(area.getAttribute("spellcheck"));
    input.destroy?.();
  });
});
