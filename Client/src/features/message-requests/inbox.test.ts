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
import { renderInbox } from "./Inbox";
import { pinZone, tzPinHonored } from "../../../tests/helpers/tz-pin";
import { messageRequestsStore, pendingRequestCount, resetMessageRequests } from "./store";
import { buildInbox } from "./view";
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
      content === null ? null : { message_id: 500 + id, content, timestamp: "2026-09-05 12:00:00" },
    // The real wire form: SQLite's datetime('now'), space-separated and
    // zone-less, passed through by the server (BUG-11).
    created_at: "2026-09-05 12:00:00",
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
  it("is the registered requests destination, and loads the inbox on open", async () => {
    expect(NAVIGATION_DESTINATIONS.requests?.build).toBe(buildInbox);
    expect(NAVIGATION_DESTINATIONS.requests?.pending).toBe(pendingRequestCount);

    const owner = new AbortController();
    const root = buildInbox({ signal: owner.signal, close: () => {} });
    expect(root.dataset["testid"]).toBe("requests-inbox");
    await vi.waitFor(() => expect(root.querySelector("[role='status']")).not.toBeNull());
    owner.abort();

    // Closed before the view loaded: nothing renders into it.
    const gone = new AbortController();
    const late = buildInbox({ signal: gone.signal, close: () => {} });
    gone.abort();
    await import("./Inbox");
    await settle();
    expect(late.childElementCount).toBe(0);
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
    root = document.createElement("div");
    renderInbox(root, owner.signal);
    document.body.appendChild(root);
    return root;
  }
  const status = (): HTMLElement => root.querySelector("[data-testid='requests-status']")!;
  const list = (): HTMLElement => root.querySelector("[data-testid='requests-list']")!;
  const retry = (): HTMLButtonElement =>
    root.querySelector<HTMLButtonElement>("[data-testid='requests-retry']")!;
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
      "Message requests couldn't be loaded. Try again, or they load again when you reconnect.",
    );

    setConnectionStatus("reconnecting");
    const { uiStore } = await import("@stores/ui.store");
    uiStore.flush();
    expect(status().textContent).toBe("Reconnecting. This list may be out of date.");
  });

  describe("Retry when the inbox is unavailable", () => {
    it("offers Retry only while unavailable and connected", async () => {
      const { api, calls } = deferredApi();
      open();
      expect(retry().hidden).toBe(true);
      applyReadyDmRequests(api);
      calls[0]!.reject(new Error("HTTP 500"));
      await settle();
      messageRequestsStore.flush();
      expect(retry().hidden).toBe(false);
      expect(retry().textContent).toBe("Retry");

      setConnectionStatus("reconnecting");
      const { uiStore } = await import("@stores/ui.store");
      uiStore.flush();
      expect(retry().hidden).toBe(true);
    });

    it("refetches on click, is disabled while loading, and recovers on success", async () => {
      const { api, calls } = deferredApi();
      applyReadyDmRequests(api);
      calls[0]!.reject(new Error("HTTP 500"));
      await settle();
      open();
      expect(retry().hidden).toBe(false);

      retry().click();
      retry().click();
      expect(api.listDmRequests).toHaveBeenCalledTimes(2);
      expect(retry().getAttribute("aria-disabled")).toBe("true");
      expect(retry().textContent).toBe("Retrying…");

      calls[1]!.resolve([item(1)]);
      await settle();
      messageRequestsStore.flush();
      expect(messageRequestsStore.getState().status).toBe("ready");
      expect(retry().hidden).toBe(true);
      expect(ids()).toEqual([1]);
    });

    it("moves focus to the list when Retry succeeds while it held focus", async () => {
      const { api, calls } = deferredApi();
      applyReadyDmRequests(api);
      calls[0]!.reject(new Error("HTTP 500"));
      await settle();
      open();
      retry().focus();
      expect(document.activeElement).toBe(retry());

      retry().click();
      calls[1]!.resolve([item(1)]);
      await settle();
      messageRequestsStore.flush();
      expect(retry().hidden).toBe(true);
      expect(document.activeElement).toBe(list());
    });

    it("shows the message and Retry again after a second failure", async () => {
      const { api, calls } = deferredApi();
      applyReadyDmRequests(api);
      calls[0]!.reject(new Error("HTTP 500"));
      await settle();
      open();

      retry().click();
      calls[1]!.reject(new Error("HTTP 500"));
      await settle();
      messageRequestsStore.flush();
      expect(status().textContent).toContain("couldn't be loaded");
      expect(retry().hidden).toBe(false);
      expect(retry().getAttribute("aria-disabled")).toBe("false");
      expect(retry().textContent).toBe("Retry");
    });
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
    // The datetime attribute is the canonical RFC3339 instant, not the raw
    // zone-less SQLite string the server sent (BUG-11).
    expect(first!.querySelector("time")!.getAttribute("datetime")).toBe("2026-09-05T12:00:00.000Z");
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

  it("redraws a kept row when a newer snapshot drops its preview or renames its sender", async () => {
    handleDmRequest(frame(1, "pending"));
    handleDmRequest(frame(2, "pending"));
    open();
    const [second, first] = rows();
    const accept = first!.querySelector<HTMLElement>("[data-testid='request-accept']")!;
    accept.focus();

    const { api, calls } = deferredApi();
    applyReadyDmRequests(api);
    calls[0]!.resolve([
      item(2),
      { ...item(1, null), sender: { ...item(1).sender, username: "", display_name: "" } },
    ]);
    await settle();
    messageRequestsStore.flush();

    expect(rows()).toEqual([second, first]);
    expect(document.activeElement).toBe(accept);
    expect(first!.querySelector(".requests-preview")!.textContent).toBe(
      "This message has no text to preview.",
    );
    expect(first!.textContent).not.toContain("hello 1");
    expect(first!.querySelector("h3")!.textContent).toBe("Unknown user");
    expect(first!.querySelector(".requests-username")).toBeNull();
    expect(first!.querySelector(".requests-actions")!.getAttribute("aria-label")).not.toContain(
      "Stranger 1",
    );
    expect(second!.querySelector(".requests-preview")!.textContent).toBe("hello 2");
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

  // BUG-11: the row's time was read with `new Date(createdAt)` on the raw
  // SQLite string, so it rendered the digits as Berlin wall time instead of
  // the server's UTC instant — a Berlin viewer saw 12:00 for 12:00Z. Pin
  // Berlin and assert the correct instant and its Berlin rendering, which
  // only holds once the row goes through parseTimestamp. The old code
  // produced "Sep 5, 2026, 12:00 PM" here; the fix produces 2:00 PM.
  const berlinPinHonored = tzPinHonored(
    "Europe/Berlin",
    () => new Date(2026, 0, 15).getTimezoneOffset() === -60,
  );
  describe.skipIf(!berlinPinHonored)(
    "[BUG-11] a request's time is the server's instant, not the viewer's",
    () => {
      let restore: () => void;
      beforeEach(() => {
        restore = pinZone("Europe/Berlin");
      });
      afterEach(() => {
        restore();
      });

      it("renders the UTC instant and a canonical RFC3339 datetime", () => {
        expect(new Date(2026, 0, 15).getTimezoneOffset()).toBe(-60);
        handleDmRequest(frame(1, "pending"));
        open();
        messageRequestsStore.flush();
        const time = rows()[0]!.querySelector("time")!;
        expect(time.getAttribute("datetime")).toBe("2026-09-05T12:00:00.000Z");
        expect(time.textContent).toBe("Sep 5, 2026, 2:00 PM");
      });
    },
  );
});

describe("inbox markup and redraw", () => {
  let owner: AbortController;
  let root: HTMLElement;

  function open(): HTMLElement {
    owner = new AbortController();
    root = document.createElement("div");
    renderInbox(root, owner.signal);
    document.body.appendChild(root);
    return root;
  }
  const byTestId = (id: string): HTMLElement => root.querySelector(`[data-testid='${id}']`)!;
  const rows = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(".requests-item")];
  const retry = (): HTMLButtonElement => byTestId("requests-retry") as HTMLButtonElement;

  const unavailable = async () => {
    const fx = deferredApi();
    applyReadyDmRequests(fx.api);
    fx.calls[0]!.reject(new Error("HTTP 500"));
    await settle();
    open();
    return fx;
  };

  afterEach(() => {
    owner.abort();
    root.remove();
  });

  it("lays out two intro lines, two status regions, Retry and the list in order", () => {
    open();
    expect([...root.children].map((c) => c.tagName)).toEqual(["P", "P", "P", "BUTTON", "P", "UL"]);
    const [intro, help, status, , outcome, list] = [...root.children] as HTMLElement[];
    expect(intro!.className).toBe("requests-intro");
    expect(help!.className).toBe("requests-intro");
    expect(status!.className).toBe("requests-status");
    expect(outcome!.className).toBe("requests-status");
    expect(outcome!.getAttribute("role")).toBe("status");
    expect(outcome!.dataset["testid"]).toBe("requests-outcome");
    expect(list!.className).toBe("requests-list");
    expect(retry().getAttribute("type")).toBe("button");
    expect(retry().className).toBe("btn-modal-cancel requests-retry");
  });

  it("builds each row with a sender heading, four decision buttons and a hidden error line", () => {
    handleDmRequest(frame(1, "pending"));
    open();
    const row = rows()[0]!;
    expect(row.dataset["testid"]).toBe("request-item");
    expect(row.getAttribute("tabindex")).toBe("-1");
    expect(row.querySelector(".requests-item-head")!.firstElementChild!.tagName).toBe("H3");
    expect(row.querySelector("h3")!.className).toBe("requests-sender");
    const err = row.querySelector<HTMLElement>("[data-testid='request-error']")!;
    expect(err.className).toBe("requests-item-error");
    expect(err.hidden).toBe(true);
    const buttons = [...row.querySelectorAll("button")];
    expect(buttons.map((b) => b.dataset["testid"])).toEqual([
      "request-accept",
      "request-ignore",
      "request-delete",
      "request-block",
    ]);
    expect(buttons.map((b) => b.className)).toEqual([
      "btn-modal-save",
      "btn-modal-cancel",
      "btn-modal-cancel",
      "btn-modal-cancel",
    ]);
    for (const b of buttons) {
      expect(b.getAttribute("type")).toBe("button");
      expect(b.getAttribute("aria-disabled")).toBe("false");
    }
    expect(row.getAttribute("aria-busy")).toBeNull();
  });

  it("shows no @handle when the sender has no display name", () => {
    handleDmRequest({
      ...frame(1, "pending"),
      sender: { id: 11, username: "solo", display_name: "", avatar: "" },
    });
    open();
    expect(rows()[0]!.querySelector("h3")!.textContent).toBe("solo");
    expect(rows()[0]!.querySelector(".requests-username")).toBeNull();
  });

  it("shows the @handle beside a different display name", () => {
    handleDmRequest(frame(1, "pending"));
    open();
    expect(rows()[0]!.querySelector(".requests-username")!.textContent).toBe("@stranger1");
  });

  it("shows the sent time in a medium date and short time, and skips an unreadable one", () => {
    handleDmRequest(frame(1, "pending"));
    handleDmRequest({ ...frame(2, "pending"), created_at: "not a date" });
    open();
    const [broken, fine] = rows();
    expect(broken!.querySelector("time")).toBeNull();
    const time = fine!.querySelector("time")!;
    expect(time.className).toBe("requests-time");
    expect(time.textContent).toMatch(/^[A-Z][a-z]{2} \d{1,2}, 2026, \d{1,2}:\d{2}\s?[AP]M$/);
  });

  describe("a newer copy of a kept request", () => {
    const sender = item(1).sender;
    const changes: Array<[string, Partial<DmRequestPayload>, (row: HTMLElement) => string]> = [
      [
        "display name",
        { sender: { ...sender, display_name: "Renamed" } },
        (row) => row.querySelector("h3")!.textContent,
      ],
      [
        "handle",
        { sender: { ...sender, username: "newhandle" } },
        (row) => row.querySelector(".requests-username")!.textContent,
      ],
      [
        "preview text",
        { preview: { ...item(1).preview!, content: "changed text" } },
        (row) => row.querySelector(".requests-preview")!.textContent,
      ],
      [
        "sent time",
        { created_at: "2026-09-06 08:30:00" },
        (row) => row.querySelector("time")!.getAttribute("datetime")!,
      ],
    ];
    const expected = ["Renamed", "@newhandle", "changed text", "2026-09-06T08:30:00.000Z"];

    it.each(changes.map((c, i) => [c[0], c[1], c[2], expected[i]!] as const))(
      "redraws the row when only its %s changed",
      (_name, patch, read, want) => {
        handleDmRequest(frame(1, "pending"));
        open();
        const row = rows()[0]!;
        handleDmRequest({ ...frame(1, "pending"), ...patch });
        messageRequestsStore.flush();
        expect(rows()[0]).toBe(row);
        expect(read(row)).toBe(want);
      },
    );

    it("keeps the very same elements when nothing it shows changed", () => {
      handleDmRequest(frame(1, "pending"));
      open();
      const row = rows()[0]!;
      const head = row.querySelector(".requests-item-head")!;
      const preview = row.querySelector(".requests-preview")!;
      handleDmRequest(frame(1, "pending"));
      messageRequestsStore.flush();
      expect(row.querySelector(".requests-item-head")).toBe(head);
      expect(row.querySelector(".requests-preview")).toBe(preview);
    });
  });

  it("does not rewrite the Retry label on updates that leave it unchanged", async () => {
    const { api, calls } = deferredApi();
    applyReadyDmRequests(api);
    calls[0]!.reject(new Error("HTTP 500"));
    await settle();
    open();
    messageRequestsStore.flush();
    const seen: MutationRecord[] = [];
    const observer = new MutationObserver((m) => seen.push(...m));
    observer.observe(retry(), { childList: true, characterData: true, subtree: true });
    handleDmRequest(frame(1, "pending"));
    messageRequestsStore.flush();
    await settle();
    observer.disconnect();
    expect(retry().textContent).toBe("Retry");
    expect(seen).toHaveLength(0);
  });

  describe("Retry focus and teardown", () => {
    it("leaves focus alone when Retry succeeds without having it", async () => {
      const fx = await unavailable();
      retry().click();
      fx.calls[1]!.resolve([item(1)]);
      await settle();
      messageRequestsStore.flush();
      expect(retry().hidden).toBe(true);
      expect(document.activeElement).not.toBe(byTestId("requests-list"));
    });

    it("keeps focus on Retry when it fails again", async () => {
      const fx = await unavailable();
      retry().focus();
      retry().click();
      fx.calls[1]!.reject(new Error("HTTP 500"));
      await settle();
      messageRequestsStore.flush();
      expect(retry().hidden).toBe(false);
      expect(document.activeElement).toBe(retry());
    });

    it("repaints nothing when the view closes while a Retry is running", async () => {
      const fx = await unavailable();
      retry().click();
      expect(retry().textContent).toBe("Retrying…");
      owner.abort();
      fx.calls[1]!.resolve([item(1)]);
      await settle();
      messageRequestsStore.flush();
      expect(retry().textContent).toBe("Retrying…");
      expect(retry().getAttribute("aria-disabled")).toBe("true");
    });

    it("ignores Retry clicks once the view has closed", async () => {
      const fx = await unavailable();
      owner.abort();
      retry().click();
      expect(fx.api.listDmRequests).toHaveBeenCalledTimes(1);
    });
  });
});
