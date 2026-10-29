// Loading the Message Requests inbox snapshot and remembering the session's client.
import { beforeEach, describe, expect, it } from "vitest";
import { expectConsole } from "../helpers/console";
import { captureLogs } from "../helpers/log-capture";
import { listSessionResets, runSessionResets } from "../../src/lib/sessionRegistry";
import { loadRequests, requestsApi } from "../../src/features/message-requests/sync";
import {
  messageRequestsStore,
  resetMessageRequests,
} from "../../src/features/message-requests/store";
import "../../src/features/moderation/store";
import type { DispatchApi } from "../../src/features/connection/dispatchContext";
import type { DmRequestListItem } from "../../src/lib/types";

function item(id: number): DmRequestListItem {
  return {
    id,
    channel_id: id + 100,
    sender: { id: 7, username: "stranger", display_name: "Stranger", avatar: null },
    preview: null,
    created_at: "2026-01-01T00:00:00Z",
  } as unknown as DmRequestListItem;
}

function apiWith(listDmRequests: () => Promise<{ requests: DmRequestListItem[] }>): DispatchApi {
  return { listDmRequests } as unknown as DispatchApi;
}

describe("message request snapshot loading", () => {
  beforeEach(() => {
    runSessionResets("user");
    resetMessageRequests();
  });

  it("keeps the client it fetched with and fills the inbox", async () => {
    const api = apiWith(() => Promise.resolve({ requests: [item(1), item(2)] }));
    await loadRequests(api);
    expect(requestsApi()).toBe(api);
    const state = messageRequestsStore.getState();
    expect(state.status).toBe("ready");
    expect(state.pending.map((r) => r.id)).toEqual([2, 1]);
  });

  it("does nothing without a client that can list requests", async () => {
    await loadRequests(undefined);
    await loadRequests({} as unknown as DispatchApi);
    expect(requestsApi()).toBeUndefined();
    expect(messageRequestsStore.getState().status).toBe("loading");
  });

  it("forgets the client on sign-out, before any store is emptied", async () => {
    await loadRequests(apiWith(() => Promise.resolve({ requests: [] })));
    expect(requestsApi()).toBeDefined();
    runSessionResets("user");
    expect(requestsApi()).toBeUndefined();
    const order = listSessionResets();
    expect(order.indexOf("message-requests:source")).toBeLessThan(
      order.indexOf("moderation:timeouts"),
    );
  });

  it("stays quiet when sign-out cancels the fetch", async () => {
    const logs = captureLogs();
    await loadRequests(apiWith(() => Promise.reject(new DOMException("gone", "AbortError"))));
    expect(logs.entries).toHaveLength(0);
    expect(messageRequestsStore.getState().status).toBe("loading");
  });

  it("marks the inbox unavailable and logs the reason when the fetch fails", async () => {
    const logs = captureLogs();
    await loadRequests(apiWith(() => Promise.reject(new Error("boom"))));
    expect(messageRequestsStore.getState().status).toBe("unavailable");
    const [entry] = logs.find("Failed to load message requests");
    expect(entry?.component).toBe("message-requests");
    expect(entry?.level).toBe("warn");
    expect(entry?.data).toEqual({ error: "Error: boom" });
    expectConsole("warn", /\[message-requests\] Failed to load message requests/);
  });

  it("treats a DOMException that is not an abort as a failure", async () => {
    const logs = captureLogs();
    await loadRequests(apiWith(() => Promise.reject(new DOMException("net", "NetworkError"))));
    expect(messageRequestsStore.getState().status).toBe("unavailable");
    expect(logs.find("Failed to load message requests")).toHaveLength(1);
    expectConsole("warn", "NetworkError: net");
  });

  it("treats a non-DOMException named AbortError as a failure", async () => {
    const err = Object.assign(new Error("x"), { name: "AbortError" });
    await loadRequests(apiWith(() => Promise.reject(err)));
    expect(messageRequestsStore.getState().status).toBe("unavailable");
    expectConsole("warn", "Failed to load message requests");
  });
});
