/**
 * Mentions of members whose name holds a space: listed and sent as an id token
 * where the server resolves ids, and a spaced query keeps the popup open.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from "vitest";
import * as voiceSession from "../helpers/voiceSessionMock";

vi.mock("../../src/features/voice/livekitSession", () => voiceSession.defaults());

import { filterMentionSuggestions } from "../../src/features/messaging/composer/MentionAutocomplete";
import { createMessageInput } from "../../src/features/messaging/MessageInput";
import type { MessageInputOptions } from "../../src/features/messaging/MessageInput";
import { resetMessagesStore } from "../../src/stores/messages.store";
import {
  applyReadyCapabilities,
  resetServerCapabilities,
} from "../../src/lib/net/serverCapabilities";
import { Permission } from "../../src/lib/types";
import {
  composerTextarea,
  pressIn,
  seedMemberEntries,
  signInAs,
  typeInto,
  useComposer,
} from "../helpers/composerAutocomplete";

beforeEach(() => {
  seedMemberEntries([
    { username: "John Smith" },
    { username: "jdoe", displayName: "John Doe" },
    { username: "bob" },
  ]);
  signInAs("member", Permission.SEND_MESSAGES);
  resetMessagesStore();
});

afterEach(() => {
  resetServerCapabilities();
});

describe("filterMentionSuggestions with spaced names", () => {
  it("lists a username with a space when the server resolves id mentions", () => {
    applyReadyCapabilities({ id_mentions: true });
    expect(filterMentionSuggestions("john").map((s) => s.token)).toEqual(["jdoe", "John Smith"]);
  });

  it("matches a query that holds a space against the display name and username", () => {
    applyReadyCapabilities({ id_mentions: true });
    expect(filterMentionSuggestions("john d").map((s) => s.token)).toEqual(["jdoe"]);
    expect(filterMentionSuggestions("john s").map((s) => s.token)).toEqual(["John Smith"]);
  });

  it("still leaves the spaced username out on a server without id mentions", () => {
    expect(filterMentionSuggestions("john").map((s) => s.token)).toEqual(["jdoe"]);
  });
});

describe("composer with spaced names", () => {
  let container: HTMLDivElement;
  let input: ReturnType<typeof createMessageInput>;
  let onSend: Mock<MessageInputOptions["onSend"]>;
  useComposer((c) => ({ container, input, onSend } = c));

  const ta = (): HTMLTextAreaElement => composerTextarea(container);
  const type = (value: string): void => typeInto(container, value);
  const press = (k: string): boolean => pressIn(container, k);
  const popupTokens = (): string[] =>
    [...container.querySelectorAll<HTMLElement>("[data-testid^='mention-option-']")].map((el) =>
      el.dataset.testid!.slice("mention-option-".length),
    );

  it("keeps the popup open past a space while the name still matches, then picks it", () => {
    applyReadyCapabilities({ id_mentions: true });
    type("hi @John S");
    expect(popupTokens()).toEqual(["John Smith"]);
    expect(press("Enter")).toBe(true);
    expect(ta().value).toBe("hi @John Smith ");
    press("Enter");
    expect(onSend).toHaveBeenCalledWith("hi <@1>", null, [], [], false);
  });

  it("finds a member by a display name with a space and sends their id", () => {
    applyReadyCapabilities({ id_mentions: true });
    type("@John D");
    expect(popupTokens()).toEqual(["jdoe"]);
    press("Enter");
    expect(ta().value).toBe("@jdoe ");
    press("Enter");
    expect(onSend).toHaveBeenCalledWith("<@2>", null, [], [], false);
  });

  it("closes the popup once the text after the space matches nobody", () => {
    applyReadyCapabilities({ id_mentions: true });
    type("@bob how are you");
    expect(container.querySelector("[data-testid='mention-autocomplete']")).toBeNull();
    press("Enter");
    expect(onSend).toHaveBeenCalledWith("@bob how are you", null, [], [], false);
  });

  it("sends a member-menu mention of a spaced username as the id token", () => {
    applyReadyCapabilities({ id_mentions: true });
    type("hey");
    expect(input.insertMention("John Smith", 1)).toBe(true);
    expect(ta().value).toBe("hey @John Smith ");
    press("Enter");
    expect(onSend).toHaveBeenCalledWith("hey <@1>", null, [], [], false);
  });

  it("sends a member-menu mention as plain text without id mentions", () => {
    type("hey");
    input.insertMention("bob", 3);
    press("Enter");
    expect(onSend).toHaveBeenCalledWith("hey @bob", null, [], [], false);
  });
});
