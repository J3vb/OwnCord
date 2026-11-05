/**
 * The composer's tabbed expression popup: the emoji, sticker and GIF buttons
 * share one popup that opens on the tab of the button pressed, in a bottom
 * sheet on a phone.
 */
import { Disposable } from "@lib/disposable";
import { isPhoneLayout, openBottomSheet, type BottomSheet } from "@lib/ui/bottomSheet";
import { setOwnedTimeout } from "@lib/dom";
import { listCustomEmoji } from "@stores/emoji.store";
import { composerButtonShown } from "../composerButtons";
import { currentUserRoleHasPermission } from "@lib/permissions";
import { Permission } from "@lib/types";
import {
  createExpressionPopup,
  type ExpressionPanel,
  type ExpressionPopup,
  type ExpressionTab,
} from "./ExpressionPopup";
import { stickersText } from "../../../i18n/stickers";
import {
  emojiPickerScreen,
  gifPickerScreen,
  stickerPickerScreen,
  SEND_DEBOUNCE_MS,
  markGifUnavailable,
} from "./inputShared";
import type { InputState, InputApi } from "./inputState";

/** The buttons the popup's tabs belong to. */
export interface PopupButtons {
  readonly attachBtn: HTMLButtonElement;
  readonly emojiBtn: HTMLButtonElement;
  readonly gifBtn: HTMLButtonElement;
  readonly stickerBtn: HTMLButtonElement | null;
  readonly hasPlusMenu: boolean;
}

/** Wires the three buttons to the popup and registers its teardown on `st`. */
export function wireExpressionPopup(st: InputState, api: InputApi, buttons: PopupButtons): void {
  const { attachBtn, emojiBtn, gifBtn, stickerBtn, hasPlusMenu } = buttons;
  // The GIF, sticker and emoji buttons share one tabbed popup. Each
  // button opens it on its own tab; the active tab's button closes it.
  let popup: ExpressionPopup | null = null;
  // One outside-click owner for the open popup, destroyed when it closes.
  let popupDismiss: Disposable | null = null;
  // On a phone the popup lives in a bottom sheet instead, which owns dismissal.
  let popupSheet: BottomSheet | null = null;

  function tabButton(tab: ExpressionTab): HTMLButtonElement | null {
    if (tab === "gif") return gifBtn;
    return tab === "sticker" ? stickerBtn : emojiBtn;
  }

  /** Close the popup (a no-op when closed). Escape hands focus back to the button of the tab it was on. */
  function closePopup(returnFocus = false): void {
    const closing = popup;
    if (closing === null) return;
    const tab = closing.activeTab();
    popup = null;
    popupDismiss?.destroy();
    popupDismiss = null;
    const sheet = popupSheet;
    popupSheet = null;
    sheet?.close();
    closing.element.remove();
    closing.destroy();
    if (!returnFocus) return;
    const btn = tabButton(tab);
    // A button the user hid in settings (or the phone row left out) cannot
    // take focus; "+" (where Sticker lives), the phone's one expression
    // button or the textarea can.
    if (btn !== null && !btn.hidden) btn.focus();
    else if (tab === "sticker" && hasPlusMenu && !isPhoneLayout()) attachBtn.focus();
    else if (!emojiBtn.hidden) emojiBtn.focus();
    else st.textarea?.focus();
  }

  function handlePopupClickOutside(e: MouseEvent): void {
    if (popup === null) return;
    const target = e.target as Node;
    if ((target as Element).closest?.(".modal-overlay")) return;
    if (popup.element.contains(target)) return;
    for (const tab of ["gif", "sticker", "emoji"] as const) {
      const btn = tabButton(tab);
      if (btn !== null && (target === btn || btn.contains(target))) return;
    }
    closePopup();
  }

  /** Send a picked sticker at once, under the same gates as a GIF. */
  function sendPickedSticker(sticker: { readonly id: number; readonly name: string }): void {
    const refusal = st.disabledReason ?? st.sendGateReason;
    if (refusal !== null) {
      api.showUploadError(refusal);
      return;
    }
    const now = Date.now();
    if (now - st.lastSendTime < SEND_DEBOUNCE_MS) return;
    st.lastSendTime = now;
    st.options.onSendSticker?.(sticker, st.state.replyTo?.messageId ?? null, api.replyPing());
    api.clearReply();
  }

  /** Build the picker for a tab, loading its code on first use. */
  async function buildPanel(tab: ExpressionTab): Promise<ExpressionPanel | null> {
    const wanted = (): boolean => popup === null || popup.activeTab() === tab;
    if (tab === "emoji") {
      const screen = await emojiPickerScreen.load(wanted);
      if (screen === null) return null;
      return screen.createEmojiPicker({
        // Read the set at open time, not at mount: an emoji_update while the
        // composer is alive must be in the next picker the user opens.
        customEmoji: listCustomEmoji(),
        onSelect: (emoji: string, select) => {
          const keepOpen = select?.keepOpen === true;
          if (st.textarea !== null) {
            const start = st.textarea.selectionStart;
            const end = st.textarea.selectionEnd;
            const before = st.textarea.value.slice(0, start);
            const after = st.textarea.value.slice(end);
            st.textarea.value = before + emoji + after;
            st.textarea.selectionStart = st.textarea.selectionEnd = start + emoji.length;
            // Shift-pick keeps focus in the picker so the next pick lands at
            // the caret just advanced.
            if (!keepOpen) st.textarea.focus();
          }
          if (!keepOpen) closePopup();
        },
        onClose: () => closePopup(true),
      });
    }
    if (tab === "sticker") {
      const screen = await stickerPickerScreen.load(wanted);
      if (screen === null) return null;
      return screen.createStickerPicker({
        canManage: currentUserRoleHasPermission(Permission.MANAGE_SERVER),
        onSelect: (sticker) => {
          sendPickedSticker(sticker);
          closePopup();
        },
        onClose: () => closePopup(true),
      });
    }
    const gifApi = st.options.gifApi;
    if (gifApi === undefined) return null;
    const screen = await gifPickerScreen.load(wanted);
    if (screen === null) return null;
    return screen.createGifPicker({
      api: gifApi,
      onUnavailable: (reason: string) => {
        st.gifUnavailable = true;
        markGifUnavailable(gifBtn, reason);
      },
      onSelect: (gifUrl: string) => {
        // Send the GIF directly instead of routing it through the textarea
        // (handleSend's read of textarea.value): that overwrote — and
        // discarded — whatever draft the user had typed, and on slow
        // mode / mid-upload / debounced sends left the raw GIF URL sitting
        // in the composer instead of the draft. Guarded by the same
        // refusal/debounce checks as a normal send; an in-progress
        // edit and any typed draft are left untouched.
        const refusal = st.disabledReason ?? st.sendGateReason;
        if (refusal !== null) {
          api.showUploadError(refusal);
        } else {
          const now = Date.now();
          if (now - st.lastSendTime >= SEND_DEBOUNCE_MS) {
            st.lastSendTime = now;
            st.options.onSend(gifUrl, st.state.replyTo?.messageId ?? null, [], [], api.replyPing());
            api.clearReply();
          }
        }
        closePopup();
      },
      onClose: () => closePopup(true),
    });
  }

  function openPopup(tab: ExpressionTab): void {
    // The tabs on offer: no GIF tab where GIFs are off, no sticker tab where
    // the server has none.
    const tabs: ExpressionTab[] = [];
    if (st.options.gifApi !== undefined && !st.gifUnavailable) tabs.push("gif");
    if (stickerBtn !== null) tabs.push("sticker");
    tabs.push("emoji");
    if (!tabs.includes(tab)) return;
    const opened = createExpressionPopup({
      tabs,
      initial: tab,
      mountPanel: buildPanel,
      onClose: () => closePopup(true),
    });
    popup = opened;
    if (isPhoneLayout()) {
      opened.element.classList.add("in-sheet");
      const sheet = openBottomSheet({
        label: stickersText("popup.label"),
        content: opened.element,
        size: "tall",
        className: "picker-sheet",
        testId: "expression-sheet",
        focusFirst: false,
        signal: st.signal,
        onClosed: () => {
          if (popupSheet === sheet) closePopup();
        },
      });
      popupSheet = sheet;
      opened.element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
      return;
    }
    st.root?.appendChild(opened.element);
    // Focus starts inside the popup, so Escape closes it even before the
    // lazy picker has mounted and moved focus to its search box.
    opened.element.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    const dismiss = new Disposable();
    popupDismiss = dismiss;
    // Defer so the click that opened the popup doesn't immediately close it.
    setOwnedTimeout(
      dismiss.signal,
      () =>
        document.addEventListener("mousedown", handlePopupClickOutside, {
          signal: dismiss.signal,
        }),
      0,
    );
  }

  function toggleTab(tab: ExpressionTab): void {
    if (popup === null) {
      openPopup(tab);
    } else if (popup.activeTab() === tab) {
      closePopup();
    } else {
      popup.showTab(tab);
    }
  }

  // On a phone the smiley holds the emoji and sticker tabs: it opens on
  // the first of them the user keeps.
  const expressionTab = (): ExpressionTab => {
    if (!isPhoneLayout() || composerButtonShown("emoji")) return "emoji";
    return stickerBtn !== null && composerButtonShown("sticker") ? "sticker" : "emoji";
  };
  emojiBtn.addEventListener("click", () => toggleTab(expressionTab()), { signal: st.signal });
  gifBtn.addEventListener("click", () => toggleTab("gif"), { signal: st.signal });
  stickerBtn?.addEventListener("click", () => toggleTab("sticker"), { signal: st.signal });

  st.togglePickerOf = (kind) => {
    const btn = tabButton(kind);
    if (btn === null || btn.disabled) return;
    toggleTab(kind);
  };

  // Store picker cleanup for destroy()
  st.cleanupPickers = () => {
    closePopup();
    api.closeSlashPopup();
    api.closeMentionPopup();
    api.closeChannelPopup();
    api.closeEmojiPopup();
  };
}
