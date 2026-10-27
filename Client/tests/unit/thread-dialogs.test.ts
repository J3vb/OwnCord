import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorText, openCreateThreadDialog } from "@components/CreateThreadDialog";
import { isForwardRequest } from "../../src/features/messaging/forwardRequests";
import { openThreadListPopover } from "@components/ThreadListPopover";
import { resetMessagesStore } from "@stores/messages.store";
import { resetThreadsStore, threadsStore } from "@stores/threads.store";
import { setConnectionStatus } from "@stores/ui.store";
import type { ApiClient } from "@lib/api";
import type { WsClient } from "@lib/ws";
import type { ThreadInfo } from "@lib/types";
import { createMockWsClient } from "../helpers/mock-ws";
import { makeThread } from "../helpers/thread-fixtures";

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
let ac: AbortController;

beforeEach(() => {
  ac = new AbortController();
  resetThreadsStore();
  resetMessagesStore();
  setConnectionStatus("connected");
});
afterEach(() => {
  ac.abort();
  document.body.replaceChildren();
  resetThreadsStore();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("CreateThreadDialog", () => {
  function open() {
    const ws = createMockWsClient();
    const onCreated = vi.fn();
    const onExists = vi.fn();
    openCreateThreadDialog({
      ws: ws as unknown as WsClient,
      channelId: 1,
      messageId: 5,
      signal: ac.signal,
      onCreated,
      onExists,
    });
    const name = document.querySelector<HTMLInputElement>('[data-testid="create-thread-name"]')!;
    const form = name.closest("form")!;
    const submit = (): void => {
      form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    };
    return { ws, onCreated, onExists, name, submit };
  }
  const sentOf = (ws: ReturnType<typeof createMockWsClient>) =>
    ws.getSentMessages() as unknown as { type: string; id: string; payload: unknown }[];

  it("sends thread_create with the typed name and the 24 h default", () => {
    const { ws, name, submit } = open();
    name.value = "  Plan ";
    submit();
    expect(sentOf(ws)[0]).toMatchObject({
      type: "thread_create",
      payload: { channel_id: 1, message_id: 5, name: "Plan", auto_archive_minutes: 1440 },
    });
  });

  it("refuses an empty name without sending", () => {
    const { ws, name, submit } = open();
    name.value = "   ";
    submit();
    expect(sentOf(ws)).toHaveLength(0);
    expect(document.querySelector('[data-testid="create-thread-error"]')!.textContent).not.toBe("");
  });

  it("closes and reports the thread on thread_create_ok", () => {
    const { ws, onCreated, name, submit } = open();
    name.value = "Plan";
    submit();
    const thread = makeThread({ id: 7 });
    ws.simulateMessage("thread_create_ok", { thread }, sentOf(ws)[0]!.id);
    expect(onCreated).toHaveBeenCalledWith(thread);
    expect(document.querySelector('[data-testid="create-thread-dialog"]')).toBeNull();
  });

  it("opens the existing thread on THREAD_EXISTS", () => {
    const { ws, onExists, onCreated, name, submit } = open();
    name.value = "Plan";
    submit();
    ws.simulateMessage(
      "error",
      { code: "THREAD_EXISTS", message: "exists", thread_id: 42 },
      sentOf(ws)[0]!.id,
    );
    expect(onExists).toHaveBeenCalledWith(42);
    expect(onCreated).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="create-thread-dialog"]')).toBeNull();
  });

  it("stays open with the refusal for another error, and can retry", () => {
    const { ws, name, submit } = open();
    name.value = "Plan";
    submit();
    ws.simulateMessage("error", { code: "FORBIDDEN", message: "no" }, sentOf(ws)[0]!.id);
    expect(document.querySelector('[data-testid="create-thread-dialog"]')).not.toBeNull();
    expect(document.querySelector<HTMLElement>('[data-testid="create-thread-error"]')!.hidden).toBe(
      false,
    );
    submit();
    expect(sentOf(ws)).toHaveLength(2);
  });

  it("does not send while the socket is down", () => {
    setConnectionStatus("disconnected");
    const { ws, name, submit } = open();
    name.value = "Plan";
    submit();
    expect(sentOf(ws)).toHaveLength(0);
  });

  const errorEl = (): HTMLElement =>
    document.querySelector<HTMLElement>('[data-testid="create-thread-error"]')!;
  const submitBtn = (): HTMLButtonElement =>
    document.querySelector<HTMLButtonElement>('[data-testid="create-thread-submit"]')!;
  const dialog = (): Element | null =>
    document.querySelector('[data-testid="create-thread-dialog"]');

  it("says the reply is unconfirmed after 20 s, frees Send and ignores a late reply", async () => {
    vi.useFakeTimers();
    const { ws, onCreated, name, submit } = open();
    name.value = "Plan";
    submit();
    const id = sentOf(ws)[0]!.id;
    vi.advanceTimersByTime(19_999);
    expect(errorEl().hidden).toBe(true);
    expect(submitBtn().disabled).toBe(true);

    vi.advanceTimersByTime(1);
    expect(errorEl().hidden).toBe(false);
    expect(errorEl().textContent).toBe(createErrorText("UNCONFIRMED"));
    expect(submitBtn().disabled).toBe(false);
    await Promise.resolve();
    expect(isForwardRequest(id)).toBe(false);

    ws.simulateMessage("thread_create_ok", { thread: makeThread({ id: 7 }) }, id);
    expect(onCreated).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it("shows the offline line when the send fails, and can retry", () => {
    const { ws, name, submit } = open();
    name.value = "Plan";
    submit();
    ws.simulateSendFailure(sentOf(ws)[0]!.id, "CHANNEL_CLOSED");
    expect(errorEl().hidden).toBe(false);
    expect(errorEl().textContent).toBe(createErrorText("OFFLINE"));
    expect(submitBtn().disabled).toBe(false);
    submit();
    expect(sentOf(ws)).toHaveLength(2);
  });

  it("closing while waiting releases the request, so a late reply does nothing", async () => {
    vi.useFakeTimers();
    const { ws, onCreated, onExists, name, submit } = open();
    name.value = "Plan";
    submit();
    const id = sentOf(ws)[0]!.id;
    expect(isForwardRequest(id)).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-testid="create-thread-cancel"]')!.click();
    expect(dialog()).toBeNull();
    await Promise.resolve();
    expect(isForwardRequest(id)).toBe(false);

    ws.simulateMessage("thread_create_ok", { thread: makeThread({ id: 7 }) }, id);
    ws.simulateMessage("error", { code: "THREAD_EXISTS", message: "exists", thread_id: 42 }, id);
    vi.advanceTimersByTime(20_000);
    expect(onCreated).not.toHaveBeenCalled();
    expect(onExists).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ThreadListPopover", () => {
  const t = (id: number, archived = false): ThreadInfo =>
    makeThread({ id, name: `T${id}`, archived });

  it("lists active threads, then archived ones, paging with next_before", async () => {
    const listThreads = vi.fn(async (_c: number, query: string) => {
      const o = Object.fromEntries(new URLSearchParams(query));
      if (o["archived"] !== "1") {
        return o["before"] === undefined
          ? { threads: [t(1), t(2)], next_before: "cur1", has_more: true }
          : { threads: [t(3)], next_before: "", has_more: false };
      }
      return { threads: [t(9, true)], next_before: "", has_more: false };
    });
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const onOpenThread = vi.fn();
    const onClosed = vi.fn();
    openThreadListPopover({
      api: { listThreads } as unknown as ApiClient,
      channelId: 1,
      anchor,
      signal: ac.signal,
      onOpenThread,
      onClosed,
    });
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="thread-list-item-2"]')).not.toBeNull(),
    );
    expect(listThreads.mock.calls[0]![1]).toBe(
      "archived=0&limit=" + String(listThreads.mock.calls[0]![1]).split("limit=")[1],
    );
    document.querySelector<HTMLButtonElement>('[data-testid="thread-list-more"]')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="thread-list-item-3"]')).not.toBeNull(),
    );
    expect(String(listThreads.mock.calls[1]![1])).toContain("before=cur1");
    // Past the open threads the same button reveals the archived ones.
    document.querySelector<HTMLButtonElement>('[data-testid="thread-list-more"]')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="thread-list-item-9"]')).not.toBeNull(),
    );
    expect(threadsStore.getState().byId.has(9)).toBe(true);

    document.querySelector<HTMLElement>('[data-testid="thread-list-item-1"]')!.click();
    expect(onOpenThread).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    await flush();
  });

  it("shows the empty state and closes on Escape, calling onClosed once", async () => {
    const listThreads = vi.fn(async () => ({ threads: [], next_before: "", has_more: false }));
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    const onClosed = vi.fn();
    openThreadListPopover({
      api: { listThreads } as unknown as ApiClient,
      channelId: 1,
      anchor,
      signal: ac.signal,
      onOpenThread: vi.fn(),
      onClosed,
    });
    await vi.waitFor(() => expect(listThreads).toHaveBeenCalledTimes(1));
    await flush();
    document.querySelector<HTMLButtonElement>('[data-testid="thread-list-more"]')!.click();
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-testid="thread-list-empty"]')!.hidden).toBe(
        false,
      ),
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector('[data-testid="thread-popover"]')).toBeNull();
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
