/**
 * Poll composer: the dialog behind the composer's Poll button. A
 * question (300 characters), two to ten answers (55 each, each with an optional
 * emoji), a duration and an "Allow multiple answers" switch, with a live
 * counter on every field. Post sends `poll_create` and waits for its reply; a
 * refusal or a lost reply stays on the dialog, and Retry reuses the same
 * `client_message_id` while the draft is unchanged, so a poll whose
 * acknowledgement was lost is never posted twice. Loaded on the first click
 * through ChannelController, so it stays out of the startup and MainPage chunks.
 *
 * The rules (caps, what counts as a problem) are features/messaging/pollModel.ts
 * and the request is pollSend.ts; this file only draws. Built with @lib/dom
 * helpers, never innerHTML.
 */

import { Disposable } from "@lib/disposable";
import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { closeOnBackdropClick, createModal, type ModalInstance } from "@lib/ui/modalFactory";
import { newClientMessageId } from "@lib/pendingMessages";
import { listCustomEmoji } from "@stores/emoji.store";
import {
  POLL_ANSWER_MAX,
  POLL_DURATIONS,
  POLL_MAX_ANSWERS,
  POLL_MIN_ANSWERS,
  POLL_QUESTION_MAX,
  checkPollDraft,
  codePointLength,
  draftAnswers,
  emptyPollDraft,
  type DraftProblem,
  type PollDraft,
} from "../features/messaging/pollModel";
import { createPoll, type PollWs } from "../features/messaging/pollSend";
import { pollComposerText } from "../i18n/pollComposer";
import { shellText } from "../i18n/shell";
import { WsErrorCode } from "@lib/protocolTypes";

export interface PollComposerOptions {
  readonly ws: PollWs;
  /** The channel or DM the poll is posted to. */
  readonly channelId: number;
  /** Closes the dialog (and drops a wait) when it aborts, as a channel switch does. */
  readonly signal: AbortSignal;
  readonly fallbackFocus?: () => HTMLElement | null;
}

/** Replies that leave the poll possibly posted: Retry, with the same id, is the safe way on. */
const AMBIGUOUS = new Set(["UNCONFIRMED", "OFFLINE", "NETWORK", WsErrorCode.REQUEST_TIMEOUT]);

function durationLabel(hours: number): string {
  if (hours === 168) return pollComposerText("duration.week");
  if (hours > 24 && hours % 24 === 0) {
    return pollComposerText("duration.days", { count: hours / 24 });
  }
  return pollComposerText("duration.hours", { count: hours });
}

function createErrorText(code: string): string {
  switch (code) {
    case WsErrorCode.BAD_REQUEST:
      return pollComposerText("createError.BAD_REQUEST");
    case WsErrorCode.FORBIDDEN:
      return pollComposerText("createError.FORBIDDEN");
    case WsErrorCode.RATE_LIMITED:
      return pollComposerText("createError.RATE_LIMITED");
    case WsErrorCode.SLOW_MODE:
      return pollComposerText("createError.SLOW_MODE");
    case WsErrorCode.TIMED_OUT:
      return pollComposerText("createError.TIMED_OUT");
    case "OFFLINE":
      return pollComposerText("createError.OFFLINE");
    case "NETWORK":
      return pollComposerText("createError.NETWORK");
    case "UNCONFIRMED":
      return pollComposerText("createError.UNCONFIRMED");
    case WsErrorCode.REQUEST_TIMEOUT:
      return pollComposerText("createError.REQUEST_TIMEOUT");
    default:
      return pollComposerText("createError.other");
  }
}

function problemText(problem: DraftProblem): string {
  switch (problem.kind) {
    case "question-empty":
      return pollComposerText("problem.question-empty");
    case "question-long":
      return pollComposerText("problem.question-long");
    case "answers-few":
      return pollComposerText("problem.answers-few");
    case "answer-long":
      return pollComposerText("problem.answer-long");
    default:
      return pollComposerText("problem.control");
  }
}

function paintCounter(el: HTMLElement, value: string, max: number): void {
  const used = codePointLength(value.trim());
  setText(el, pollComposerText("counter", { used, max }));
  el.classList.toggle("over", used > max);
}

export function openPollComposer(opts: PollComposerOptions): void {
  if (opts.signal.aborted) return;
  const owner = new Disposable();
  const { signal } = owner;
  let draft: PollDraft = emptyPollDraft();
  let modal: ModalInstance | null = null;
  let busy = false;
  let postError: string | null = null;
  // The id a Post was sent with; kept for Retry while the draft is unchanged.
  let attemptId: string | null = null;
  let picker: { element: HTMLDivElement; destroy(): void } | null = null;

  // -- Fields ------------------------------------------------------------------

  const question = createElement("input", {
    class: "form-input",
    type: "text",
    autocomplete: "off",
    placeholder: pollComposerText("question.placeholder"),
    "aria-label": pollComposerText("question.label"),
    "data-testid": "poll-question",
  });
  const questionCounter = createElement("span", {
    class: "poll-counter",
    "data-testid": "poll-question-counter",
  });
  const answersBox = createElement("div", {
    class: "poll-answers",
    role: "group",
    "aria-label": pollComposerText("answers.legend"),
    "data-testid": "poll-answers",
  });
  const addBtn = createElement(
    "button",
    { class: "btn-modal-cancel poll-add", type: "button", "data-testid": "poll-add-answer" },
    pollComposerText("answers.add"),
  );
  const duration = createElement("select", {
    class: "form-input",
    "aria-label": pollComposerText("duration.label"),
    "data-testid": "poll-duration",
  });
  for (const hours of POLL_DURATIONS) {
    duration.appendChild(createElement("option", { value: String(hours) }, durationLabel(hours)));
  }
  duration.value = String(draft.durationHours);
  const multi = createElement("input", {
    type: "checkbox",
    role: "switch",
    "data-testid": "poll-multi",
  });
  const note = createElement("div", {
    class: "poll-note",
    role: "status",
    "data-testid": "poll-note",
  });
  const postBtn = createElement(
    "button",
    { class: "btn-modal-save", type: "button", "data-testid": "poll-post" },
    pollComposerText("post"),
  );
  const cancelBtn = createElement(
    "button",
    { class: "btn-modal-cancel", type: "button", "data-testid": "poll-cancel" },
    pollComposerText("cancel"),
  );

  // -- Answer rows -------------------------------------------------------------

  const rowEmoji = new Map<HTMLElement, HTMLButtonElement>();

  function paintEmoji(btn: HTMLButtonElement, index: number): void {
    const emoji = draft.answers[index]?.emoji ?? "";
    clearChildren(btn);
    if (emoji === "") btn.appendChild(createIcon("smile", 18));
    else setText(btn, emoji);
    btn.setAttribute(
      "aria-label",
      pollComposerText(emoji === "" ? "answer.emoji" : "answer.clearEmoji", {
        n: index + 1,
      }),
    );
  }

  function renderRows(focusIndex: number | null = null): void {
    closePicker();
    clearChildren(answersBox);
    rowEmoji.clear();
    draft.answers.forEach((answer, index) => {
      const n = index + 1;
      const row = createElement("div", {
        class: "poll-answer-row",
        "data-testid": `poll-answer-row-${n}`,
      });
      const emojiBtn = createElement("button", {
        class: "poll-emoji-btn",
        type: "button",
        "aria-haspopup": "dialog",
        "aria-expanded": "false",
        "data-testid": `poll-emoji-${n}`,
      });
      paintEmoji(emojiBtn, index);
      const text = createElement("input", {
        class: "form-input",
        type: "text",
        autocomplete: "off",
        placeholder: pollComposerText("answer.placeholder", { n }),
        "aria-label": pollComposerText("answer.label", { n }),
        "data-testid": `poll-answer-${n}`,
      });
      text.value = answer.text;
      const counter = createElement("span", {
        class: "poll-counter",
        "data-testid": `poll-answer-counter-${n}`,
      });
      const remove = createElement("button", {
        class: "modal-close",
        type: "button",
        "aria-label": pollComposerText("answer.remove", { n }),
        "data-testid": `poll-remove-${n}`,
      });
      remove.appendChild(createIcon("x", 14));
      if (draft.answers.length <= POLL_MIN_ANSWERS) remove.setAttribute("disabled", "true");
      appendChildren(row, emojiBtn, text, counter, remove);
      answersBox.appendChild(row);
      rowEmoji.set(row, emojiBtn);

      text.addEventListener(
        "input",
        () => {
          setAnswer(index, { text: text.value });
          paintCounter(counter, text.value, POLL_ANSWER_MAX);
          sync();
        },
        { signal },
      );
      paintCounter(counter, answer.text, POLL_ANSWER_MAX);
      emojiBtn.addEventListener(
        "click",
        () => {
          if ((draft.answers[index]?.emoji ?? "") !== "") {
            setAnswer(index, { emoji: "" });
            paintEmoji(emojiBtn, index);
            sync();
          } else openPicker(index, emojiBtn);
        },
        { signal },
      );
      remove.addEventListener(
        "click",
        () => {
          draft = { ...draft, answers: draft.answers.filter((_, i) => i !== index) };
          touched();
          renderRows(Math.max(0, index - 1));
          sync();
        },
        { signal },
      );
    });
    if (focusIndex !== null) {
      answersBox
        .querySelector<HTMLInputElement>(`[data-testid="poll-answer-${focusIndex + 1}"]`)
        ?.focus();
    }
    addBtn.toggleAttribute("disabled", draft.answers.length >= POLL_MAX_ANSWERS);
  }

  function setAnswer(index: number, change: Partial<PollDraft["answers"][number]>): void {
    draft = {
      ...draft,
      answers: draft.answers.map((a, i) => (i === index ? { ...a, ...change } : a)),
    };
    touched();
  }

  /** The draft changed, so an id kept for Retry no longer names this poll. */
  function touched(): void {
    attemptId = null;
    postError = null;
  }

  // -- Emoji picker ------------------------------------------------------------

  function closePicker(): void {
    picker?.element.remove();
    picker?.destroy();
    picker = null;
    for (const btn of rowEmoji.values()) btn.setAttribute("aria-expanded", "false");
  }

  function openPicker(index: number, anchor: HTMLElement): void {
    closePicker();
    void import("./EmojiPicker").then(
      ({ createEmojiPicker }) => {
        if (signal.aborted || modal === null) return;
        const made = createEmojiPicker({
          customEmoji: listCustomEmoji(),
          onSelect: (emoji) => {
            setAnswer(index, { emoji });
            const btn = [...rowEmoji.values()][index];
            if (btn !== undefined) paintEmoji(btn, index);
            closePicker();
            sync();
            btn?.focus();
          },
          onClose: closePicker,
        });
        made.element.classList.add("poll-emoji-pop");
        picker = made;
        modal.modal.appendChild(made.element);
        anchor.setAttribute("aria-expanded", "true");
      },
      () => {
        // The emoji set did not load; the answer simply stays without one.
      },
    );
  }

  // -- Validation and counters -------------------------------------------------

  function sync(): void {
    paintCounter(questionCounter, draft.question, POLL_QUESTION_MAX);
    const problems = checkPollDraft(draft);
    const touchedDraft =
      draft.question.trim() !== "" || draft.answers.some((a) => a.text.trim() !== "");
    // Nothing is flagged on a blank dialog; the first problem shows once the user has typed.
    const first = touchedDraft ? problems[0] : undefined;
    setText(
      note,
      postError !== null ? createErrorText(postError) : first ? problemText(first) : "",
    );
    note.classList.toggle("is-error", postError !== null || first !== undefined);
    postBtn.toggleAttribute("disabled", busy || problems.length > 0);
    setText(
      postBtn,
      pollComposerText(
        busy ? "posting" : postError !== null && AMBIGUOUS.has(postError) ? "retry" : "post",
      ),
    );
  }

  function setBusy(next: boolean): void {
    busy = next;
    for (const el of [question, duration, multi, addBtn, cancelBtn])
      el.toggleAttribute("disabled", next);
    for (const el of answersBox.querySelectorAll("input, button"))
      el.toggleAttribute("disabled", next);
    if (!next) {
      // Rows keep their own disabled rule for the minimum.
      for (const el of answersBox.querySelectorAll<HTMLButtonElement>(".modal-close")) {
        el.toggleAttribute("disabled", draft.answers.length <= POLL_MIN_ANSWERS);
      }
      addBtn.toggleAttribute("disabled", draft.answers.length >= POLL_MAX_ANSWERS);
    }
    sync();
  }

  async function post(): Promise<void> {
    if (busy || checkPollDraft(draft).length > 0) return;
    attemptId ??= newClientMessageId();
    postError = null;
    setBusy(true);
    const out = await createPoll(
      opts.ws,
      {
        channelId: opts.channelId,
        question: draft.question.trim(),
        answers: draftAnswers(draft),
        durationHours: draft.durationHours,
        allowMultiselect: draft.multiselect,
        clientMessageId: attemptId,
      },
      signal,
    );
    if (signal.aborted) return;
    if (out.ok) {
      modal?.destroy();
      return;
    }
    postError = out.code;
    setBusy(false);
  }

  // -- Mount -------------------------------------------------------------------

  const header = createElement("div", { class: "modal-header" });
  const closeBtn = createElement("button", {
    class: "modal-close",
    type: "button",
    "aria-label": shellText("common.close"),
  });
  closeBtn.appendChild(createIcon("x", 14));
  appendChildren(
    header,
    createElement("h3", { id: "poll-title" }, pollComposerText("dialog.title")),
    closeBtn,
  );

  const questionRow = createElement("div", { class: "poll-field" });
  appendChildren(questionRow, question, questionCounter);
  const optionsRow = createElement("div", { class: "poll-options" });
  const multiLabel = createElement("label", { class: "poll-switch" });
  appendChildren(multiLabel, multi, createElement("span", {}, pollComposerText("multi.label")));
  appendChildren(optionsRow, duration, multiLabel);
  const body = createElement("div", { class: "modal-body" });
  appendChildren(body, questionRow, answersBox, addBtn, optionsRow, note);
  const footer = createElement("div", { class: "modal-footer" });
  appendChildren(footer, cancelBtn, postBtn);

  modal = createModal(
    {
      content: header,
      onClose: () => {
        closePicker();
        owner.destroy();
      },
      // Escape closes the open picker first, then waits out a post like the backdrop.
      closeOnBackdrop: false,
      onEscape: () => {
        if (picker !== null) closePicker();
        else close();
      },
      className: "poll-composer",
      overlayAttrs: { "data-testid": "poll-composer" },
      ariaLabelledBy: "poll-title",
      signal: opts.signal,
      ...(opts.fallbackFocus === undefined ? {} : { fallbackFocus: opts.fallbackFocus }),
    },
    document.body,
  );
  appendChildren(modal.modal, body, footer);

  const close = (): void => {
    if (!busy) modal?.destroy();
  };
  closeOnBackdropClick(modal.overlay, () => close(), signal);
  closeBtn.addEventListener("click", close, { signal });
  cancelBtn.addEventListener("click", close, { signal });
  postBtn.addEventListener("click", () => void post(), { signal });
  question.addEventListener(
    "input",
    () => {
      draft = { ...draft, question: question.value };
      touched();
      sync();
    },
    { signal },
  );
  duration.addEventListener(
    "change",
    () => {
      draft = { ...draft, durationHours: Number(duration.value) };
      touched();
      sync();
    },
    { signal },
  );
  multi.addEventListener(
    "change",
    () => {
      draft = { ...draft, multiselect: multi.checked };
      touched();
      sync();
    },
    { signal },
  );
  addBtn.addEventListener(
    "click",
    () => {
      if (draft.answers.length >= POLL_MAX_ANSWERS) return;
      draft = { ...draft, answers: [...draft.answers, { text: "", emoji: "" }] };
      touched();
      renderRows(draft.answers.length - 1);
      sync();
    },
    { signal },
  );
  renderRows();
  sync();
  question.focus();
}
