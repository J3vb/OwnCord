// "Chat bar buttons" (Settings → Text & Images): each composer button the user
// switches off leaves the bar at once, and switching it back on never shows a
// button the server or host left out.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import { createMessageInput } from "@components/MessageInput";
import { savePref } from "@lib/prefs/preferences";
import { applyReadyCapabilities, resetServerCapabilities } from "@lib/net/serverCapabilities";
import { authStore } from "@stores/auth.store";
import {
  COMPOSER_BUTTONS,
  composerButtonPrefKey,
  type ComposerButton,
} from "../../src/features/messaging/composerButtons";

const SELECTOR: Readonly<Record<ComposerButton, string>> = {
  emoji: ".emoji-btn",
  sticker: '[data-testid="sticker-btn"]',
  gif: ".gif-btn",
  poll: '[data-testid="poll-btn"]',
  voice: '[data-testid="voice-mic-btn"]',
};

let container: HTMLDivElement;
const made: Array<{ destroy?: () => void }> = [];

function mountComposer() {
  const comp = createMessageInput({
    channelId: 1,
    channelName: "general",
    onSend: vi.fn(),
    onTyping: vi.fn(),
    onSendSticker: vi.fn(),
    onCreatePoll: vi.fn(),
    onUploadFile: vi.fn(async (file: File) => ({ id: "up-1", url: "/f/1", filename: file.name })),
  });
  made.push(comp);
  comp.mount(container);
  return comp;
}

const btn = (b: ComposerButton): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>(SELECTOR[b]);

useMountContainer(
  (c) => {
    container = c;
  },
  () => {
    for (const comp of made.splice(0)) comp.destroy?.();
    resetServerCapabilities();
    authStore.setState((s) => ({ ...s, uploadPolicy: null }));
    localStorage.clear();
  },
);

beforeEach(() => {
  localStorage.clear();
  applyReadyCapabilities({ stickers: true, polls: true, voice_messages: true });
  authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 10 * 1024 * 1024 } }));
});

describe("chat bar button settings", () => {
  it("shows every button by default", () => {
    mountComposer();
    for (const b of COMPOSER_BUTTONS) expect(btn(b)?.hidden, b).toBe(false);
  });

  it("a button switched off before mount starts hidden; the others stay", () => {
    savePref(composerButtonPrefKey("gif"), false);
    mountComposer();
    expect(btn("gif")?.hidden).toBe(true);
    expect(btn("emoji")?.hidden).toBe(false);
    expect(btn("voice")?.hidden).toBe(false);
  });

  it("each switch hides and shows its button live on an open composer", () => {
    mountComposer();
    for (const b of COMPOSER_BUTTONS) {
      savePref(composerButtonPrefKey(b), false);
      expect(btn(b)?.hidden, b).toBe(true);
      savePref(composerButtonPrefKey(b), true);
      expect(btn(b)?.hidden, b).toBe(false);
    }
  });

  it("switching the mic back on keeps it hidden where the server has no voice messages", () => {
    applyReadyCapabilities({ stickers: true, polls: true });
    mountComposer();
    savePref(composerButtonPrefKey("voice"), false);
    savePref(composerButtonPrefKey("voice"), true);
    expect(btn("voice")?.hidden).toBe(true);
  });

  it("switching sticker or poll back on adds nothing where the server has neither", () => {
    applyReadyCapabilities({});
    mountComposer();
    savePref(composerButtonPrefKey("sticker"), false);
    savePref(composerButtonPrefKey("sticker"), true);
    savePref(composerButtonPrefKey("poll"), true);
    expect(btn("sticker")).toBeNull();
    expect(btn("poll")).toBeNull();
  });

  it("the shortcut still opens a hidden button's picker", () => {
    savePref(composerButtonPrefKey("emoji"), false);
    const comp = mountComposer();
    comp.togglePicker("emoji");
    expect(container.querySelector(".expression-popup")).not.toBeNull();
  });

  it("a destroyed composer stops listening", () => {
    const comp = mountComposer();
    const emoji = btn("emoji")!;
    comp.destroy?.();
    savePref(composerButtonPrefKey("emoji"), false);
    expect(emoji.hidden).toBe(false);
  });
});
