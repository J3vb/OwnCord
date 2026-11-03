// The phone composer row is "+", the text and send: the smiley stands for the
// emoji, GIF and sticker tabs, and Poll and Voice message move to the "+"
// sheet. A wider window keeps every button in the row.
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

vi.mock("@components/EmojiPicker", () => mocks.emojiPickerMock());
vi.mock("@components/GifPicker", () => mocks.gifPickerMock());

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

  it("keeps only +, the smiley and send in the row on a phone", () => {
    usePhone();
    const b = mountFull();
    expect(b.attach.hidden).toBe(false);
    expect(b.emoji.hidden).toBe(false);
    expect(b.send.hidden).toBe(false);
    for (const hidden of [b.gif, b.sticker, b.poll, b.mic]) expect(hidden.hidden).toBe(true);
    expect(b.emoji.getAttribute("aria-label")).toBe("Emoji, GIFs and stickers");
    b.comp.destroy?.();
  });

  it("keeps every button in the row off the phone layout", () => {
    const b = mountFull();
    for (const shown of [b.emoji, b.gif, b.sticker, b.poll, b.mic])
      expect(shown.hidden).toBe(false);
    expect(b.emoji.getAttribute("aria-label")).toBe("Emoji");
    b.attach.click();
    expect(sheet()).toBeNull();
    b.comp.destroy?.();
  });

  it("offers Poll and Voice message in the + sheet, each running its own action", () => {
    usePhone();
    const b = mountFull();
    const micClick = vi.spyOn(b.mic, "click");
    b.attach.click();
    expect(tileLabels()).toEqual(["Take photo", "Gallery", "Files", "Poll", "Voice message"]);
    document.querySelector<HTMLButtonElement>('[data-testid="attach-sheet-poll"]')!.click();
    expect(sheet()).toBeNull();
    expect(b.onCreatePoll).toHaveBeenCalledOnce();

    b.attach.click();
    document.querySelector<HTMLButtonElement>('[data-testid="attach-sheet-voice"]')!.click();
    expect(sheet()).toBeNull();
    expect(micClick).toHaveBeenCalledOnce();
    b.comp.destroy?.();
  });

  it("leaves out a sheet row the user switched off in settings", () => {
    savePref(composerButtonPrefKey("poll"), false);
    savePref(composerButtonPrefKey("voice"), false);
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

  it("disables + when uploads are off and nothing else is in the sheet", () => {
    authStore.setState((s) => ({ ...s, uploadPolicy: { max_upload_bytes: 0 } }));
    savePref(composerButtonPrefKey("poll"), false);
    usePhone();
    const b = mountFull();
    expect(b.attach.disabled).toBe(true);
    b.comp.destroy?.();
  });

  it("hides the smiley only when all three expression buttons are switched off", () => {
    savePref(composerButtonPrefKey("emoji"), false);
    usePhone();
    const b = mountFull();
    expect(b.emoji.hidden).toBe(false);
    savePref(composerButtonPrefKey("gif"), false);
    savePref(composerButtonPrefKey("sticker"), false);
    expect(b.emoji.hidden).toBe(true);
    b.comp.destroy?.();
  });

  it("opens the smiley on the sticker tab when emoji and GIF are switched off", () => {
    savePref(composerButtonPrefKey("emoji"), false);
    savePref(composerButtonPrefKey("gif"), false);
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

  it("moves the buttons when a resize crosses onto or off the phone layout", () => {
    const b = mountFull();
    expect(b.gif.hidden).toBe(false);
    usePhone();
    window.dispatchEvent(new Event("resize"));
    expect(b.gif.hidden).toBe(true);
    expect(b.mic.hidden).toBe(true);
    usePhone(false);
    window.dispatchEvent(new Event("resize"));
    expect(b.gif.hidden).toBe(false);
    expect(b.mic.hidden).toBe(false);
    b.comp.destroy?.();
  });
});
