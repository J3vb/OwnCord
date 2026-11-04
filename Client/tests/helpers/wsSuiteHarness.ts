import { expect, vi } from "vitest";
import { expectConsole } from "./console";
import type { ConnectionState, createWsClient } from "../../src/lib/ws";
import { emitTauriEvent, mockInvoke } from "../unit/helpers/ws-mocks";

type WsClient = ReturnType<typeof createWsClient>;

export const WS_CONFIG = { host: "localhost:8443", token: "t" } as const;

/** Connects and lets Rust report the socket open; auth is left unanswered. */
export async function openSocket(
  client: WsClient,
  config: Parameters<WsClient["connect"]>[0] = WS_CONFIG,
): Promise<void> {
  client.connect(config);
  await vi.advanceTimersByTimeAsync(10);
  emitTauriEvent("ws-state", "open");
}

export interface AuthOkOptions {
  seq?: number;
  replaySource?: string;
  username?: string;
  serverName?: string;
  motd?: string;
}

export function authOkFrame(opts: AuthOkOptions = {}): string {
  return JSON.stringify({
    type: "auth_ok",
    ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
    payload: {
      user: { id: 1, username: opts.username ?? "a", avatar: null, role: "admin" },
      server_name: opts.serverName ?? "S",
      motd: opts.motd ?? "",
      ...(opts.replaySource !== undefined ? { replay_source: opts.replaySource } : {}),
    },
  });
}

export function emitAuthOk(opts: AuthOkOptions = {}): void {
  emitTauriEvent("ws-message", authOkFrame(opts));
}

export interface ChatFrameOptions {
  seq?: number | string;
  corrId?: string;
  id?: number;
  channelId?: number;
  username?: string;
  content?: string;
  timestamp?: string;
}

export function chatMessage(opts: ChatFrameOptions = {}) {
  return {
    type: "chat_message",
    ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
    ...(opts.corrId !== undefined ? { id: opts.corrId } : {}),
    payload: {
      id: opts.id ?? 1,
      channel_id: opts.channelId ?? 1,
      user: { id: 1, username: opts.username ?? "a", avatar: null },
      content: opts.content ?? "hi",
      reply_to: null,
      attachments: [] as unknown[],
      timestamp: opts.timestamp ?? "2026-01-01T00:00:00Z",
    },
  };
}

export function chatFrame(opts: ChatFrameOptions = {}): string {
  return JSON.stringify(chatMessage(opts));
}

export function emitChat(opts: ChatFrameOptions = {}): void {
  emitTauriEvent("ws-message", chatFrame(opts));
}

/** Drops the socket and runs the reconnect backoff until Rust reports open. */
export async function dropAndReopen(backoffMs = 1100): Promise<void> {
  emitTauriEvent("ws-state", "closed");
  await vi.advanceTimersByTimeAsync(backoffMs);
  emitTauriEvent("ws-state", "open");
}

/** Drops the socket and clears recorded invokes, leaving the backoff to the caller. */
export function dropAndClear(): void {
  emitTauriEvent("ws-state", "closed");
  mockInvoke.mockClear();
}

/** The `ws_send` invoke that carried the auth frame, if one was recorded. */
export function findAuthCall(): unknown[] | undefined {
  return mockInvoke.mock.calls.find(
    (c) =>
      c[0] === "ws_send" &&
      typeof c[1]?.message === "string" &&
      (c[1].message as string).includes('"type":"auth"'),
  );
}

export function sentAuthMessage(): { payload: { last_seq: number } } {
  const authCall = findAuthCall();
  expect(authCall).toBeDefined();
  return JSON.parse((authCall![1] as { message: string }).message);
}

export function expectAuthLastSeq(seq: number): void {
  expect(sentAuthMessage().payload.last_seq).toBe(seq);
}

export function wsConnectCalls(): unknown[][] {
  return mockInvoke.mock.calls.filter((c) => c[0] === "ws_connect");
}

/** Registers a listener on `type` and returns the array it appends to. */
export function collect(client: WsClient, type: Parameters<WsClient["on"]>[0]): unknown[] {
  const received: unknown[] = [];
  client.on(type, (p) => received.push(p));
  return received;
}

/** Parsed `ws_send` frames of one wire type, in send order. */
export function sentFramesOfType(type: string): unknown[][] {
  return mockInvoke.mock.calls.filter(
    (c) =>
      c[0] === "ws_send" &&
      typeof c[1]?.message === "string" &&
      (c[1].message as string).includes(`"type":"${type}"`),
  );
}

/** Drops the socket and asserts that no dial follows within `ms`. */
export async function expectNoReconnectAfterDrop(ms: number): Promise<void> {
  emitTauriEvent("ws-state", "closed");
  mockInvoke.mockClear();
  await vi.advanceTimersByTimeAsync(ms);
  expect(wsConnectCalls()).toHaveLength(0);
}

export function emitCertMismatch(host: string): void {
  emitTauriEvent("cert-tofu", {
    host,
    fingerprint: "sha256:NEW",
    status: "mismatch",
    message: "Stored: sha256:OLD",
  });
  expectConsole("error", /\[ws\] Certificate fingerprint mismatch/);
}

export function emitCertFirstUse(host: string): void {
  emitTauriEvent("cert-tofu", { host, fingerprint: "sha256:NEW", status: "first_use" });
  expectConsole("warn", /\[ws\] TOFU: first-use certificate/);
}

/** Sends the stock `chat_send` and returns the envelope id. */
export function sendChat(client: WsClient): string {
  return client.send({
    type: "chat_send",
    payload: { channel_id: 1, content: "hi", reply_to: null, attachments: [] },
  });
}

/** Records every send failure the client reports. */
export function trackSendFailures(client: WsClient): Array<{ id: string; code: string }> {
  const failures: Array<{ id: string; code: string }> = [];
  client.onSendFailure((id, code) => failures.push({ id, code }));
  return failures;
}

/** Makes every `ws_send` invoke reject with `message`; other commands resolve. */
export function rejectWsSend(message: string): void {
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "ws_send") throw new Error(message);
    return undefined;
  });
}

/** Opens the socket and completes the handshake with a stock auth_ok. */
export async function connectAndAuth(client: WsClient): Promise<void> {
  await openSocket(client);
  emitAuthOk();
}

/** Payload of the most recent auth frame sent over `ws_send`. */
export function lastAuthPayload(): Record<string, unknown> {
  const call = sentFramesOfType("auth").at(-1);
  expect(call).toBeDefined();
  return JSON.parse((call![1] as { message: string }).message).payload as Record<string, unknown>;
}

/** Records every state the client transitions to. */
export function trackStates(client: WsClient): ConnectionState[] {
  const states: ConnectionState[] = [];
  client.onStateChange((s) => states.push(s));
  return states;
}

/** Makes `ws_connect` reject with `reason`; other commands resolve. */
export function rejectWsConnect(reason: unknown): void {
  mockInvoke.mockImplementation((cmd: string) =>
    cmd === "ws_connect" ? Promise.reject(reason) : Promise.resolve(undefined),
  );
}
