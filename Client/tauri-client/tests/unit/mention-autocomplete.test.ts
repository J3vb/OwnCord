/**
 * MentionAutocomplete — filtering, the MENTION_EVERYONE gate on the broadcast
 * entries, keyboard navigation, and composer integration.
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

import {
  createMentionAutocomplete,
  filterMentionSuggestions,
  MAX_MENTION_SUGGESTIONS,
} from "../../src/components/MentionAutocomplete";
import { createMessageInput } from "../../src/components/MessageInput";
import { membersStore } from "../../src/stores/members.store";
import { authStore } from "../../src/stores/auth.store";
import { channelsStore, setRoles } from "../../src/stores/channels.store";
import { Permission } from "../../src/lib/types";

const NAMES = ["alice", "Alan", "Bob", "carol"];

function seedMembers(names: readonly string[] = NAMES): void {
  membersStore.setState(() => ({
    members: new Map(
      names.map((n, i) => [
        i + 1,
        {
          id: i + 1,
          username: n,
          avatar: null,
          role: "member" as const,
          status: "online" as const,
        },
      ]),
    ),
    typingUsers: new Map(),
  }));
}

/** Sign in as a role, and register that role's permission mask. */
function signInAs(role: string, permissions: number): void {
  authStore.setState(() => ({
    token: "t",
    user: { id: 99, username: "me", avatar: null, role },
    serverName: null,
    motd: null,
    isAuthenticated: true,
  }));
  channelsStore.setState(() => ({ channels: new Map(), activeChannelId: null, roles: [] }));
  setRoles([{ id: 1, name: role, color: null, permissions }]);
  channelsStore.flush();
}

beforeEach(() => {
  seedMembers();
  signInAs("member", Permission.SEND_MESSAGES);
});

describe("filterMentionSuggestions", () => {
  it("lists every member for an empty query", () => {
    expect(filterMentionSuggestions("").map((s) => s.token)).toEqual([
      "Alan",
      "alice",
      "Bob",
      "carol",
    ]);
  });

  it("filters case-insensitively", () => {
    expect(filterMentionSuggestions("AL").map((s) => s.token)).toEqual(["Alan", "alice"]);
  });

  it("ranks prefix matches above substring matches", () => {
    seedMembers(["bob", "abbot"]);
    expect(filterMentionSuggestions("b").map((s) => s.token)).toEqual(["bob", "abbot"]);
  });

  it("returns nothing when no member matches", () => {
    expect(filterMentionSuggestions("zzz")).toEqual([]);
  });

  it("caps the list", () => {
    seedMembers(Array.from({ length: 40 }, (_, i) => `user${String(i).padStart(2, "0")}`));
    expect(filterMentionSuggestions("user").length).toBe(MAX_MENTION_SUGGESTIONS);
  });

  it("omits @everyone/@here without MENTION_EVERYONE", () => {
    const tokens = filterMentionSuggestions("").map((s) => s.token);
    expect(tokens).not.toContain("everyone");
    expect(tokens).not.toContain("here");
  });

  it("offers @everyone/@here first when the role holds MENTION_EVERYONE", () => {
    signInAs("mod", Permission.SEND_MESSAGES | Permission.MENTION_EVERYONE);
    const tokens = filterMentionSuggestions("").map((s) => s.token);
    expect(tokens.slice(0, 2)).toEqual(["everyone", "here"]);
  });

  it("filters the broadcast entries by prefix too", () => {
    signInAs("mod", Permission.MENTION_EVERYONE);
    expect(filterMentionSuggestions("her").map((s) => s.token)).toEqual(["here"]);
    expect(filterMentionSuggestions("every").map((s) => s.token)).toEqual(["everyone"]);
  });

  it("offers broadcasts to an administrator implicitly", () => {
    signInAs("owner", Permission.ADMINISTRATOR);
    expect(filterMentionSuggestions("every").map((s) => s.token)).toEqual(["everyone"]);
  });
});

describe("createMentionAutocomplete", () => {
  let onSelect: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;
  let popup: ReturnType<typeof createMentionAutocomplete>;

  beforeEach(() => {
    onSelect = vi.fn();
    onClose = vi.fn();
    popup = createMentionAutocomplete({ onSelect, onClose });
    document.body.appendChild(popup.element);
  });

  afterEach(() => {
    popup.destroy();
  });

  function key(k: string): KeyboardEvent {
    return new KeyboardEvent("keydown", { key: k, cancelable: true });
  }

  function labels(): string[] {
    return Array.from(popup.element.querySelectorAll(".ma-name")).map((e) => e.textContent ?? "");
  }

  it("renders one row per suggestion, first row active", () => {
    popup.setQuery("al");
    expect(labels()).toEqual(["@Alan", "@alice"]);
    expect(popup.element.querySelectorAll(".ma-item--active").length).toBe(1);
    expect(popup.element.querySelector(".ma-item")?.classList.contains("ma-item--active")).toBe(
      true,
    );
  });

  it("reports no match so the composer can close it", () => {
    expect(popup.setQuery("zzz")).toBe(false);
    expect(labels()).toEqual([]);
  });

  it("moves the selection with ArrowDown and wraps", () => {
    popup.setQuery("al");
    popup.handleKeydown(key("ArrowDown"));
    expect(popup.element.querySelectorAll(".ma-item")[1]?.getAttribute("aria-selected")).toBe(
      "true",
    );
    popup.handleKeydown(key("ArrowDown"));
    expect(popup.element.querySelectorAll(".ma-item")[0]?.getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("wraps backwards with ArrowUp", () => {
    popup.setQuery("al");
    popup.handleKeydown(key("ArrowUp"));
    expect(popup.element.querySelectorAll(".ma-item")[1]?.getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("selects the active row on Enter", () => {
    popup.setQuery("al");
    popup.handleKeydown(key("ArrowDown"));
    expect(popup.handleKeydown(key("Enter"))).toBe(true);
    expect(onSelect).toHaveBeenCalledWith("alice");
  });

  it("selects on Tab as well", () => {
    popup.setQuery("bo");
    popup.handleKeydown(key("Tab"));
    expect(onSelect).toHaveBeenCalledWith("Bob");
  });

  it("closes on Escape without selecting", () => {
    popup.setQuery("al");
    expect(popup.handleKeydown(key("Escape"))).toBe(true);
    expect(onClose).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("consumes nothing while empty, so the composer keeps its keys", () => {
    popup.setQuery("zzz");
    expect(popup.handleKeydown(key("Enter"))).toBe(false);
    expect(popup.handleKeydown(key("ArrowDown"))).toBe(false);
  });

  it("passes ordinary keys through", () => {
    popup.setQuery("al");
    expect(popup.handleKeydown(key("a"))).toBe(false);
  });

  it("selects on mousedown without stealing focus", () => {
    popup.setQuery("bo");
    const row = popup.element.querySelector(".ma-item") as HTMLElement;
    const ev = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    row.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(onSelect).toHaveBeenCalledWith("Bob");
  });

  it("removes its element on destroy", () => {
    popup.destroy();
    expect(popup.element.parentNode).toBeNull();
  });
});

describe("composer integration", () => {
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
    return container.querySelector(".mention-autocomplete");
  }

  function press(k: string): boolean {
    const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    textarea().dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  it("opens the popup on a bare @", () => {
    type("hello @");
    expect(popupEl()).not.toBeNull();
  });

  it("does not open for an email-shaped @", () => {
    type("mail@ali");
    expect(popupEl()).toBeNull();
  });

  it("closes once the query matches nobody", () => {
    type("@al");
    expect(popupEl()).not.toBeNull();
    type("@alzzz");
    expect(popupEl()).toBeNull();
  });

  it("closes when the caret leaves the token", () => {
    type("@al");
    type("@al hello");
    expect(popupEl()).toBeNull();
  });

  it("inserts the picked username and a trailing space", () => {
    type("hey @al");
    press("Enter");
    expect(textarea().value).toBe("hey @Alan ");
    expect(onSend).not.toHaveBeenCalled();
    expect(popupEl()).toBeNull();
  });

  it("keeps text after the caret intact", () => {
    const ta = textarea();
    ta.value = "hey @al world";
    ta.selectionStart = 7;
    ta.selectionEnd = 7;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    press("Enter");
    expect(ta.value).toBe("hey @Alan  world");
  });

  it("lets Enter send once the popup is closed", () => {
    type("hey @al");
    press("Escape");
    expect(popupEl()).toBeNull();
    press("Enter");
    expect(onSend).toHaveBeenCalledWith("hey @al", null, []);
  });

  it("navigates with the arrow keys before inserting", () => {
    type("@al");
    press("ArrowDown");
    press("Enter");
    expect(textarea().value).toBe("@alice ");
  });

  it("does not open while the composer is disabled", () => {
    input.setDisabled("Read-only");
    type("@al");
    expect(popupEl()).toBeNull();
  });

  it("closes on blur", () => {
    type("@al");
    textarea().dispatchEvent(new FocusEvent("blur"));
    expect(popupEl()).toBeNull();
  });
});
