// "Chat bar buttons" (Settings → Text & Images): each composer button the user
// switches off leaves the bar (or, for Sticker and Poll, the "+" menu) at once,
// and switching it back on never shows a button the server or host left out.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMountContainer } from "../helpers/mountContainer";
import { resetComposerServer, useFullComposerServer } from "../helpers/composerSheets";
import { createMessageInput } from "../../src/features/messaging/MessageInput";
import { savePref } from "@lib/prefs/preferences";
import { applyReadyCapabilities } from "@lib/net/serverCapabilities";
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

/** Sticker and Poll are "+" menu tiles; the rest are chat bar buttons. */
const IN_MENU: readonly ComposerButton[] = ["sticker", "poll"];

/** Whether `b` is on offer: its bar button shows, or its tile is in the open "+" menu. */
function offered(b: ComposerButton): boolean {
  if (!IN_MENU.includes(b)) return btn(b)?.hidden === false;
  container.querySelector<HTMLButtonElement>(".attach-btn")!.click();
  const tile = container.querySelector(`.attach-menu [data-testid="attach-sheet-${b}"]`);
  container.querySelector<HTMLButtonElement>(".attach-btn")!.click();
  return tile !== null;
}

useMountContainer(
  (c) => {
    container = c;
  },
  () => {
    for (const comp of made.splice(0)) comp.destroy?.();
    resetComposerServer();
  },
);

beforeEach(useFullComposerServer);

describe("chat bar button settings", () => {
  it("shows every button by default", () => {
    mountComposer();
    for (const b of COMPOSER_BUTTONS) expect(offered(b), b).toBe(true);
    for (const b of IN_MENU) expect(btn(b)?.hidden, b).toBe(true);
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
      expect(offered(b), b).toBe(false);
      savePref(composerButtonPrefKey(b), true);
      expect(offered(b), b).toBe(true);
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
