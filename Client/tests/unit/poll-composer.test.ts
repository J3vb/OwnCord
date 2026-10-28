import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let pickerOptions: { onSelect: (emoji: string) => void; onClose: () => void } | null = null;
vi.mock("@components/EmojiPicker", () => ({
  createEmojiPicker: (opts: NonNullable<typeof pickerOptions>) => {
    pickerOptions = opts;
    return { element: document.createElement("div"), destroy: vi.fn() };
  },
}));

import { openPollComposer } from "../../src/components/PollComposer";
import { POLL_REPLY_TIMEOUT_MS } from "../../src/features/messaging/pollSend";
import { createMockWsClient, type MockWsClient } from "../helpers/mock-ws";

let ws: MockWsClient;
let abort: AbortController;

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.querySelector<T>(`[data-testid="${id}"]`)!;
const sent = () =>
  ws.getSentMessages() as unknown as {
    type: string;
    id: string;
    payload: Record<string, unknown>;
  }[];
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function type(id: string, value: string): void {
  const input = $<HTMLInputElement>(id);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function fillTwo(): void {
  type("poll-question", "Lunch?");
  type("poll-answer-1", "Pizza");
  type("poll-answer-2", "Sushi");
}

const open = (): void => openPollComposer({ ws, channelId: 9, signal: abort.signal });

beforeEach(() => {
  ws = createMockWsClient();
  ws.connect();
  abort = new AbortController();
  pickerOptions = null;
});
afterEach(() => {
  abort.abort();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("the poll dialog", () => {
  it("opens with two empty answers, one day and single choice, and Post is off", () => {
    open();
    expect(document.querySelectorAll('[data-testid^="poll-answer-row-"]')).toHaveLength(2);
    expect($<HTMLSelectElement>("poll-duration").value).toBe("24");
    expect($<HTMLInputElement>("poll-multi").checked).toBe(false);
    expect($<HTMLButtonElement>("poll-post").disabled).toBe(true);
    expect([...$("poll-duration").querySelectorAll("option")].map((o) => o.textContent)).toEqual([
      "1 hour",
      "4 hours",
      "8 hours",
      "24 hours",
      "3 days",
      "1 week",
    ]);
  });

  it("names the first problem once the user has typed, and clears it when it is fixed", () => {
    open();
    type("poll-question", "Lunch?");
    expect($("poll-note").textContent).toBe("Add at least two answers");
    type("poll-answer-1", "Pizza");
    type("poll-answer-2", "Sushi");
    expect($("poll-note").textContent).toBe("");
    expect($<HTMLButtonElement>("poll-post").disabled).toBe(false);
  });

  it("holds the caps: live counters, over-limit flagged, Post off", () => {
    open();
    type("poll-question", "q".repeat(300));
    expect($("poll-question-counter").textContent).toBe("300/300");
    expect($("poll-question-counter").classList.contains("over")).toBe(false);
    type("poll-question", "q".repeat(301));
    expect($("poll-question-counter").classList.contains("over")).toBe(true);
    type("poll-question", "Lunch?");
    type("poll-answer-1", "a".repeat(55));
    type("poll-answer-2", "b".repeat(56));
    expect($("poll-answer-counter-1").classList.contains("over")).toBe(false);
    expect($("poll-answer-counter-2").textContent).toBe("56/55");
    expect($("poll-answer-counter-2").classList.contains("over")).toBe(true);
    expect($<HTMLButtonElement>("poll-post").disabled).toBe(true);
    expect($("poll-note").textContent).toBe("An answer is too long");
  });

  it("allows up to ten answers, and never fewer than two", () => {
    open();
    for (let i = 0; i < 8; i++) $<HTMLButtonElement>("poll-add-answer").click();
    expect(document.querySelectorAll('[data-testid^="poll-answer-row-"]')).toHaveLength(10);
    expect($<HTMLButtonElement>("poll-add-answer").disabled).toBe(true);
    $<HTMLButtonElement>("poll-add-answer").click();
    expect(document.querySelectorAll('[data-testid^="poll-answer-row-"]')).toHaveLength(10);
    for (let i = 0; i < 8; i++) $<HTMLButtonElement>(`poll-remove-${10 - i}`).click();
    expect(document.querySelectorAll('[data-testid^="poll-answer-row-"]')).toHaveLength(2);
    expect($<HTMLButtonElement>("poll-remove-1").disabled).toBe(true);
    expect($<HTMLButtonElement>("poll-remove-2").disabled).toBe(true);
  });

  it("keeps what was typed when a row is added or another removed", () => {
    open();
    type("poll-answer-1", "Pizza");
    type("poll-answer-2", "Sushi");
    $<HTMLButtonElement>("poll-add-answer").click();
    type("poll-answer-3", "Tacos");
    $<HTMLButtonElement>("poll-remove-1").click();
    expect($<HTMLInputElement>("poll-answer-1").value).toBe("Sushi");
    expect($<HTMLInputElement>("poll-answer-2").value).toBe("Tacos");
  });

  it("an answer takes an emoji from the picker, and clicking it again clears it", async () => {
    open();
    $<HTMLButtonElement>("poll-emoji-1").click();
    await flush();
    expect(pickerOptions).not.toBeNull();
    pickerOptions!.onSelect("🍕");
    expect($("poll-emoji-1").textContent).toBe("🍕");
    $<HTMLButtonElement>("poll-emoji-1").click();
    expect($("poll-emoji-1").textContent).toBe("");
    expect($("poll-emoji-1").getAttribute("aria-label")).toBe("Choose an emoji for answer 1");
  });

  it("Post sends poll_create with the trimmed fields, and closes on poll_create_ok", async () => {
    open();
    fillTwo();
    type("poll-answer-1", "  Pizza ");
    $<HTMLButtonElement>("poll-emoji-1").click();
    await flush();
    pickerOptions!.onSelect("🍕");
    $<HTMLSelectElement>("poll-duration").value = "72";
    $<HTMLSelectElement>("poll-duration").dispatchEvent(new Event("change"));
    const multi = $<HTMLInputElement>("poll-multi");
    multi.checked = true;
    multi.dispatchEvent(new Event("change"));
    $<HTMLButtonElement>("poll-post").click();
    await flush();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]!.type).toBe("poll_create");
    expect(sent()[0]!.payload).toMatchObject({
      channel_id: 9,
      question: "Lunch?",
      answers: [{ text: "Pizza", emoji: "🍕" }, { text: "Sushi" }],
      duration_hours: 72,
      allow_multiselect: true,
    });
    expect(typeof sent()[0]!.payload["client_message_id"]).toBe("string");
    // Busy: the dialog cannot be dismissed or edited while the request is out.
    expect($<HTMLButtonElement>("poll-post").disabled).toBe(true);
    expect($("poll-post").textContent).toBe("Posting…");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector('[data-testid="poll-composer"]')).not.toBeNull();
    ws.simulateMessage(
      "poll_create_ok",
      {
        message_id: 5,
        channel_id: 9,
        client_message_id: sent()[0]!.payload["client_message_id"] as string,
        deduplicated: false,
      },
      sent()[0]!.id,
    );
    await flush();
    expect(document.querySelector('[data-testid="poll-composer"]')).toBeNull();
  });

  it("a refusal stays on the dialog with its reason, and the draft is kept", async () => {
    open();
    fillTwo();
    $<HTMLButtonElement>("poll-post").click();
    await flush();
    ws.simulateMessage("error", { code: "RATE_LIMITED", message: "x" } as never, sent()[0]!.id);
    await flush();
    expect($("poll-note").textContent).toBe(
      "You've posted too many polls. Try again in a few minutes.",
    );
    expect($<HTMLInputElement>("poll-answer-1").value).toBe("Pizza");
    expect($<HTMLButtonElement>("poll-post").disabled).toBe(false);
    expect($("poll-post").textContent).toBe("Post");
  });

  it("Retry after a lost reply reuses the client_message_id, and an edit gets a new one", async () => {
    vi.useFakeTimers();
    open();
    fillTwo();
    $<HTMLButtonElement>("poll-post").click();
    await vi.advanceTimersByTimeAsync(POLL_REPLY_TIMEOUT_MS);
    expect($("poll-note").textContent).toBe("Posting wasn't confirmed. Retrying is safe.");
    expect($("poll-post").textContent).toBe("Retry");
    $<HTMLButtonElement>("poll-post").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]!.payload["client_message_id"]).toBe(sent()[0]!.payload["client_message_id"]);
    await vi.advanceTimersByTimeAsync(POLL_REPLY_TIMEOUT_MS);
    type("poll-answer-2", "Sushi bar");
    expect($("poll-post").textContent).toBe("Post");
    $<HTMLButtonElement>("poll-post").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent()).toHaveLength(3);
    expect(sent()[2]!.payload["client_message_id"]).not.toBe(
      sent()[0]!.payload["client_message_id"],
    );
  });

  it("Escape and Cancel close it when idle, and a channel switch closes it", () => {
    open();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector('[data-testid="poll-composer"]')).toBeNull();
    open();
    $<HTMLButtonElement>("poll-cancel").click();
    expect(document.querySelector('[data-testid="poll-composer"]')).toBeNull();
    open();
    abort.abort();
    expect(document.querySelector('[data-testid="poll-composer"]')).toBeNull();
  });

  it("stays open when a drag-select ends on the backdrop, and a backdrop click still closes", () => {
    open();
    const overlay = $("poll-composer");
    $("poll-question").dispatchEvent(new Event("pointerdown", { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector('[data-testid="poll-composer"]')).not.toBeNull();
    overlay.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(document.querySelector('[data-testid="poll-composer"]')).toBeNull();
  });
});
