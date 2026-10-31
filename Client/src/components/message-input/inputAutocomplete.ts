/**
 * Autocomplete in the message input: the @mention, :emoji:, #channel and
 * /command popups and what each inserts.
 */
import { createMentionAutocomplete } from "@components/MentionAutocomplete";
import { createEmojiAutocomplete, MIN_EMOJI_QUERY } from "@components/EmojiAutocomplete";
import { createChannelAutocomplete } from "@components/ChannelAutocomplete";
import { emojiCatalog, loadEmojiCatalog } from "../../features/messaging/emojiCatalog";
import { createSlashAutocomplete } from "@components/SlashAutocomplete";
import { idMentionsEnabled } from "@lib/net/serverCapabilities";
import type { InputState, InputApi } from "./inputState";

export function createInputAutocomplete(st: InputState, api: InputApi) {
  /**
   * The @token immediately before the caret, or null. The leading boundary
   * mirrors the server's mention rule, so the popup never offers a completion
   * for text ("mail@dom") that a send would not resolve as a mention.
   */
  function activeMentionToken(): { query: string; start: number } | null {
    if (st.textarea === null) return null;
    const caret = st.textarea.selectionStart;
    const before = st.textarea.value.slice(0, caret);
    const match = /(?:^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_.-]{0,64})$/u.exec(before);
    if (match === null) return null;
    const query = match[1] ?? "";
    return { query, start: caret - query.length - 1 };
  }

  function closeMentionPopup(): void {
    if (st.mentionPopup === null) return;
    st.mentionPopup.destroy();
    st.mentionPopup = null;
    st.mentionStart = -1;
    st.pendingPick = null;
  }

  /** Remember that the text `@token` stands for the picked user or role. */
  function recordPick(token: string): void {
    const pick = st.pendingPick;
    st.pendingPick = null;
    if (pick === null || pick.token !== token || !idMentionsEnabled()) return;
    const id = pick.kind === "role" ? pick.roleId : pick.userId;
    if (id === null) return;
    const picked = { text: `@${token}`, token: pick.kind === "role" ? `<@&${id}>` : `<@${id}>` };
    if (!st.pickedMentions.some((p) => p.text === picked.text && p.token === picked.token)) {
      st.pickedMentions.push(picked);
    }
  }

  /** Replace the token under the caret with "@token ". */
  function insertMention(token: string): void {
    // The popup can outlive the token it was opened over: a caret move the
    // composer never observed (Ctrl+A, a programmatic selection) leaves
    // mentionStart pointing at an offset the caret no longer follows, and
    // splicing there garbles the draft instead of completing it. Re-derive
    // the token and only commit while it still starts where the popup thinks.
    const active = activeMentionToken();
    if (
      st.textarea === null ||
      st.mentionStart < 0 ||
      active === null ||
      active.start !== st.mentionStart
    ) {
      closeMentionPopup();
      return;
    }
    const caret = st.textarea.selectionStart;
    const before = st.textarea.value.slice(0, st.mentionStart);
    const after = st.textarea.value.slice(caret);
    const inserted = `@${token} `;
    st.textarea.value = before + inserted + after;
    recordPick(token);
    const pos = before.length + inserted.length;
    st.textarea.selectionStart = pos;
    st.textarea.selectionEnd = pos;
    closeMentionPopup();
    api.autoResize();
    st.textarea.focus();
  }

  /**
   * The `:token` immediately before the caret, or null. The leading boundary
   * keeps the popup out of ordinary prose: a colon that follows a word ("see
   * this:thing", a "10:30" clock, an "http://" scheme) is punctuation, not the
   * start of a shortcode. A completed `:token:` is skipped too — it is already
   * an emoji, and re-offering completions over it would fight the user.
   */
  function activeEmojiToken(): { query: string; start: number } | null {
    if (st.textarea === null) return null;
    const caret = st.textarea.selectionStart;
    const before = st.textarea.value.slice(0, caret);
    const match = /(?:^|\s):([A-Za-z0-9_]{0,32})$/.exec(before);
    if (match === null) return null;
    const query = match[1] ?? "";
    if (query.length < MIN_EMOJI_QUERY) return null;
    return { query, start: caret - query.length - 1 };
  }

  function closeEmojiPopup(): void {
    if (st.emojiPopup === null) return;
    st.emojiPopup.destroy();
    st.emojiPopup = null;
    st.emojiStart = -1;
  }

  /** Replace the `:token` under the caret with the chosen emoji, plus a space. */
  function insertEmoji(insert: string): void {
    // Same staleness guard as insertMention: never splice at an anchor the
    // caret has since moved away from.
    const active = activeEmojiToken();
    if (
      st.textarea === null ||
      st.emojiStart < 0 ||
      active === null ||
      active.start !== st.emojiStart
    ) {
      closeEmojiPopup();
      return;
    }
    const caret = st.textarea.selectionStart;
    const before = st.textarea.value.slice(0, st.emojiStart);
    const after = st.textarea.value.slice(caret);
    const inserted = `${insert} `;
    st.textarea.value = before + inserted + after;
    const pos = before.length + inserted.length;
    st.textarea.selectionStart = pos;
    st.textarea.selectionEnd = pos;
    closeEmojiPopup();
    api.autoResize();
    st.textarea.focus();
  }

  /**
   * The `#token` immediately before the caret, or null. It opens only after
   * whitespace or at the start, so "C#" and "issue#12" stay text; a heading's
   * "# " closes it at the space.
   */
  function activeChannelToken(): { query: string; start: number } | null {
    if (st.textarea === null) return null;
    const caret = st.textarea.selectionStart;
    const before = st.textarea.value.slice(0, caret);
    const match = /(?:^|\s)#([\p{L}\p{N}_-]{0,64})$/u.exec(before);
    if (match === null) return null;
    const query = match[1] ?? "";
    return { query, start: caret - query.length - 1 };
  }

  function closeChannelPopup(): void {
    if (st.channelPopup === null) return;
    st.channelPopup.destroy();
    st.channelPopup = null;
    st.channelStart = -1;
  }

  /** Replace the `#token` under the caret with "#name ". */
  function insertChannel(name: string): void {
    // Same staleness guard as insertMention.
    const active = activeChannelToken();
    if (
      st.textarea === null ||
      st.channelStart < 0 ||
      active === null ||
      active.start !== st.channelStart
    ) {
      closeChannelPopup();
      return;
    }
    const caret = st.textarea.selectionStart;
    const before = st.textarea.value.slice(0, st.channelStart);
    const after = st.textarea.value.slice(caret);
    const inserted = `#${name} `;
    st.textarea.value = before + inserted + after;
    const pos = before.length + inserted.length;
    st.textarea.selectionStart = pos;
    st.textarea.selectionEnd = pos;
    closeChannelPopup();
    api.autoResize();
    st.textarea.focus();
  }

  function closeSlashPopup(): void {
    if (st.slashPopup === null) return;
    st.slashPopup.destroy();
    st.slashPopup = null;
  }

  /** The letters after a "/" when the draft is nothing but "/word", else null. */
  function activeSlashQuery(): string | null {
    if (st.textarea === null) return null;
    const match = /^\/([A-Za-z]*)$/.exec(st.textarea.value);
    return match === null ? null : (match[1] ?? "");
  }

  /** Replace the "/word" draft with "/name ". */
  function insertSlashCommand(name: string): void {
    if (st.textarea === null || activeSlashQuery() === null) {
      closeSlashPopup();
      return;
    }
    const inserted = `/${name} `;
    st.textarea.value = inserted;
    st.textarea.selectionStart = inserted.length;
    st.textarea.selectionEnd = inserted.length;
    closeSlashPopup();
    api.autoResize();
    st.textarea.focus();
  }

  /** Open, refilter, or close the slash-command popup for the current draft. */
  function syncSlashPopup(): void {
    const query = st.disabledReason === null ? activeSlashQuery() : null;
    if (query === null) {
      closeSlashPopup();
      return;
    }
    if (st.slashPopup === null) {
      st.slashPopup = createSlashAutocomplete({
        onSelect: insertSlashCommand,
        onClose: closeSlashPopup,
        comboboxInput: st.textarea ?? undefined,
      });
      st.root?.appendChild(st.slashPopup.element);
    }
    if (!st.slashPopup.setQuery(query)) {
      closeSlashPopup();
    }
  }

  /** Open, refilter, or close the channel popup for whatever is under the caret. */
  function syncChannelPopup(): void {
    const active = st.disabledReason === null ? activeChannelToken() : null;
    if (active === null) {
      closeChannelPopup();
      return;
    }
    if (st.channelPopup === null) {
      st.channelPopup = createChannelAutocomplete({
        onSelect: insertChannel,
        onClose: closeChannelPopup,
        comboboxInput: st.textarea ?? undefined,
      });
      st.root?.appendChild(st.channelPopup.element);
    }
    st.channelStart = active.start;
    if (!st.channelPopup.setQuery(active.query)) {
      closeChannelPopup();
    }
  }

  /** Open, refilter, or close the emoji popup for whatever is under the caret. */
  function syncEmojiPopup(): void {
    const active = st.disabledReason === null ? activeEmojiToken() : null;
    if (active === null) {
      closeEmojiPopup();
      return;
    }
    // The Unicode set is a lazy chunk: the first `:token` loads it, and the
    // popup re-syncs once it lands, so a Unicode-only match still opens. A
    // failed load leaves custom emoji only until the next keystroke retries.
    if (emojiCatalog() === null) {
      void loadEmojiCatalog().then(
        () => {
          if (!st.signal.aborted) syncEmojiPopup();
        },
        () => undefined,
      );
    }
    if (st.emojiPopup === null) {
      st.emojiPopup = createEmojiAutocomplete({
        onSelect: insertEmoji,
        onClose: closeEmojiPopup,
        // The popup manages combobox/aria-activedescendant state on the
        // textarea for as long as it is open.
        comboboxInput: st.textarea ?? undefined,
      });
      st.root?.appendChild(st.emojiPopup.element);
    }
    st.emojiStart = active.start;
    if (!st.emojiPopup.setQuery(active.query)) {
      closeEmojiPopup();
    }
  }

  /** Open, refilter, or close the popup for whatever is under the caret. */
  function syncMentionPopup(): void {
    const active = st.disabledReason === null ? activeMentionToken() : null;
    if (active === null) {
      closeMentionPopup();
      return;
    }
    if (st.mentionPopup === null) {
      st.mentionPopup = createMentionAutocomplete({
        onSelect: insertMention,
        onPick: (suggestion) => {
          st.pendingPick = suggestion;
        },
        onClose: closeMentionPopup,
        channelId: st.options.channelId,
        // The popup manages combobox/aria-activedescendant state on the
        // textarea for as long as it is open.
        comboboxInput: st.textarea ?? undefined,
      });
      st.root?.appendChild(st.mentionPopup.element);
    }
    st.mentionStart = active.start;
    if (!st.mentionPopup.setQuery(active.query)) {
      closeMentionPopup();
    }
  }

  /**
   * Drive both completion popups from one caret position. Only one can be open:
   * the caret sits in exactly one token, and two stacked popups over the same
   * textarea would race for the arrow keys.
   */
  function syncAutocomplete(): void {
    // A "/word" draft has no "@", "#" or ":" token, so the slash popup never
    // competes with the others; it only needs to leave them closed.
    syncSlashPopup();
    if (st.slashPopup !== null) {
      closeMentionPopup();
      closeChannelPopup();
      closeEmojiPopup();
      return;
    }
    syncMentionPopup();
    if (st.mentionPopup !== null) {
      closeChannelPopup();
      closeEmojiPopup();
      return;
    }
    syncChannelPopup();
    if (st.channelPopup !== null) {
      closeEmojiPopup();
      return;
    }
    syncEmojiPopup();
  }

  /** Insert `@username ` at the caret, spaced from a preceding word. */
  function insertMentionAtCaret(username: string): boolean {
    if (st.textarea === null || !api.canTakeText()) return false;
    const start = st.textarea.selectionStart;
    const end = st.textarea.selectionEnd;
    const before = st.textarea.value.slice(0, start);
    const after = st.textarea.value.slice(end);
    const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
    const inserted = `${lead}@${username} `;
    st.textarea.value = before + inserted + after;
    const pos = before.length + inserted.length;
    st.textarea.selectionStart = pos;
    st.textarea.selectionEnd = pos;
    api.autoResize();
    st.textarea.focus();
    return true;
  }

  return {
    activeMentionToken,
    closeMentionPopup,
    recordPick,
    insertMention,
    activeEmojiToken,
    closeEmojiPopup,
    insertEmoji,
    activeChannelToken,
    closeChannelPopup,
    insertChannel,
    closeSlashPopup,
    activeSlashQuery,
    insertSlashCommand,
    syncSlashPopup,
    syncChannelPopup,
    syncEmojiPopup,
    syncMentionPopup,
    syncAutocomplete,
    insertMentionAtCaret,
  };
}
