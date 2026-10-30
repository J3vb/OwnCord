import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderMessage } from "@components/message-list/renderers";
import { runSessionResets } from "@lib/net/sessionRegistry";
import type { PollInfo, PollView } from "@lib/types";
import { setConnectionStatus } from "@stores/ui.store";
import type { Message } from "@stores/messages.store";
import {
  ME,
  OTHER,
  makeMessage,
  makeOpts,
  resetGateStores,
  setChannel,
  signInAs,
} from "../../../tests/helpers/message-actions-fixtures";
import { pollCardState, renderPollCard } from "./pollCard";
import type { PollOutcome } from "../../features/messaging/pollSend";

const NOW = Date.now();
const HOUR = 3_600_000;

const noop = (): void => {};
let nextId = 100;
let abort: AbortController;

function pollView(
  over: Partial<PollInfo> = {},
  counts: readonly number[] = [0, 0],
  me: number[] = [],
): PollView {
  const total = counts.reduce((a, b) => a + b, 0);
  return {
    question: "Lunch?",
    answers: counts.map((_, i) => ({
      answer_id: i + 1,
      text: ["Pizza", "Sushi", "Tacos"][i] ?? `A${i + 1}`,
      emoji: i === 0 ? "🍕" : null,
    })),
    allow_multiselect: false,
    expires_at: new Date(NOW + 3 * HOUR).toISOString(),
    ended: false,
    ended_at: null,
    results: {
      version: 1,
      total_voters: total,
      counts: counts.map((count, i) => ({ answer_id: i + 1, count })),
      me,
    },
    selfVersion: 1,
    ...over,
  };
}

const pollMessage = (poll: PollView, over: Partial<Message> = {}): Message =>
  makeMessage({ id: ++nextId, content: "📊 Lunch?\n- 🍕 Pizza\n- Sushi", poll, ...over });

const ok = <T>(value: T): PollOutcome<T> => ({ ok: true, value });

function draw(msg: Message, over = {}): HTMLElement {
  const el = renderPollCard(msg, makeOpts(over), abort.signal);
  document.body.appendChild(el);
  return el;
}

/** The card's message id, from its own `msg-poll-<id>` test id. */
const cardId = (el: HTMLElement): string =>
  /^msg-poll-(\d+)$/.exec(el.dataset["testid"] ?? "")?.[1] ?? "";
const FOCUSABLE = new Set([
  "poll-vote",
  "poll-end",
  "poll-remove",
  "poll-show-results",
  "poll-hide-results",
]);

/** Find a control by its short name; focusable controls carry the message id in their test id. */
const q = <T extends HTMLElement = HTMLElement>(el: HTMLElement, id: string): T | null => {
  const choice = /^poll-choice-(\d+)$/.exec(id);
  const full = FOCUSABLE.has(id)
    ? `${id}-${cardId(el)}`
    : choice !== null
      ? `poll-choice-${cardId(el)}-${choice[1]}`
      : id;
  return el.querySelector<T>(`[data-testid="${full}"]`);
};
const text = (el: HTMLElement): string => el.textContent?.replace(/\s+/g, " ").trim() ?? "";
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  runSessionResets("user");
  resetGateStores();
  signInAs("member");
  setChannel();
  abort = new AbortController();
  document.body.replaceChildren();
});
afterEach(() => {
  abort.abort();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("an open poll before voting", () => {
  it("single choice: radios in a radiogroup, results hidden, Vote waits for a pick", () => {
    const msg = pollMessage(pollView({}, [3, 1]));
    const el = draw(msg, { onPollVote: vi.fn() });
    const group = el.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    const inputs = [...el.querySelectorAll<HTMLInputElement>("input")];
    expect(inputs.map((i) => i.type)).toEqual(["radio", "radio"]);
    expect(q(el, "poll-hint")?.textContent).toBe("Select one answer");
    // Nobody's count is visible before voting.
    expect(el.querySelector(".msg-poll-result")).toBeNull();
    expect(text(el)).not.toMatch(/%/);
    expect(q<HTMLButtonElement>(el, "poll-vote")!.disabled).toBe(true);
    inputs[1]!.checked = true;
    inputs[1]!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(q<HTMLButtonElement>(el, "poll-vote")!.disabled).toBe(false);
  });

  it("multiple choice: checkboxes in a group, and several can be picked", async () => {
    const vote = vi.fn(async () => ok({}));
    const msg = pollMessage(pollView({ allow_multiselect: true }, [0, 0, 0]));
    const el = draw(msg, { onPollVote: vote });
    expect(el.querySelector('[role="group"].msg-poll-answers')).not.toBeNull();
    const inputs = [...el.querySelectorAll<HTMLInputElement>("input")];
    expect(inputs.map((i) => i.type)).toEqual(["checkbox", "checkbox", "checkbox"]);
    expect(q(el, "poll-hint")?.textContent).toBe("Select one or more answers");
    for (const i of [0, 2]) {
      inputs[i]!.checked = true;
      inputs[i]!.dispatchEvent(new Event("change", { bubbles: true }));
    }
    q<HTMLButtonElement>(el, "poll-vote")!.click();
    expect(vote).toHaveBeenCalledWith(msg.id, [1, 3]);
  });

  it("shows the answer's emoji and text", () => {
    const el = draw(pollMessage(pollView({}, [0, 0])), { onPollVote: vi.fn() });
    expect(text(q(el, "poll-choice-1")!.closest("label")!)).toBe("🍕Pizza");
  });

  it("Show results reveals counts without a vote, and Back to voting returns", () => {
    const msg = pollMessage(pollView({}, [4, 1]));
    const el = draw(msg, { onPollVote: vi.fn() });
    q(el, "poll-show-results")!.click();
    expect(q(el, "poll-result-1")?.textContent).toContain("80% · 4");
    expect(q(el, "poll-vote")).toBeNull();
    q(el, "poll-hide-results")!.click();
    expect(el.querySelector(".msg-poll-result")).toBeNull();
    expect(q(el, "poll-vote")).not.toBeNull();
  });

  it("remembers the picked answers when its row is rebuilt by a poll update", () => {
    const msg = pollMessage(pollView({}, [0, 0]));
    const first = draw(msg, { onPollVote: vi.fn() });
    const radio = q<HTMLInputElement>(first, "poll-choice-2")!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    const again = draw(
      { ...msg, poll: pollView({ results: { ...msg.poll!.results, version: 2 } }, [0, 0]) },
      { onPollVote: vi.fn() },
    );
    expect(q<HTMLInputElement>(again, "poll-choice-2")!.checked).toBe(true);
    expect(q<HTMLButtonElement>(again, "poll-vote")!.disabled).toBe(false);
  });
});

describe("voting", () => {
  it("is busy until the server answers, then shows the results", async () => {
    let settle: (o: PollOutcome<unknown>) => void = noop;
    const vote = vi.fn(() => new Promise<PollOutcome<unknown>>((r) => (settle = r)));
    const msg = pollMessage(pollView({}, [2, 1]));
    const el = draw(msg, { onPollVote: vote });
    const radio = q<HTMLInputElement>(el, "poll-choice-1")!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    q<HTMLButtonElement>(el, "poll-vote")!.click();
    expect(vote).toHaveBeenCalledWith(msg.id, [1]);
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(q<HTMLInputElement>(el, "poll-choice-1")!.disabled).toBe(true);
    expect(q<HTMLButtonElement>(el, "poll-vote")!.disabled).toBe(true);
    // A second click while busy sends nothing.
    q<HTMLButtonElement>(el, "poll-vote")!.click();
    expect(vote).toHaveBeenCalledTimes(1);
    settle(ok({}));
    await flush();
    expect(el.hasAttribute("aria-busy")).toBe(false);
    expect(pollCardState(msg.id).busy).toBe(false);
  });

  it("a refusal shows on the card, and POLL_ENDED says so", async () => {
    const vote = vi.fn(async (): Promise<PollOutcome<unknown>> => ({
      ok: false,
      code: "POLL_ENDED",
    }));
    const el = draw(pollMessage(pollView({}, [0, 0])), { onPollVote: vote });
    const radio = q<HTMLInputElement>(el, "poll-choice-1")!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    q<HTMLButtonElement>(el, "poll-vote")!.click();
    await flush();
    expect(q(el, "poll-error")?.textContent).toBe("This poll has ended");
    expect(q(el, "poll-error")?.getAttribute("role")).toBe("alert");
    // The pick stays, so the voter can try again.
    expect(q<HTMLInputElement>(el, "poll-choice-1")!.checked).toBe(true);
  });

  it("a request that settles after the row was rebuilt redraws the card now showing", async () => {
    let settle: (o: PollOutcome<unknown>) => void = noop;
    const vote = vi.fn(() => new Promise<PollOutcome<unknown>>((r) => (settle = r)));
    const msg = pollMessage(pollView({}, [0, 0]));
    const old = new AbortController();
    const oldEl = renderPollCard(msg, makeOpts({ onPollVote: vote }), old.signal);
    const radio = oldEl.querySelector<HTMLInputElement>("input")!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change", { bubbles: true }));
    q<HTMLButtonElement>(oldEl, "poll-vote")!.click();
    // The row is rebuilt by a poll update while the vote is in flight.
    old.abort();
    const fresh = draw(msg, { onPollVote: vote });
    expect(fresh.getAttribute("aria-busy")).toBe("true");
    settle({ ok: false, code: "RATE_LIMITED" });
    await flush();
    expect(fresh.hasAttribute("aria-busy")).toBe(false);
    expect(q(fresh, "poll-error")?.textContent).toMatch(/Too many votes/);
  });

  it("is off, with the reason, while the connection is down or reactions are locked", () => {
    setConnectionStatus("reconnecting");
    const el = draw(pollMessage(pollView({}, [0, 0])), { onPollVote: vi.fn() });
    expect(q<HTMLInputElement>(el, "poll-choice-1")!.disabled).toBe(true);
    expect(q<HTMLButtonElement>(el, "poll-vote")!.title).not.toBe("");
    setConnectionStatus("connected");
    setChannel({ canReact: false });
    const locked = draw(pollMessage(pollView({}, [0, 0])), { onPollVote: vi.fn() });
    expect(q<HTMLInputElement>(locked, "poll-choice-1")!.disabled).toBe(true);
    expect(q<HTMLButtonElement>(locked, "poll-vote")!.title).toBe(
      "You can't add reactions in this channel",
    );
  });
});

describe("after voting", () => {
  it("shows every answer's percent, count and bar, marks mine, and offers Remove vote", () => {
    const msg = pollMessage(pollView({}, [5, 3], [1]));
    const vote = vi.fn(async () => ok({}));
    const el = draw(msg, { onPollVote: vote });
    expect(el.querySelector('[role="list"]')).not.toBeNull();
    expect(q(el, "poll-result-1")?.textContent).toContain("63% · 5");
    expect(q(el, "poll-result-2")?.textContent).toContain("38% · 3");
    expect(q(el, "poll-result-1")!.classList.contains("is-mine")).toBe(true);
    expect(q(el, "poll-result-2")!.classList.contains("is-mine")).toBe(false);
    expect(q(el, "poll-result-1")!.querySelector<HTMLElement>(".msg-poll-fill")!.style.width).toBe(
      "63%",
    );
    expect(q(el, "poll-result-1")!.querySelector('[aria-label="Your vote"]')).not.toBeNull();
    expect(q(el, "poll-status")?.textContent).toBe("8 votes · Ends in 3 hours");
    q(el, "poll-remove")!.click();
    expect(vote).toHaveBeenCalledWith(msg.id, []);
  });

  it("percent counts distinct voters, so a multiple-choice poll can pass 100", () => {
    const poll = pollView({ allow_multiselect: true }, [4, 4], [1]);
    const el = draw(pollMessage({ ...poll, results: { ...poll.results, total_voters: 4 } }), {
      onPollVote: vi.fn(),
    });
    expect(q(el, "poll-result-1")?.textContent).toContain("100% · 4");
    expect(q(el, "poll-result-2")?.textContent).toContain("100% · 4");
  });
});

const ended = (counts: readonly number[]): PollView =>
  pollView({ ended: true, ended_at: new Date(NOW).toISOString() }, counts, [1]);

describe("an ended poll", () => {
  it("says Poll ended and shows the results with no vote controls", () => {
    const el = draw(pollMessage(ended([3, 1])), { onPollVote: vi.fn() });
    expect(q(el, "poll-hint")?.textContent).toBe("Poll ended · Final results");
    expect(el.dataset["state"]).toBe("ended");
    expect(q(el, "poll-vote")).toBeNull();
    expect(q(el, "poll-remove")).toBeNull();
    expect(q(el, "poll-end")).toBeNull();
    expect(q(el, "poll-status")?.textContent).toBe("4 votes · Poll ended");
    expect(el.querySelector("input")).toBeNull();
  });

  it("marks the winner, or every tied answer, and none at zero votes", () => {
    const win = draw(pollMessage(ended([3, 1])));
    expect(q(win, "poll-result-1")!.classList.contains("is-winner")).toBe(true);
    expect(q(win, "poll-result-1")!.textContent).toContain("Winner");
    expect(q(win, "poll-result-2")!.classList.contains("is-winner")).toBe(false);
    const tie = draw(pollMessage(ended([2, 2, 1])));
    expect(q(tie, "poll-result-1")!.textContent).toContain("Tied");
    expect(q(tie, "poll-result-2")!.textContent).toContain("Tied");
    expect(q(tie, "poll-result-3")!.classList.contains("is-winner")).toBe(false);
    const none = draw(pollMessage(pollView({ ended: true }, [0, 0], [])));
    expect(none.querySelector(".is-winner")).toBeNull();
  });

  it("an unvoted viewer sees the results too once it is over", () => {
    const el = draw(pollMessage(pollView({ ended: true }, [2, 1], [])));
    expect(q(el, "poll-result-1")).not.toBeNull();
  });
});

describe("focusable controls", () => {
  it("carry their message id, so two polls never share a test id", () => {
    const a = draw(pollMessage(pollView({}, [0, 0])), { onPollVote: vi.fn() });
    const b = draw(pollMessage(pollView({}, [0, 0])), { onPollVote: vi.fn() });
    const ids = [a, b].flatMap((el) => [
      el.dataset["testid"],
      ...[...el.querySelectorAll<HTMLElement>("input, button")].map((c) => c.dataset["testid"]),
    ]);
    expect(ids.every((id) => id !== undefined && /\d/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("End poll", () => {
  it("is offered to the author, and only after a confirm sends the request", async () => {
    const end = vi.fn(async () => ok({}));
    const msg = pollMessage(pollView({}, [0, 0]), {
      user: { id: ME, username: "me", avatar: null },
    });
    const el = draw(msg, { onPollVote: vi.fn(), onPollEnd: end });
    q(el, "poll-end")!.click();
    expect(end).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="poll-end-modal"]')).not.toBeNull();
    (document.querySelector('[data-testid="poll-end-cancel"]') as HTMLElement).click();
    expect(end).not.toHaveBeenCalled();
    q(el, "poll-end")!.click();
    (document.querySelector('[data-testid="poll-end-confirm"]') as HTMLElement).click();
    expect(end).toHaveBeenCalledWith(msg.id);
    await flush();
    // Accepted: the button is gone while the final poll_update is on its way.
    expect(q(el, "poll-end")).toBeNull();
  });

  it("the confirm stays open when a poll update rebuilds the row, and ends the list's poll", async () => {
    const end = vi.fn(async () => ok({}));
    const msg = pollMessage(pollView({}, [0, 0]), {
      user: { id: ME, username: "me", avatar: null },
    });
    const list = new AbortController();
    const opts = {
      ...makeOpts({ onPollVote: vi.fn(), onPollEnd: end }),
      listSignal: list.signal,
    };
    const firstRow = new AbortController();
    const first = renderPollCard(msg, opts, firstRow.signal);
    document.body.appendChild(first);
    q(first, "poll-end")!.click();
    expect(document.querySelector('[data-testid="poll-end-modal"]')).not.toBeNull();
    // A vote lands: the row is torn down and rebuilt around a new message object.
    firstRow.abort();
    first.remove();
    const second = renderPollCard({ ...msg }, opts, abort.signal);
    document.body.appendChild(second);
    expect(document.querySelector('[data-testid="poll-end-modal"]')).not.toBeNull();
    (document.querySelector('[data-testid="poll-end-confirm"]') as HTMLElement).click();
    expect(end).toHaveBeenCalledWith(msg.id);
    await flush();
    expect(q(second, "poll-end")).toBeNull();
    // Leaving the channel closes a confirm that is still up.
    const third = renderPollCard(
      pollMessage(pollView({}, [0, 0]), { user: { id: ME, username: "me", avatar: null } }),
      opts,
      abort.signal,
    );
    document.body.appendChild(third);
    q(third, "poll-end")!.click();
    expect(document.querySelector('[data-testid="poll-end-modal"]')).not.toBeNull();
    list.abort();
    expect(document.querySelector('[data-testid="poll-end-modal"]')).toBeNull();
  });

  it("is offered to a moderator for someone else's poll in a channel, not to a member", () => {
    const poll = pollView({}, [0, 0]);
    signInAs("moderator");
    setChannel({ canDeleteOthers: true });
    expect(q(draw(pollMessage(poll), { onPollEnd: vi.fn() }), "poll-end")).not.toBeNull();
    setChannel({ canDeleteOthers: false });
    expect(q(draw(pollMessage(poll), { onPollEnd: vi.fn() }), "poll-end")).toBeNull();
  });

  it("is not offered to a moderator in a DM, where only the author may end it", () => {
    signInAs("moderator");
    setChannel({ type: "dm", canDeleteOthers: true });
    const poll = pollView({}, [0, 0]);
    expect(
      q(
        draw(pollMessage(poll, { user: { id: OTHER, username: "x", avatar: null } }), {
          channelType: "dm",
          onPollEnd: vi.fn(),
        }),
        "poll-end",
      ),
    ).toBeNull();
    expect(
      q(
        draw(pollMessage(poll, { user: { id: ME, username: "me", avatar: null } }), {
          channelType: "dm",
          onPollEnd: vi.fn(),
        }),
        "poll-end",
      ),
    ).not.toBeNull();
  });
});

describe("countdown", () => {
  it("refreshes its label from one timer owned by the row, and clears it on teardown", () => {
    vi.useFakeTimers({ now: NOW });
    const msg = pollMessage(pollView({ expires_at: new Date(NOW + 90_000).toISOString() }, [0, 0]));
    const el = draw(msg, { onPollVote: vi.fn() });
    expect(q(el, "poll-status")?.textContent).toBe("0 votes · Ends in 2 minutes");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(q(el, "poll-status")?.textContent).toBe("0 votes · Ends in under a minute");
    expect(vi.getTimerCount()).toBe(1);
    abort.abort();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turns ended at expires_at by itself and stops voting", () => {
    vi.useFakeTimers({ now: NOW });
    const msg = pollMessage(pollView({ expires_at: new Date(NOW + 45_000).toISOString() }, [1, 0]));
    const el = draw(msg, { onPollVote: vi.fn() });
    expect(el.dataset["state"]).toBe("open");
    vi.advanceTimersByTime(45_000);
    expect(el.dataset["state"]).toBe("ended");
    expect(q(el, "poll-hint")?.textContent).toBe("Poll ended · Final results");
    expect(el.querySelector("input")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an ended poll arms no timer", () => {
    vi.useFakeTimers({ now: NOW });
    draw(pollMessage(pollView({ ended: true }, [1, 0])));
    expect(vi.getTimerCount()).toBe(0);
  });
});

const render = (msg: Message): HTMLElement =>
  renderMessage(msg, false, [msg], makeOpts({ onPollVote: vi.fn() }), abort.signal);

describe("in the message row", () => {
  it("draws the card in place of the fallback text, with reactions kept", () => {
    const msg = pollMessage(pollView({}, [0, 0]), {
      reactions: [{ emoji: "👍", count: 2, me: false }],
    });
    const row = render(msg);
    expect(row.querySelector('[data-testid^="msg-poll-"]')).not.toBeNull();
    expect(row.querySelector(".msg-text")).toBeNull();
    expect(row.textContent).not.toContain("📊");
    expect(row.querySelector(".msg-reactions")).not.toBeNull();
  });

  it("a deleted poll is the deleted line, not a card", () => {
    const row = render(pollMessage(pollView({}, [0, 0]), { deleted: true }));
    expect(row.querySelector('[data-testid^="msg-poll-"]')).toBeNull();
    expect(row.textContent).toContain("deleted");
  });

  it("an ordinary message is unchanged", () => {
    const row = render(makeMessage({ id: 5 }));
    expect(row.querySelector('[data-testid^="msg-poll-"]')).toBeNull();
    expect(row.textContent).toContain("hello world");
  });
});
