/**
 * EmojiAutocomplete — filtering across the custom and unicode sources, the
 * minimum-query rule, keyboard navigation, and composer integration (including
 * how it shares the composer with the @-mention popup).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@lib/livekitSession", () => ({
  leaveVoice: vi.fn(),
  switchInputDevice: vi.fn(),
  switchOutputDevice: vi.fn(),
  setVoiceSensitivity: vi.fn(),
  setInputVolume: vi.fn(),
  setOutputVolume: vi.fn(),
  getSessionDebugInfo: vi.fn().mockReturnValue({}),
}));

const { fetchImageAsDataUrlMock } = vi.hoisted(() => ({
  fetchImageAsDataUrlMock: vi.fn(() => Promise.resolve("data:image/png;base64,AAAA")),
}));
vi.mock("../../src/components/message-list/attachments", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/components/message-list/attachments")>();
  return { ...actual, fetchImageAsDataUrl: fetchImageAsDataUrlMock };
});

import {
  createEmojiAutocomplete,
  filterEmojiSuggestions,
  MAX_EMOJI_SUGGESTIONS,
  MIN_EMOJI_QUERY,
} from "../../src/components/EmojiAutocomplete";
import { createMessageInput } from "../../src/components/MessageInput";
import { emojiStore, setCustomEmoji, clearCustomEmoji } from "../../src/stores/emoji.store";
import { membersStore } from "../../src/stores/members.store";

const EMOJI = [
  { id: 1, shortcode: "wave", url: "/api/v1/emoji/1/image" },
  { id: 2, shortcode: "waffle", url: "/api/v1/emoji/2/image" },
  { id: 3, shortcode: "blob_wave", url: "/api/v1/emoji/3/image" },
];

beforeEach(() => {
  clearCustomEmoji();
  emojiStore.flush();
  setCustomEmoji(EMOJI);
  emojiStore.flush();
  membersStore.setState(() => ({ members: new Map(), typingUsers: new Map() }));
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe("filterEmojiSuggestions", () => {
  it("returns nothing below the minimum query length", () => {
    expect(filterEmojiSuggestions("")).toEqual([]);
    expect(filterEmojiSuggestions("w")).toEqual([]);
    expect(MIN_EMOJI_QUERY).toBe(2);
  });

  it("offers custom emoji before unicode ones", () => {
    const out = filterEmojiSuggestions("wa");
    expect(out.length).toBeGreaterThan(0);
    const firstUnicode = out.findIndex((s) => s.kind === "unicode");
    const lastCustom = out.map((s) => s.kind).lastIndexOf("custom");
    expect(lastCustom).toBeGreaterThanOrEqual(0);
    if (firstUnicode !== -1) expect(lastCustom).toBeLessThan(firstUnicode);
  });

  it("ranks a shortcode prefix above a shortcode substring", () => {
    const labels = filterEmojiSuggestions("wa")
      .filter((s) => s.kind === "custom")
      .map((s) => s.label);
    // waffle and wave start with "wa"; blob_wave only contains it.
    expect(labels.indexOf("blob_wave")).toBeGreaterThan(labels.indexOf("wave"));
    expect(labels.indexOf("blob_wave")).toBeGreaterThan(labels.indexOf("waffle"));
  });

  it("inserts :shortcode: for a custom emoji and the character for a unicode one", () => {
    const custom = filterEmojiSuggestions("wave").find((s) => s.kind === "custom");
    expect(custom?.label).toBe("wave");
    expect(custom?.insert).toBe(":wave:");
    expect(custom?.char).toBeNull();
    expect(custom?.emoji?.id).toBe(1);

    const fire = filterEmojiSuggestions("fire").find((s) => s.kind === "unicode");
    expect(fire?.insert).toBe("🔥");
    expect(fire?.emoji).toBeNull();
  });

  it("searches the unicode keyword list, not just primary names", () => {
    const out = filterEmojiSuggestions("flame");
    expect(out.some((s) => s.insert === "🔥")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(filterEmojiSuggestions("WAVE").some((s) => s.insert === ":wave:")).toBe(true);
  });

  it("caps the number of rows", () => {
    // "a" appears in most keyword strings; the two-character "ar" still matches
    // far more than the cap.
    expect(filterEmojiSuggestions("ar").length).toBeLessThanOrEqual(MAX_EMOJI_SUGGESTIONS);
  });

  it("returns nothing for a query nothing matches", () => {
    expect(filterEmojiSuggestions("zzzzqqq")).toEqual([]);
  });

  it("offers no custom emoji when the server has none", () => {
    clearCustomEmoji();
    emojiStore.flush();
    expect(filterEmojiSuggestions("wave").every((s) => s.kind === "unicode")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

describe("createEmojiAutocomplete", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function mount(onSelect = vi.fn(), onClose = vi.fn()) {
    const ac = createEmojiAutocomplete({ onSelect, onClose });
    container.appendChild(ac.element);
    return { ac, onSelect, onClose };
  }

  it("renders one row per suggestion with a preview", () => {
    const { ac } = mount();
    expect(ac.setQuery("wave")).toBe(true);
    const rows = ac.element.querySelectorAll(".ma-item");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.querySelector(".ea-preview")).not.toBeNull();
    expect(rows[0]?.querySelector(".ea-preview img.custom-emoji")).not.toBeNull();
    expect(rows[0]?.querySelector(".ma-name")?.textContent).toBe(":wave:");
    expect(rows[0]?.querySelector(".ma-detail")?.textContent).toBe("Server emoji");
    ac.destroy();
  });

  it("shows the character itself as the preview for unicode rows", () => {
    const { ac } = mount();
    ac.setQuery("flame");
    const row = [...ac.element.querySelectorAll(".ma-item")].find(
      (r) => r.querySelector(".ea-preview")?.textContent === "🔥",
    );
    expect(row).toBeDefined();
    ac.destroy();
  });

  it("setQuery returns false and renders nothing when nothing matches", () => {
    const { ac } = mount();
    expect(ac.setQuery("zzzzqqq")).toBe(false);
    expect(ac.element.querySelectorAll(".ma-item").length).toBe(0);
    ac.destroy();
  });

  it("selects the active row on Enter", () => {
    const { ac, onSelect } = mount();
    ac.setQuery("wave");
    const ev = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    expect(ac.handleKeydown(ev)).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(":wave:");
    ac.destroy();
  });

  it("moves the active row with the arrow keys", () => {
    const { ac, onSelect } = mount();
    ac.setQuery("wa");
    // Custom rows sort alphabetically, so ":waffle:" leads and ":wave:" follows.
    ac.handleKeydown(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    ac.handleKeydown(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(":wave:");
    ac.destroy();
  });

  it("wraps around at the ends", () => {
    const { ac, onSelect } = mount();
    ac.setQuery("wa");
    const count = ac.element.querySelectorAll(".ma-item").length;
    // A full lap of ArrowDown lands back on the first row.
    for (let i = 0; i < count; i++) {
      ac.handleKeydown(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    }
    ac.handleKeydown(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    expect(onSelect).toHaveBeenCalledWith(":waffle:");
    ac.destroy();
  });

  it("ArrowUp from the first row wraps to the last", () => {
    const { ac, onSelect } = mount();
    ac.setQuery("wa");
    const labels = [...ac.element.querySelectorAll(".ma-item .ma-name")].map((n) => n.textContent);
    ac.handleKeydown(new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true }));
    ac.handleKeydown(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    const last = labels[labels.length - 1];
    expect(onSelect).toHaveBeenCalledTimes(1);
    // Custom rows render as ":name:", which is also what they insert.
    if (last?.startsWith(":")) expect(onSelect).toHaveBeenCalledWith(last);
    ac.destroy();
  });

  it("closes on Escape", () => {
    const { ac, onClose } = mount();
    ac.setQuery("wave");
    expect(
      ac.handleKeydown(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })),
    ).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    ac.destroy();
  });

  it("consumes no keys while empty", () => {
    const { ac } = mount();
    ac.setQuery("zzzzqqq");
    expect(ac.handleKeydown(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }))).toBe(
      false,
    );
    ac.destroy();
  });

  it("selects on mousedown so the textarea keeps focus", () => {
    const { ac, onSelect } = mount();
    ac.setQuery("wave");
    const row = ac.element.querySelector(".ma-item") as HTMLElement;
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledWith(":wave:");
    ac.destroy();
  });

  it("destroy detaches the listeners", () => {
    const { ac, onSelect } = mount();
    ac.setQuery("wave");
    const row = ac.element.querySelector(".ma-item") as HTMLElement;
    ac.destroy();
    row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("stamps a stable id on the listbox and index ids on the rows", () => {
    const { ac } = mount();
    ac.setQuery("wa");
    expect(ac.element.id).toBe("emoji-autocomplete");
    const ids = [...ac.element.querySelectorAll(".ma-item")].map((r) => r.id);
    expect(ids.length).toBeGreaterThan(1);
    ids.forEach((id, i) => expect(id).toBe(`emoji-autocomplete-option-${i}`));
    // A re-render rebuilds the rows, so the ids stay index-based, not stale.
    ac.setQuery("flame");
    expect(ac.element.querySelector(".ma-item")?.id).toBe("emoji-autocomplete-option-0");
    ac.destroy();
  });
});

// ---------------------------------------------------------------------------
// Combobox wiring
// ---------------------------------------------------------------------------

describe("createEmojiAutocomplete combobox wiring", () => {
  let ta: HTMLTextAreaElement;
  let ac: ReturnType<typeof createEmojiAutocomplete>;

  beforeEach(() => {
    ta = document.createElement("textarea");
    document.body.appendChild(ta);
    ac = createEmojiAutocomplete({ onSelect: vi.fn(), onClose: vi.fn(), comboboxInput: ta });
    document.body.appendChild(ac.element);
  });

  afterEach(() => {
    ac.destroy();
    ta.remove();
  });

  function key(k: string): KeyboardEvent {
    return new KeyboardEvent("keydown", { key: k, cancelable: true });
  }

  it("stamps combobox semantics on the input, without an active row yet", () => {
    expect(ta.getAttribute("role")).toBe("combobox");
    expect(ta.getAttribute("aria-autocomplete")).toBe("list");
    expect(ta.getAttribute("aria-expanded")).toBe("true");
    expect(ta.getAttribute("aria-controls")).toBe("emoji-autocomplete");
    // Emoji do not prime on create, so no row exists to point at yet.
    expect(ta.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("aims aria-activedescendant at the active row and follows the arrows", () => {
    ac.setQuery("wa");
    expect(ta.getAttribute("aria-activedescendant")).toBe("emoji-autocomplete-option-0");
    ac.handleKeydown(key("ArrowDown"));
    expect(ta.getAttribute("aria-activedescendant")).toBe("emoji-autocomplete-option-1");
    ac.handleKeydown(key("ArrowUp"));
    expect(ta.getAttribute("aria-activedescendant")).toBe("emoji-autocomplete-option-0");
  });

  it("clears aria-activedescendant when nothing matches", () => {
    ac.setQuery("wa");
    ac.setQuery("zzzzqqq");
    expect(ta.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("removes every combobox attribute on destroy", () => {
    ac.setQuery("wa");
    ac.destroy();
    for (const attr of [
      "role",
      "aria-autocomplete",
      "aria-expanded",
      "aria-controls",
      "aria-activedescendant",
    ]) {
      expect(ta.hasAttribute(attr)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Composer integration
// ---------------------------------------------------------------------------

describe("composer :shortcode integration", () => {
  let container: HTMLDivElement;
  let input: ReturnType<typeof createMessageInput>;
  let onSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    onSend = vi.fn();
    input = createMessageInput({
      channelId: 1,
      channelName: "general",
      onSend,
      onTyping: vi.fn(),
      onEditMessage: vi.fn(),
    });
    input.mount(container);
  });

  afterEach(() => {
    input.destroy?.();
    container.remove();
  });

  function textarea(): HTMLTextAreaElement {
    return container.querySelector("textarea")!;
  }

  function type(value: string): void {
    const ta = textarea();
    ta.value = value;
    ta.selectionStart = value.length;
    ta.selectionEnd = value.length;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function popupEl(): HTMLElement | null {
    return container.querySelector(".emoji-autocomplete");
  }

  function press(k: string): void {
    textarea().dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
    );
  }

  it("opens after a colon plus two characters", () => {
    type("hello :w");
    expect(popupEl()).toBeNull();
    type("hello :wa");
    expect(popupEl()).not.toBeNull();
  });

  it("does not open for a colon inside a word", () => {
    type("note:wa");
    expect(popupEl()).toBeNull();
  });

  it("does not open for a URL scheme", () => {
    type("https://ex");
    expect(popupEl()).toBeNull();
  });

  it("closes once the query matches nothing", () => {
    type(":wa");
    expect(popupEl()).not.toBeNull();
    type(":wazzzqqq");
    expect(popupEl()).toBeNull();
  });

  it("closes when the caret leaves the token", () => {
    type(":wa");
    type(":wa hello");
    expect(popupEl()).toBeNull();
  });

  it("inserts the shortcode and a trailing space instead of sending", () => {
    type("hey :wave");
    press("Enter");
    expect(textarea().value).toBe("hey :wave: ");
    expect(onSend).not.toHaveBeenCalled();
    expect(popupEl()).toBeNull();
  });

  it("inserts the unicode character for a unicode row", () => {
    type("hey :flame");
    press("Enter");
    expect(textarea().value).toBe("hey 🔥 ");
  });

  it("Escape closes the popup without sending", () => {
    type(":wave");
    press("Escape");
    expect(popupEl()).toBeNull();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("does not open while the composer is disabled", () => {
    input.setDisabled("read-only");
    type(":wave");
    expect(popupEl()).toBeNull();
  });

  it("closes on blur", () => {
    type(":wave");
    expect(popupEl()).not.toBeNull();
    textarea().dispatchEvent(new FocusEvent("blur"));
    expect(popupEl()).toBeNull();
  });

  it("yields to the @-mention popup rather than stacking on it", () => {
    membersStore.setState(() => ({
      members: new Map([
        [
          1,
          { id: 1, username: "wave_guy", avatar: null, role: "member", status: "online" as const },
        ],
      ]),
      typingUsers: new Map(),
    }));
    type("@wa");
    expect(
      container.querySelector(".mention-autocomplete:not(.emoji-autocomplete)"),
    ).not.toBeNull();
    expect(popupEl()).toBeNull();
  });

  it("marks the textarea as a combobox while open and clears it on close", () => {
    type(":wave");
    const ta = textarea();
    expect(ta.getAttribute("role")).toBe("combobox");
    expect(ta.getAttribute("aria-expanded")).toBe("true");
    expect(ta.getAttribute("aria-controls")).toBe("emoji-autocomplete");
    expect(ta.getAttribute("aria-activedescendant")).toBe("emoji-autocomplete-option-0");
    press("Escape");
    expect(ta.hasAttribute("role")).toBe(false);
    expect(ta.hasAttribute("aria-expanded")).toBe(false);
    expect(ta.hasAttribute("aria-controls")).toBe(false);
    expect(ta.hasAttribute("aria-activedescendant")).toBe(false);
  });

  it("hands the combobox state over when the @-mention popup takes the caret", () => {
    membersStore.setState(() => ({
      members: new Map([
        [
          1,
          { id: 1, username: "wave_guy", avatar: null, role: "member", status: "online" as const },
        ],
      ]),
      typingUsers: new Map(),
    }));
    type(":wave");
    expect(textarea().getAttribute("aria-controls")).toBe("emoji-autocomplete");
    // The mention popup opens before the emoji popup is torn down, so the
    // teardown must not wipe the state the mention popup just stamped.
    type("@wa");
    const ta = textarea();
    expect(ta.getAttribute("role")).toBe("combobox");
    expect(ta.getAttribute("aria-controls")).toBe("mention-autocomplete");
    expect(ta.getAttribute("aria-activedescendant")).toBe("mention-autocomplete-option-0");
  });
});
