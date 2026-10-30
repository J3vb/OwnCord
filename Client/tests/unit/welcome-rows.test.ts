/**
 * WP 8.6: the welcome row. Drawn from `kind` and the author alone (never
 * `content`), with a greeting fixed by the row id, a Wave button for everyone
 * but the joiner who can post there, and the ordinary delete rule.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderMessage } from "@components/message-list/renderers";
import { messageActionGates } from "@components/message-list/message-actions";
import {
  WAVE_CONTENT,
  canWaveIn,
  hasWaved,
  markWaved,
  welcomeGreeting,
} from "@components/message-list/welcomeRows";
import { shouldGroup } from "@lib/text/formatting";
import { isPinRowKind, isServerRowKind, isWelcomeRowKind } from "@lib/text/messageKind";
import { runSessionResets } from "@lib/sessionRegistry";
import type { Message } from "@stores/messages.store";
import {
  ME,
  OTHER,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  signInAs,
} from "../helpers/message-actions-fixtures";

function welcomeRow(over: Partial<Message> = {}): Message {
  return makeMessage({
    id: 20,
    kind: "member_join",
    content: "English fallback that must never be shown",
    ...over,
  });
}

function render(msg: Message, opts = makeOpts({ onWave: vi.fn(() => true) })): HTMLElement {
  return renderMessage(msg, false, [msg], opts, new AbortController().signal);
}
const textOf = (el: HTMLElement): string => el.textContent?.replace(/\s+/g, " ").trim() ?? "";
const waveButton = (el: HTMLElement, id = 20): HTMLButtonElement | null =>
  el.querySelector<HTMLButtonElement>(`[data-testid="welcome-row-wave-${id}"]`);

beforeEach(() => {
  resetGateStores();
  signInAs("member");
  setChannel({ type: "text", canSend: true });
});
afterEach(() => {
  runSessionResets("user");
  resetGateStores();
});

describe("isWelcomeRowKind", () => {
  it("is true only for member_join, which is still a server row", () => {
    expect(isWelcomeRowKind("member_join")).toBe(true);
    expect(isWelcomeRowKind("pin_add")).toBe(false);
    expect(isWelcomeRowKind("call")).toBe(false);
    expect(isWelcomeRowKind("")).toBe(false);
    expect(isWelcomeRowKind(undefined)).toBe(false);
    expect(isServerRowKind("member_join")).toBe(true);
    expect(isPinRowKind("member_join")).toBe(false);
  });
});

describe("welcomeGreeting", () => {
  it("is fixed by the message id, so every client shows the same line", () => {
    expect(welcomeGreeting(20, "Alice")).toBe(welcomeGreeting(20, "Alice"));
    expect(welcomeGreeting(0, "Alice")).toBe("Alice just joined. Say hi!");
    expect(welcomeGreeting(1, "Alice")).toBe("Welcome, Alice. We hope you brought snacks.");
    expect(welcomeGreeting(2, "Alice")).toBe("Alice just showed up.");
    expect(welcomeGreeting(3, "Alice")).toBe("Everyone welcome Alice!");
    expect(welcomeGreeting(4, "Alice")).toBe("Glad you're here, Alice.");
    // Wraps after five.
    expect(welcomeGreeting(5, "Alice")).toBe(welcomeGreeting(0, "Alice"));
    expect(welcomeGreeting(23, "Alice")).toBe(welcomeGreeting(3, "Alice"));
  });
});

describe("welcome row rendering", () => {
  it("draws the joiner's avatar and a greeting, never the English fallback", () => {
    const el = render(welcomeRow());
    expect(el.classList.contains("welcome-row")).toBe(true);
    expect(el.dataset["testid"]).toBe("message-20");
    expect(el.querySelector(".wr-avatar")).not.toBeNull();
    expect(textOf(el)).toContain(welcomeGreeting(20, "alice"));
    expect(textOf(el)).not.toContain("English fallback");
  });

  it("picks the same line for the same id and a different one for a neighbour", () => {
    expect(textOf(render(welcomeRow({ id: 21 })))).toContain(welcomeGreeting(21, "alice"));
    expect(welcomeGreeting(21, "alice")).not.toBe(welcomeGreeting(20, "alice"));
  });

  it("never groups with a neighbour", () => {
    const row = welcomeRow();
    const prev = makeMessage({ id: 3, timestamp: "2024-01-15T11:59:55Z" });
    const next = makeMessage({ id: 30, timestamp: "2024-01-15T12:00:05Z" });
    expect(shouldGroup(prev, row)).toBe(false);
    expect(shouldGroup(row, next)).toBe(false);
  });
});

describe("the Wave button", () => {
  it("is offered on someone else's row when the viewer can post", () => {
    const button = waveButton(render(welcomeRow()));
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("Wave to say hi!");
    expect(button?.textContent).toContain(WAVE_CONTENT);
    expect(button?.disabled).toBe(false);
  });

  it("is hidden on the viewer's own row", () => {
    const own = welcomeRow({ user: { id: ME, username: "me", avatar: null } });
    expect(waveButton(render(own))).toBeNull();
  });

  it("is hidden when the viewer cannot post in the channel", () => {
    setChannel({ type: "text", canSend: false });
    expect(canWaveIn(1)).toBe(false);
    expect(waveButton(render(welcomeRow()))).toBeNull();
  });

  it("is hidden when the list wires no wave handler", () => {
    const opts = makeOpts();
    expect(waveButton(render(welcomeRow(), opts))).toBeNull();
  });

  it("sends the wave once, as a reply to the row, then disables", () => {
    const onWave = vi.fn(() => true);
    const el = render(
      welcomeRow({ user: { id: OTHER, username: "alice", avatar: null } }),
      makeOpts({ onWave }),
    );
    const button = waveButton(el)!;
    button.click();
    expect(onWave).toHaveBeenCalledExactlyOnceWith(20);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain("Waved");
    button.click();
    expect(onWave).toHaveBeenCalledOnce();
    expect(hasWaved(20)).toBe(true);
  });

  it("stays enabled when the wave could not be sent", () => {
    const onWave = vi.fn(() => false);
    const el = render(
      welcomeRow({ user: { id: OTHER, username: "alice", avatar: null } }),
      makeOpts({ onWave }),
    );
    const button = waveButton(el)!;
    button.click();
    expect(onWave).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(false);
    expect(hasWaved(20)).toBe(false);
  });

  it("stays disabled when the row repaints, and resets with the session", () => {
    markWaved(20);
    const again = waveButton(render(welcomeRow()))!;
    expect(again.disabled).toBe(true);
    runSessionResets("user");
    expect(hasWaved(20)).toBe(false);
    setChannel({ type: "text", canSend: true }); // the reset emptied the channel store too
    expect(waveButton(render(welcomeRow()))!.disabled).toBe(false);
  });
});

describe("welcome row actions", () => {
  const shown = (g: ReturnType<typeof messageActionGates>): boolean[] =>
    [g.react, g.edit, g.pin, g.delete, g.report].map((x) => x.shown);

  it("the author may delete their own row; it cannot be edited, reacted to or pinned", () => {
    const own = welcomeRow({ user: { id: ME, username: "me", avatar: null } });
    expect(shown(messageActionGates(own, makeOpts({ onReportClick: vi.fn() })))).toEqual([
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  it("a plain member cannot delete another member's row, a moderator can", () => {
    setChannel({ type: "text", canDeleteOthers: false });
    expect(messageActionGates(welcomeRow(), makeOpts()).delete.shown).toBe(false);
    signInAs("moderator");
    setChannel({ type: "text", canDeleteOthers: true });
    expect(messageActionGates(welcomeRow(), makeOpts()).delete.shown).toBe(true);
  });
});
