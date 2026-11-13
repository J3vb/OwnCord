// The composer row is "+", the text, GIF, emoji, the mic and send. Poll moves
// to the "+" menu everywhere; Sticker joins it off the phone, and on a phone
// the smiley holds the sticker tab instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../../helpers/messageInputMocks";
import { usePhone } from "../../helpers/phoneMedia";
import { closeBottomSheet } from "@lib/ui/bottomSheet";
import { savePref } from "@lib/prefs/preferences";
import { authStore } from "@stores/auth.store";
import { composerButtonPrefKey } from "../../../src/features/messaging/composerButtons";
import { mountMessageInput, useMessageInputContainer } from "../../helpers/messageInputHarness";
import {
  attachSheetEl,
  resetComposerServer,
  settleHistory,
  useFullComposerServer,
} from "../../helpers/composerSheets";

vi.mock("../../../src/features/messaging/EmojiPicker", () => mocks.emojiPickerMock());
vi.mock("../../../src/features/messaging/GifPicker", () => mocks.gifPickerMock());

const sheet = attachSheetEl;
const tileLabels = (): string[] =>
  [...(sheet()?.querySelectorAll(".attach-sheet-tile") ?? [])].map(
    (b) => b.textContent?.trim() ?? "",
  );

describe("phone composer row", () => {
  let container: HTMLDivElement;
  useMessageInputContainer((el) => {
    container = el;
  });

  beforeEach(useFullComposerServer);

  afterEach(async () => {
    closeBottomSheet();
    await settleHistory();
    vi.unstubAllGlobals();
    resetComposerServer();
  });

  function mountFull() {
    const onCreatePoll = vi.fn();
    const { comp } = mountMessageInput(container, {
      onSendSticker: vi.fn(),
      onCreatePoll,
      onUploadFile: vi.fn(async (file: File) => ({ id: "up-1", url: "/f/1", filename: file.name })),
    });
    const q = (sel: string) => container.querySelector<HTMLButtonElement>(sel)!;
    return {
      comp,
      onCreatePoll,
      attach: q(".attach-btn"),
      emoji: q(".emoji-btn"),
      gif: q(".gif-btn"),
      sticker: q('[data-testid="sticker-btn"]'),
      poll: q('[data-testid="poll-btn"]'),
      mic: q('[data-testid="voice-mic-btn"]'),
      send: q('[data-testid="send-btn"]'),
    };
  }

  it("keeps +, GIF, the smiley, the mic and send in the row on a phone", () => {
    usePhone();
    const b = mountFull();
    for (const shown of [b.attach, b.gif, b.emoji, b.mic, b.send]) expect(shown.hidden).toBe(false);
    for (const hidden of [b.sticker, b.poll]) expect(hidden.hidden).toBe(true);
    expect(b.emoji.getAttribute("aria-label")).toBe("Emoji and stickers");
    b.comp.destroy?.();
  });

  it("keeps the same row off the phone layout, with Sticker and Poll in the + menu", () => {
    const b = mountFull();
    for (const shown of [b.attach, b.gif, b.emoji, b.mic, b.send]) expect(shown.hidden).toBe(false);
    for (const hidden of [b.sticker, b.poll]) expect(hidden.hidden).toBe(true);
    expect(b.emoji.getAttribute("aria-label")).toBe("Emoji");
    b.attach.click();
    expect(tileLabels()).toEqual(["Upload", "Poll", "Sticker"]);
    b.comp.destroy?.();
  });

  it("offers Poll in the + sheet, running its own action", () => {
    usePhone();
    const b = mountFull();
    b.attach.click();
    expect(tileLabels()).toEqual(["Take photo", "Gallery", "Files", "Poll"]);
    document.querySelector<HTMLButtonElement>('[data-testid="attach-sheet-poll"]')!.click();
    expect(sheet()).toBeNull();
    expect(b.onCreatePoll).toHaveBeenCalledOnce();
    b.comp.destroy?.();
  });

  it("leaves out a sheet row the user switched off in settings", () => {
    savePref(composerButtonPrefKey("poll"), false);
    usePhone();
    const b = mountFull();
    b.attach.click();
    expect(tileLabels()).toEqual(["Take photo", "Gallery", "Files"]);
    b.comp.destroy?.();
  });

  it("keeps + usable for Poll when the server has uploads off", () => {
    authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 0 } }));
    usePhone();
    const b = mountFull();
    expect(b.attach.disabled).toBe(false);
    b.attach.click();
    expect(tileLabels()).toEqual(["Poll"]);
    b.comp.destroy?.();
  });

  it("keeps + usable for Poll and Sticker off the phone when the server has uploads off", () => {
    authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 0 } }));
    const b = mountFull();
    expect(b.attach.disabled).toBe(false);
    expect(b.mic.hidden).toBe(true);
    b.attach.click();
    expect(tileLabels()).toEqual(["Poll", "Sticker"]);
    b.comp.destroy?.();
  });

  it("disables + when uploads are off and nothing else is in the sheet", () => {
    authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 0 } }));
    savePref(composerButtonPrefKey("poll"), false);
    usePhone();
    const b = mountFull();
    expect(b.attach.disabled).toBe(true);
    b.comp.destroy?.();
  });

  it("hides the smiley only when emoji and stickers are both switched off", () => {
    savePref(composerButtonPrefKey("emoji"), false);
    usePhone();
    const b = mountFull();
    expect(b.emoji.hidden).toBe(false);
    savePref(composerButtonPrefKey("sticker"), false);
    expect(b.emoji.hidden).toBe(true);
    expect(b.gif.hidden).toBe(false);
    b.comp.destroy?.();
  });

  it("opens the smiley on the sticker tab when emoji is switched off", () => {
    savePref(composerButtonPrefKey("emoji"), false);
    usePhone();
    const b = mountFull();
    b.emoji.click();
    const sheetEl = document.querySelector('[data-testid="expression-sheet"]');
    expect(sheetEl).not.toBeNull();
    expect(
      sheetEl!.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-testid"),
    ).toBe("xp-tab-sticker");
    b.comp.destroy?.();
  });

  it("offers no sheet while the composer is disabled", () => {
    usePhone();
    const b = mountFull();
    b.comp.setDisabled("You cannot send messages here");
    expect(b.attach.disabled).toBe(true);
    b.attach.click();
    expect(sheet()).toBeNull();
    b.comp.destroy?.();
  });

  function typeText(text: string): void {
    const textarea = container.querySelector<HTMLTextAreaElement>(".msg-textarea")!;
    textarea.value = text;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("hides GIF and the smiley while the box holds text on a phone, and brings them back", () => {
    usePhone();
    const b = mountFull();
    typeText("hi");
    expect(b.gif.hidden).toBe(true);
    expect(b.emoji.hidden).toBe(true);
    for (const shown of [b.attach, b.send]) expect(shown.hidden).toBe(false);
    typeText("");
    expect(b.gif.hidden).toBe(false);
    expect(b.emoji.hidden).toBe(false);
    b.comp.destroy?.();
  });

  it("brings them back when a send empties the box", () => {
    usePhone();
    const b = mountFull();
    typeText("hello");
    expect(b.gif.hidden).toBe(true);
    b.send.click();
    expect(container.querySelector<HTMLTextAreaElement>(".msg-textarea")!.value).toBe("");
    expect(b.gif.hidden).toBe(false);
    expect(b.emoji.hidden).toBe(false);
    b.comp.destroy?.();
  });

  it("keeps a button the user hid hidden when the box empties again", () => {
    savePref(composerButtonPrefKey("gif"), false);
    usePhone();
    const b = mountFull();
    typeText("hi");
    typeText("");
    expect(b.gif.hidden).toBe(true);
    expect(b.emoji.hidden).toBe(false);
    b.comp.destroy?.();
  });

  it("keeps GIF and the smiley while typing off the phone layout", () => {
    const b = mountFull();
    typeText("hi");
    expect(b.gif.hidden).toBe(false);
    expect(b.emoji.hidden).toBe(false);
    b.comp.destroy?.();
  });

  it("brings them back when text typed on a wide layout is cleared after moving onto the phone", () => {
    const b = mountFull();
    typeText("hi");
    usePhone();
    window.dispatchEvent(new Event("resize"));
    expect(b.gif.hidden).toBe(true);
    typeText("");
    expect(b.gif.hidden).toBe(false);
    expect(b.emoji.hidden).toBe(false);
    b.comp.destroy?.();
  });

  /** Records, for each height measurement, whether GIF was hidden at that moment. */
  function recordMeasures(gif: HTMLButtonElement): boolean[] {
    const reads: boolean[] = [];
    const textarea = container.querySelector<HTMLTextAreaElement>(".msg-textarea")!;
    Object.defineProperty(textarea, "scrollHeight", {
      configurable: true,
      get: () => {
        reads.push(gif.hidden === true);
        return 40;
      },
    });
    return reads;
  }

  it("measures the text's height after GIF and the smiley give way", () => {
    usePhone();
    const b = mountFull();
    const reads = recordMeasures(b.gif);
    // The whole text at once, as a paste or a draft restore delivers it.
    typeText("Hey, are we still on for the call tonight?");
    expect(reads.at(-1)).toBe(true);
    b.comp.destroy?.();
  });

  it("measures again when a layout change moves the buttons with text in the box", () => {
    const b = mountFull();
    typeText("Hey, are we still on for the call tonight?");
    const reads = recordMeasures(b.gif);
    usePhone();
    window.dispatchEvent(new Event("resize"));
    expect(reads).toEqual([true]);
    reads.length = 0;
    usePhone(false);
    window.dispatchEvent(new Event("resize"));
    expect(reads).toEqual([false]);
    b.comp.destroy?.();
  });

  it("still opens the emoji picker from its shortcut while the smiley gives way", () => {
    usePhone();
    const b = mountFull();
    typeText("hi");
    expect(b.emoji.hidden).toBe(true);
    b.comp.togglePicker("emoji");
    const sheetEl = document.querySelector('[data-testid="expression-sheet"]');
    expect(
      sheetEl?.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-testid"),
    ).toBe("xp-tab-emoji");
    b.comp.destroy?.();
  });

  it("still opens the GIF picker from its shortcut while the button gives way", () => {
    usePhone();
    const b = mountFull();
    typeText("hi");
    b.comp.togglePicker("gif");
    const sheetEl = document.querySelector('[data-testid="expression-sheet"]');
    expect(
      sheetEl?.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute("data-testid"),
    ).toBe("xp-tab-gif");
    b.comp.destroy?.();
  });

  it("swaps the + menu's Sticker tile when a resize crosses onto or off the phone layout", () => {
    const b = mountFull();
    usePhone();
    window.dispatchEvent(new Event("resize"));
    expect(b.mic.hidden).toBe(false);
    b.attach.click();
    expect(tileLabels()).not.toContain("Sticker");
    closeBottomSheet();
    usePhone(false);
    window.dispatchEvent(new Event("resize"));
    expect(b.gif.hidden).toBe(false);
    b.attach.click();
    expect(tileLabels()).toContain("Sticker");
    b.comp.destroy?.();
  });
});
