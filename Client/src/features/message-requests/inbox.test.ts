// B9-5: the Message Requests inbox — snapshot/frame reconciliation, session
// scoping, the Q2 count and the text-only view that fetches nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lib/logger", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { DmRequestListItem, DmRequestPayload, DmRequestState } from "@lib/types";
import type { WsClient } from "@lib/ws";
import { wireDispatcher } from "@lib/dispatcher";
import { clearAuth } from "@stores/auth.store";
import { channelsStore } from "@stores/channels.store";
import { dmStore } from "@stores/dm.store";
import { setConnectionStatus } from "@stores/ui.store";
import type { DispatchApi } from "../connection/dispatchContext";
import { NAVIGATION_DESTINATIONS } from "../navigation/destinations";
import { buildInbox } from "./Inbox";
import { messageRequestsStore, pendingRequestCount, resetMessageRequests } from "./store";
import { applyReadyDmRequests, handleDmRequest } from "./wsHandlers";

function item(id: number, content: string | null = `hello ${id}`): DmRequestListItem {
  return {
    id,
    channel_id: 100 + id,
    sender: {
      id: 10 + id,
      username: `stranger${id}`,
      display_name: `Stranger ${id}`,
      avatar: `https://tracker.example/avatar-${id}.png`,
    },
    preview:
      content === null
        ? null
        : { message_id: 500 + id, content, timestamp: "2026-09-05T12:00:00Z" },
    created_at: "2026-09-05T12:00:00Z",
  };
}

function frame(id: number, state: DmRequestState): DmRequestPayload {
  return {
    ...item(id),
    state,
    preview: state === "pending" ? item(id).preview : null,
    decided_at: state === "pending" ? null : "2026-09-05T12:01:00Z",
  };
}

/** A GET the test resolves or rejects by hand. */
function deferredApi() {
  const calls: Array<{
    resolve: (items: DmRequestListItem[]) => void;
    reject: (err: unknown) => void;
  }> = [];
  const api = {
    listBlocks: vi.fn(),
    listDmRequests: vi.fn(
      () =>
        new Promise<{ requests: DmRequestListItem[] }>((resolve, reject) => {
          calls.push({ resolve: (requests) => resolve({ requests }), reject });
        }),
    ),
  } as unknown as DispatchApi;
  return { api, calls };
}

const ids = (): number[] => messageRequestsStore.getState().pending.map((r) => r.id);
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  resetMessageRequests();
  setConnectionStatus("connected");
});

afterEach(() => {
  messageRequestsStore.flush();
});

describe("inbox store", () => {
  it("applies the ready snapshot newest first and counts it apart from unread", async () => {
    const { api, calls } = deferredApi();
    const dmBefore = dmStore.getState();
    const channelsBefore = channelsStore.getState();
    expect(messageRequestsStore.getState().status).toBe("loading");

    applyReadyDmRequests(api);
    calls[0]!.resolve([item(1), item(3), item(2)]);
    await settle();

    expect(messageRequestsStore.getState().status).toBe("ready");
    expect(ids()).toEqual([3, 2, 1]);
    expect(pendingRequestCount.get()).toBe(3);
    // Requests stay out of the ordinary DM list and its unread counts (Q2).
    expect(dmStore.getState()).toBe(dmBefore);
    expect(channelsStore.getState()).toBe(channelsBefore);
  });

  it("adds a pending frame and removes one on every decision", () => {
    handleDmRequest(frame(1, "pending"));
    handleDmRequest(frame(2, "pending"));
    expect(ids()).toEqual([2, 1]);
    for (const state of ["accepted", "ignored", "deleted", "blocked"] as const) {
      handleDmRequest(frame(9, "pending"));
      handleDmRequest(frame(9, state));
      expect(ids()).toEqual([2, 1]);
    }
    handleDmRequest(frame(1, "accepted"));
    expect(ids()).toEqual([2]);
  });

  it("notifies the count only when it changes", () => {
    const onChange = vi.fn();
    const unsub = pendingRequestCount.subscribe(onChange);
    handleDmRequest(frame(1, "pending"));
    messageRequestsStore.flush();
    handleDmRequest(frame(1, "pending"));
    messageRequestsStore.flush();
    expect(onChange).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("keeps a frame's word over a snapshot that was already in flight", async () => {
    const { api, calls } = deferredApi();
    handleDmRequest(frame(1, "pending"));
    applyReadyDmRequests(api);
    // While the GET is out: a new request arrives, and request 1 is decided.
    handleDmRequest(frame(5, "pending"));
    handleDmRequest(frame(1, "ignored"));
    // The snapshot predates both.
    calls[0]!.resolve([item(1), item(2)]);
    await settle();
    expect(ids()).toEqual([5, 2]);
  });

  it("applies only the latest snapshot when reconnects overlap", async () => {
    const { api, calls } = deferredApi();
    applyReadyDmRequests(api);
    applyReadyDmRequests(api);
    calls[1]!.resolve([item(2)]);
    await settle();
    calls[0]!.resolve([item(1), item(2)]);
    await settle();
    expect(ids()).toEqual([2]);
  });

  it("reports unavailable on a failed GET, and stays quiet on a cancelled one", async () => {
    const { api, calls } = deferredApi();
    applyReadyDmRequests(api);
    calls[0]!.reject(new DOMException("Session work was cancelled", "AbortError"));
    await settle();
    expect(messageRequestsStore.getState().status).toBe("loading");

    applyReadyDmRequests(api);
    calls[1]!.reject(new Error("HTTP 500"));
    await settle();
    expect(messageRequestsStore.getState().status).toBe("unavailable");

    applyReadyDmRequests(api);
    calls[2]!.resolve([item(1)]);
    await settle();
    expect(messageRequestsStore.getState().status).toBe("ready");
  });

  it("empties on sign-out, and a snapshot from the old session cannot land", async () => {
    const { api, calls } = deferredApi();
    handleDmRequest(frame(1, "pending"));
    applyReadyDmRequests(api);
    clearAuth();
    expect(ids()).toEqual([]);
    // The next account's first snapshot starts before the old one answers.
    applyReadyDmRequests(api);
    calls[0]!.resolve([item(1), item(2)]);
    await settle();
    expect(ids()).toEqual([]);
    expect(messageRequestsStore.getState().status).toBe("loading");
    calls[1]!.resolve([item(7)]);
    await settle();
    expect(ids()).toEqual([7]);
  });

  it("does nothing on ready without an API client", () => {
    applyReadyDmRequests(undefined);
    expect(messageRequestsStore.getState().status).toBe("loading");
  });

  it("drops the sender's avatar URL at the adapter", () => {
    handleDmRequest(frame(1, "pending"));
    expect(JSON.stringify(messageRequestsStore.getState().pending)).not.toContain("tracker");
  });
});

function fakeWs() {
  const handlers = new Map<string, (payload: unknown) => void>();
  const ws = {
    on: (type: string, fn: (payload: unknown) => void) => {
      handlers.set(type, fn);
      return () => handlers.delete(type);
    },
    send: vi.fn(),
    onStateChange: () => () => {},
    onSendFailure: () => () => {},
  } as unknown as WsClient;
  return { ws, handlers };
}

function authOk(replaySource: "none" | "buffer" | "db") {
  return {
    user: { id: 1, username: "me", avatar: null, status: "online", role: "member" },
    server_name: "OwnCord",
    motd: "",
    replay_source: replaySource,
  };
}

describe("wiring", () => {
  it("is the registered requests destination", () => {
    expect(NAVIGATION_DESTINATIONS.requests?.build).toBe(buildInbox);
    expect(NAVIGATION_DESTINATIONS.requests?.pending).toBe(pendingRequestCount);
  });

  it("routes dm_request frames into the inbox", () => {
    const { ws, handlers } = fakeWs();
    const cleanup = wireDispatcher(ws);
    handlers.get("dm_request")!(frame(4, "pending"));
    expect(ids()).toEqual([4]);
    cleanup();
    expect(handlers.has("dm_request")).toBe(false);
  });

  it("refetches on a resume, which gets no ready, and leaves a full flow to ready", async () => {
    const { ws, handlers } = fakeWs();
    const { api, calls } = deferredApi();
    const cleanup = wireDispatcher(ws, api);
    handleDmRequest(frame(1, "pending"));

    handlers.get("auth_ok")!(authOk("buffer"));
    expect(api.listDmRequests).toHaveBeenCalledTimes(1);
    // Request 1 was decided and request 2 arrived while the socket was down.
    calls[0]!.resolve([item(2)]);
    await settle();
    expect(ids()).toEqual([2]);

    handlers.get("auth_ok")!(authOk("db"));
    expect(api.listDmRequests).toHaveBeenCalledTimes(2);

    handlers.get("auth_ok")!(authOk("none"));
    expect(api.listDmRequests).toHaveBeenCalledTimes(2);
    cleanup();
    clearAuth();
  });
});

describe("inbox view", () => {
  let owner: AbortController;
  let root: HTMLElement;

  function open(): HTMLElement {
    owner = new AbortController();
    root = buildInbox({ signal: owner.signal });
    document.body.appendChild(root);
    return root;
  }
  const status = (): HTMLElement => root.querySelector("[data-testid='requests-status']")!;
  const list = (): HTMLElement => root.querySelector("[data-testid='requests-list']")!;
  const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".requests-item")];

  afterEach(() => {
    owner.abort();
    root.remove();
  });

  it("says it is loading, then empty, in one status region", async () => {
    open();
    expect(status().getAttribute("role")).toBe("status");
    expect(status().textContent).toBe("Loading message requests…");
    expect(list().hidden).toBe(true);

    const { api, calls } = deferredApi();
    applyReadyDmRequests(api);
    calls[0]!.resolve([]);
    await settle();
    messageRequestsStore.flush();
    expect(status().textContent).toBe("No pending message requests.");
    expect(list().hidden).toBe(true);
  });

  it("says when the inbox is unavailable or the connection is down", async () => {
    const { api, calls } = deferredApi();
    applyReadyDmRequests(api);
    calls[0]!.reject(new Error("HTTP 404"));
    await settle();
    open();
    expect(status().textContent).toBe(
      "Message requests couldn't be loaded. They load again when you reconnect.",
    );

    setConnectionStatus("reconnecting");
    const { uiStore } = await import("@stores/ui.store");
    uiStore.flush();
    expect(status().textContent).toBe("Reconnecting. This list may be out of date.");
  });

  it("shows sender and message as inert text, and fetches nothing", async () => {
    const { api, calls } = deferredApi();
    applyReadyDmRequests(api);
    calls[0]!.resolve([]);
    await settle();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const hostile = [
      "https://evil.example/x.gif",
      '<img src="https://evil.example/pixel.png" onerror="alert(1)">',
      "![gif](https://evil.example/a.gif) :custom_emoji: @everyone <@1>",
      "[file](/api/v1/files/42)",
    ].join("\n");
    handleDmRequest({ ...frame(1, "pending"), preview: { ...item(1).preview!, content: hostile } });
    handleDmRequest({
      ...frame(2, "pending"),
      sender: { id: 12, username: "", display_name: "", avatar: "https://evil.example/a.png" },
      preview: null,
    });
    open();

    const [erased, first] = rows();
    expect(first!.querySelector("h3")!.textContent).toBe("Stranger 1");
    expect(first!.querySelector(".requests-username")!.textContent).toBe("@stranger1");
    expect(first!.querySelector("time")!.getAttribute("datetime")).toBe("2026-09-05T12:00:00Z");
    expect(first!.querySelector(".requests-preview")!.textContent).toBe(hostile);
    // Sender erasure and a message with no text both still read sensibly.
    expect(erased!.querySelector("h3")!.textContent).toBe("Unknown user");
    expect(erased!.querySelector(".requests-preview")!.textContent).toBe(
      "This message has no text to preview.",
    );

    expect(
      root.querySelectorAll("img, a, iframe, video, audio, source, object, embed"),
    ).toHaveLength(0);
    expect(root.innerHTML).not.toContain("evil.example/a.png");
    expect(fetchSpy).not.toHaveBeenCalled();
    // Silent but still in the accessibility tree, so its next change is spoken.
    expect(status().textContent).toBe("");
    expect(status().hidden).toBe(false);
    fetchSpy.mockRestore();
  });

  it("follows live frames, keeps the list's element and stops after close", () => {
    handleDmRequest(frame(1, "pending"));
    open();
    const el = list();
    el.focus();
    handleDmRequest(frame(2, "pending"));
    messageRequestsStore.flush();
    expect(rows()).toHaveLength(2);
    // Focus stays put through a live update.
    expect(list()).toBe(el);
    expect(document.activeElement).toBe(el);

    handleDmRequest(frame(1, "accepted"));
    messageRequestsStore.flush();
    expect(rows()).toHaveLength(1);

    owner.abort();
    handleDmRequest(frame(3, "pending"));
    messageRequestsStore.flush();
    expect(rows()).toHaveLength(1);
  });

  it("speaks a status once, not again on every update", async () => {
    setConnectionStatus("reconnecting");
    open();
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((m) => seen.push(...m));
    observer.observe(status(), { childList: true, characterData: true, subtree: true });
    handleDmRequest(frame(1, "pending"));
    handleDmRequest(frame(2, "pending"));
    messageRequestsStore.flush();
    await settle();
    observer.disconnect();
    expect(status().textContent).toBe("Reconnecting. This list may be out of date.");
    expect(seen).toHaveLength(0);
  });

  it("makes the scrolling list keyboard-reachable and named", () => {
    handleDmRequest(frame(1, "pending"));
    open();
    expect(list().getAttribute("tabindex")).toBe("0");
    expect(list().getAttribute("aria-label")).toBe("Pending message requests");
    expect(list().hidden).toBe(false);
  });
});
