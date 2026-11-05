// A share from another app (Android "Share" > OwnCord) lands in the picked
// chat's composer: the files as attachments, the text in the box, unsent.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeFile } from "../../../src/platform/contracts/nativeFiles";

vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));
vi.mock("@components/GifPicker", () => ({
  createGifPicker: () => ({ element: document.createElement("div"), destroy: vi.fn() }),
}));

import { createMessageInput } from "../../../src/features/messaging/MessageInput";
import { sendShareTo } from "../../../src/features/share/shareInbox";
import { runSessionResets } from "../../../src/lib/net/sessionRegistry";

const file = (name: string): NativeFile => ({
  name,
  size: 4,
  read: async () => new File(["data"], name, { type: "image/png" }),
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

function mount(channelId: number) {
  const onUploadFile = vi.fn(async (f: File) => ({
    id: f.name,
    url: "http://x",
    filename: f.name,
  }));
  const onSend = vi.fn();
  const slot = document.createElement("div");
  document.body.appendChild(slot);
  const comp = createMessageInput({
    channelId,
    channelName: "general",
    onSend,
    onTyping: vi.fn(),
    onUploadFile,
  });
  comp.mount(slot);
  const textarea = slot.querySelector(".msg-textarea") as HTMLTextAreaElement;
  return { comp, onUploadFile, onSend, textarea };
}

afterEach(() => {
  runSessionResets("server_switch");
  document.body.replaceChildren();
});

describe("shared files in the composer", () => {
  it("attaches the files and fills in the text of a share sent to this chat, without sending", async () => {
    const { comp, onUploadFile, onSend, textarea } = mount(3);
    sendShareTo(3, { files: [file("a.png"), file("b.png")], text: "https://example.com" });
    await flush();
    expect(onUploadFile.mock.calls.map((c) => (c[0] as File).name)).toEqual(["a.png", "b.png"]);
    expect(textarea.value).toBe("https://example.com");
    expect(onSend).not.toHaveBeenCalled();
    comp.destroy?.();
  });

  it("takes a share sent before the chat opened", async () => {
    sendShareTo(4, { files: [file("c.png")], text: "" });
    const { comp, onUploadFile, textarea } = mount(4);
    await flush();
    expect(onUploadFile).toHaveBeenCalledTimes(1);
    expect(textarea.value).toBe("");
    comp.destroy?.();
  });

  it("a closed composer takes nothing", async () => {
    const first = mount(5);
    first.comp.destroy?.();
    sendShareTo(5, { files: [file("d.png")], text: "" });
    await flush();
    expect(first.onUploadFile).not.toHaveBeenCalled();
    const second = mount(5);
    await flush();
    expect(second.onUploadFile).toHaveBeenCalledTimes(1);
    second.comp.destroy?.();
  });
});
