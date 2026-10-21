/**
 * The poll card (WP 6.9b): a poll message's question, answers and footer,
 * drawn in place of its text. Open and not yet voted it is a form (radios for a
 * single-choice poll, checkboxes for a multiple-choice one) with Vote and Show
 * results; after a vote, or once the poll is over, every answer shows its
 * percent, its count and a bar. The author, and anyone who may delete others'
 * messages, can End poll (behind a confirm).
 *
 * Every poll update replaces the message object, so the row is rebuilt and a
 * card instance is short-lived. What must outlive one (the picked answers, an
 * open Show results, a vote still in flight, a refusal) lives in `states`,
 * keyed by message id and reset with the session, and the request itself is
 * owned by that state, not by the card: when it settles, whichever card is
 * showing that poll redraws. Votes are not optimistic: the card is busy until
 * the server answers, so there is nothing to roll back.
 *
 * The countdown refreshes from one `setOwnedTimeout` owned by the row's signal,
 * re-armed at the next label change, so there is no interval. At `expires_at`
 * the card flips to its ended look on its own; the server's `poll_update` then
 * brings the final counts.
 */

import { createElement, setText, clearChildren, setOwnedTimeout, focusIsOurs } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { createModal } from "@lib/modalFactory";
import { registerSessionReset } from "@lib/sessionRegistry";
import type { PollAnswer, PollView } from "@lib/types";
import { channelsStore } from "@stores/channels.store";
import { uiStore } from "@stores/ui.store";
import type { Message } from "@stores/messages.store";
import type { MessageListOptions } from "../MessageList";
import { messagingText } from "../../i18n/messaging";
import { shellText } from "../../i18n/shell";
import {
  answerPercent,
  canEndPoll,
  isEnded,
  nextLabelChangeMs,
  timeLeft,
  winningAnswers,
} from "../../features/messaging/pollModel";
import { buildCustomEmojiNode } from "./custom-emoji";
import { connectionLockReason } from "./message-actions";
import { channelCanReact, reactionLockReason } from "./reactions";

/** What one poll's card remembers across row rebuilds. */
export interface CardState {
  selected: number[];
  showResults: boolean;
  /** A vote or an end is awaiting the server. */
  busy: boolean;
  /** The refusal to show, as a catalog key suffix; null for none. */
  error: string | null;
  /** End poll was accepted: the poll_update that ends the card is on its way. */
  endSent: boolean;
  /** Redraws the card now showing this poll; null when none is mounted. */
  redraw: (() => void) | null;
}

const MAX_REMEMBERED = 200;
const states = new Map<number, CardState>();

void registerSessionReset("messages:pollCards", () => states.clear()); // app-lifetime

/** What the card remembers for a poll; exported so the session reset can be probed and tests can seed it. */
export function pollCardState(messageId: number): CardState {
  let state = states.get(messageId);
  if (state === undefined) {
    state = {
      selected: [],
      showResults: false,
      busy: false,
      error: null,
      endSent: false,
      redraw: null,
    };
    states.set(messageId, state);
    // The oldest idle entries go first; a poll with a request in flight stays.
    for (const [id, old] of states) {
      if (states.size <= MAX_REMEMBERED) break;
      if (!old.busy && old.redraw === null) states.delete(id);
    }
  }
  return state;
}

function errorText(code: string): string {
  switch (code) {
    case "NOT_FOUND":
      return messagingText("poll.error.NOT_FOUND");
    case "POLL_ENDED":
      return messagingText("poll.error.POLL_ENDED");
    case "RATE_LIMITED":
      return messagingText("poll.error.RATE_LIMITED");
    case "FORBIDDEN":
      return messagingText("poll.error.FORBIDDEN");
    case "TIMED_OUT":
      return messagingText("poll.error.TIMED_OUT");
    case "OFFLINE":
      return messagingText("poll.error.OFFLINE");
    case "NETWORK":
      return messagingText("poll.error.NETWORK");
    case "UNCONFIRMED":
      return messagingText("poll.error.UNCONFIRMED");
    case "REQUEST_TIMEOUT":
      return messagingText("poll.error.REQUEST_TIMEOUT");
    default:
      return messagingText("poll.error.other");
  }
}

/** An answer's emoji: a custom `:shortcode:` as its image, anything else as text. */
function emojiNode(emoji: string): Node {
  return buildCustomEmojiNode(emoji) ?? document.createTextNode(emoji);
}

function timeLeftText(poll: PollView, now: number): string {
  const left = timeLeft(Math.max(1, Date.parse(poll.expires_at) - now));
  switch (left.unit) {
    case "under-a-minute":
      return messagingText("poll.endsIn.underMinute");
    case "minutes":
      return messagingText("poll.endsIn.minutes", { count: left.count });
    case "hours":
      return messagingText("poll.endsIn.hours", { count: left.count });
    default:
      return messagingText("poll.endsIn.days", { count: left.count });
  }
}

/** Ask for confirmation before ending a poll. */
function confirmEnd(messageId: number, signal: AbortSignal, onConfirm: () => void): void {
  const titleId = `poll-end-title-${messageId}`;
  const content = createElement("div");
  const header = createElement("div", { class: "modal-header" });
  header.appendChild(createElement("h3", { id: titleId }, messagingText("poll.endConfirm.title")));
  const body = createElement("div", { class: "modal-body" });
  body.appendChild(createElement("p", {}, messagingText("poll.endConfirm.body")));
  const footer = createElement("div", { class: "modal-footer" });
  const cancel = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "poll-end-cancel" },
    shellText("common.cancel"),
  );
  const confirm = createElement(
    "button",
    { class: "btn-danger", type: "button", "data-testid": "poll-end-confirm" },
    messagingText("poll.endConfirm.confirm"),
  );
  footer.append(cancel, confirm);
  content.append(header, body, footer);
  const modal = createModal({
    content,
    ariaLabelledBy: titleId,
    overlayAttrs: { "data-testid": "poll-end-modal" },
    signal,
  });
  cancel.addEventListener("click", () => modal.close());
  confirm.addEventListener("click", () => {
    modal.close();
    onConfirm();
  });
}

export function renderPollCard(
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLElement {
  const poll = msg.poll!;
  const state = pollCardState(msg.id);
  const card = createElement("div", {
    class: "msg-poll",
    role: "group",
    tabindex: "-1",
    "aria-label": messagingText("poll.card.label", { question: poll.question }),
    "data-testid": "msg-poll",
  });
  const channel = channelsStore.getState().channels.get(msg.channelId);
  const mayEnd = canEndPoll(msg.user.id, opts.currentUserId, channel, opts.channelType === "dm");
  let stopTimer: (() => void) | null = null;
  let statusEl: HTMLElement | null = null;

  /** Why voting is off right now (null when it is on). */
  const lockReason = (): string | null =>
    opts.onPollVote === undefined
      ? messagingText("poll.error.other")
      : (reactionLockReason(channelCanReact(msg.channelId)) ??
        connectionLockReason(uiStore.getState().connectionStatus));

  function renderStatus(now: number, ended: boolean): void {
    if (statusEl === null) return;
    const votes = messagingText("poll.votes", { count: poll.results.total_voters });
    setText(
      statusEl,
      `${votes} · ${ended ? messagingText("poll.ended") : timeLeftText(poll, now)}`,
    );
  }

  function armTimer(): void {
    stopTimer?.();
    stopTimer = null;
    if (poll.ended) return;
    const wait = nextLabelChangeMs(Date.now(), poll.expires_at);
    if (wait === null) return;
    stopTimer = setOwnedTimeout(
      signal,
      () => {
        const now = Date.now();
        if (isEnded(poll, now)) draw();
        else {
          renderStatus(now, false);
          armTimer();
        }
      },
      wait,
    );
  }

  async function submit(answerIds: readonly number[]): Promise<void> {
    if (state.busy || opts.onPollVote === undefined) return;
    state.busy = true;
    state.error = null;
    draw();
    const out = await opts.onPollVote(msg.id, answerIds);
    state.busy = false;
    if (out.ok) {
      state.selected = [];
      state.showResults = false;
    } else {
      state.error = out.code;
    }
    state.redraw?.();
  }

  async function finish(): Promise<void> {
    if (state.busy || opts.onPollEnd === undefined) return;
    state.busy = true;
    state.error = null;
    draw();
    const out = await opts.onPollEnd(msg.id);
    state.busy = false;
    if (out.ok) state.endSent = true;
    else state.error = out.code;
    state.redraw?.();
  }

  function button(
    label: string,
    testid: string,
    kind: "primary" | "link" | "danger",
  ): HTMLButtonElement {
    const btn = createElement(
      "button",
      { class: `msg-poll-btn msg-poll-btn-${kind}`, type: "button", "data-testid": testid },
      label,
    );
    if (state.busy) btn.setAttribute("disabled", "true");
    return btn;
  }

  function votingAnswer(answer: PollAnswer, lock: string | null): HTMLElement {
    const multi = poll.allow_multiselect;
    const row = createElement("label", { class: "msg-poll-answer msg-poll-choice" });
    const input = createElement("input", {
      type: multi ? "checkbox" : "radio",
      name: `poll-${msg.id}`,
      value: String(answer.answer_id),
      "data-testid": `poll-choice-${answer.answer_id}`,
    });
    input.checked = state.selected.includes(answer.answer_id);
    if (lock !== null || state.busy) input.disabled = true;
    row.appendChild(input);
    if (answer.emoji != null && answer.emoji !== "") {
      const emoji = createElement("span", { class: "msg-poll-emoji" });
      emoji.appendChild(emojiNode(answer.emoji));
      row.appendChild(emoji);
    }
    row.appendChild(createElement("span", { class: "msg-poll-text" }, answer.text));
    return row;
  }

  function resultAnswer(
    answer: PollAnswer,
    ended: boolean,
    winners: ReadonlySet<number>,
  ): HTMLElement {
    const count = poll.results.counts.find((c) => c.answer_id === answer.answer_id)?.count ?? 0;
    const percent = answerPercent(count, poll.results.total_voters);
    const mine = poll.results.me.includes(answer.answer_id);
    const winner = ended && winners.has(answer.answer_id);
    const row = createElement("div", {
      class: `msg-poll-answer msg-poll-result${mine ? " is-mine" : ""}${winner ? " is-winner" : ""}`,
      role: "listitem",
      "data-testid": `poll-result-${answer.answer_id}`,
    });
    const head = createElement("div", { class: "msg-poll-result-head" });
    if (answer.emoji != null && answer.emoji !== "") {
      const emoji = createElement("span", { class: "msg-poll-emoji" });
      emoji.appendChild(emojiNode(answer.emoji));
      head.appendChild(emoji);
    }
    head.appendChild(createElement("span", { class: "msg-poll-text" }, answer.text));
    if (mine) {
      const mark = createElement("span", {
        class: "msg-poll-mine",
        title: messagingText("poll.yourVote"),
        role: "img",
        "aria-label": messagingText("poll.yourVote"),
      });
      mark.appendChild(createIcon("check", 14));
      head.appendChild(mark);
    }
    if (winner) {
      head.appendChild(
        createElement(
          "span",
          { class: "msg-poll-winner" },
          messagingText(winners.size > 1 ? "poll.tied" : "poll.winner"),
        ),
      );
    }
    head.appendChild(
      createElement(
        "span",
        { class: "msg-poll-meta" },
        messagingText("poll.result", { percent, count }),
      ),
    );
    const bar = createElement("div", { class: "msg-poll-bar" });
    const fill = createElement("div", { class: "msg-poll-fill" });
    fill.style.width = `${percent}%`;
    bar.appendChild(fill);
    row.append(head, bar);
    return row;
  }

  function draw(): void {
    const focusHere = card.contains(document.activeElement);
    clearChildren(card);
    const now = Date.now();
    const ended = isEnded(poll, now);
    const voted = poll.results.me.length > 0;
    const results = ended || voted || state.showResults;
    const lock = ended ? null : lockReason();
    card.dataset["state"] = ended ? "ended" : "open";
    if (state.busy) card.setAttribute("aria-busy", "true");
    else card.removeAttribute("aria-busy");

    card.appendChild(createElement("div", { class: "msg-poll-question" }, poll.question));
    const hint = ended
      ? messagingText("poll.endedFinal")
      : results
        ? null
        : messagingText(poll.allow_multiselect ? "poll.hint.multi" : "poll.hint.single");
    if (hint !== null) {
      card.appendChild(
        createElement("div", { class: "msg-poll-hint", "data-testid": "poll-hint" }, hint),
      );
    }

    const list = createElement("div", {
      class: "msg-poll-answers",
      role: results ? "list" : poll.allow_multiselect ? "group" : "radiogroup",
      "aria-label": poll.question,
    });
    const winners = ended ? winningAnswers(poll) : new Set<number>();
    for (const answer of poll.answers) {
      list.appendChild(results ? resultAnswer(answer, ended, winners) : votingAnswer(answer, lock));
    }
    card.appendChild(list);

    const foot = createElement("div", { class: "msg-poll-foot" });
    statusEl = createElement("span", { class: "msg-poll-status", "data-testid": "poll-status" });
    renderStatus(now, ended);
    foot.appendChild(statusEl);
    const actions = createElement("div", { class: "msg-poll-actions" });
    if (!ended) {
      if (voted) {
        const remove = button(messagingText("poll.removeVote"), "poll-remove", "link");
        if (lock !== null) {
          remove.setAttribute("disabled", "true");
          remove.title = lock;
        }
        remove.addEventListener("click", () => void submit([]), { signal });
        actions.appendChild(remove);
      } else if (state.showResults) {
        const back = button(messagingText("poll.hideResults"), "poll-hide-results", "link");
        back.addEventListener(
          "click",
          () => {
            state.showResults = false;
            draw();
          },
          { signal },
        );
        actions.appendChild(back);
      } else {
        const show = button(messagingText("poll.showResults"), "poll-show-results", "link");
        show.addEventListener(
          "click",
          () => {
            state.showResults = true;
            draw();
          },
          { signal },
        );
        const vote = button(messagingText("poll.vote"), "poll-vote", "primary");
        if (state.selected.length === 0 || lock !== null) vote.setAttribute("disabled", "true");
        if (lock !== null) vote.title = lock;
        vote.addEventListener("click", () => void submit(state.selected), { signal });
        actions.append(show, vote);
        list.addEventListener(
          "change",
          () => {
            state.selected = [...list.querySelectorAll<HTMLInputElement>("input")]
              .filter((input) => input.checked)
              .map((input) => Number(input.value));
            vote.toggleAttribute(
              "disabled",
              state.selected.length === 0 || lock !== null || state.busy,
            );
          },
          { signal },
        );
      }
      if (mayEnd && !state.endSent) {
        const end = button(messagingText("poll.end"), "poll-end", "danger");
        end.addEventListener("click", () => confirmEnd(msg.id, signal, () => void finish()), {
          signal,
        });
        actions.appendChild(end);
      }
    }
    foot.appendChild(actions);
    card.appendChild(foot);
    if (state.error !== null) {
      card.appendChild(
        createElement(
          "div",
          { class: "msg-poll-error", role: "alert", "data-testid": "poll-error" },
          errorText(state.error),
        ),
      );
    }
    // A redraw replaces the control the user was on; keep the focus in the card.
    if (focusHere && focusIsOurs(card)) card.focus({ preventScroll: true });
    armTimer();
  }

  state.redraw = draw;
  signal.addEventListener(
    "abort",
    () => {
      // A newer card for the same poll has taken the slot over; only clear our own.
      if (state.redraw === draw) state.redraw = null;
    },
    { once: true },
  );
  draw();
  return card;
}
