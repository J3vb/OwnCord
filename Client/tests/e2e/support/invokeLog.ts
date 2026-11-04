/**
 * Reads what the app sent from the Tauri mock's own IPC log (`__invokeLog`):
 * the HTTP requests (`plugin:http|fetch`) and the WebSocket frames (`ws_send`).
 * No extra init script is needed, unlike `ipcCapture.ts`.
 */
import { expect, type Page } from "@playwright/test";

export interface FetchCall {
  readonly method: string;
  readonly url: string;
  readonly data: number[] | null;
  readonly headers: [string, string][];
}

export interface SentFrame {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}

interface InvokeEntry {
  readonly cmd: string;
  readonly args?: { readonly clientConfig?: FetchCall; readonly message?: string };
}

async function invokeLog(page: Page): Promise<InvokeEntry[]> {
  return page.evaluate(() => (window as unknown as { __invokeLog: InvokeEntry[] }).__invokeLog);
}

/** Every HTTP request the client issued, in order. */
export async function fetchCalls(page: Page): Promise<FetchCall[]> {
  const calls: FetchCall[] = [];
  for (const entry of await invokeLog(page)) {
    if (entry.cmd === "plugin:http|fetch" && entry.args?.clientConfig !== undefined) {
      calls.push(entry.args.clientConfig);
    }
  }
  return calls;
}

/** Poll until a request matching `predicate` has been sent, and return it. */
export async function waitForFetch(
  page: Page,
  predicate: (call: FetchCall) => boolean,
  timeout = 5_000,
): Promise<FetchCall> {
  let found: FetchCall | undefined;
  await expect(async () => {
    found = (await fetchCalls(page)).find(predicate);
    expect(found).toBeDefined();
  }).toPass({ timeout });
  return found!;
}

export function decodeBody(call: FetchCall): string | null {
  if (!Array.isArray(call.data)) return null;
  return new TextDecoder().decode(new Uint8Array(call.data));
}

/** Every WS frame the client sent that parses as JSON. */
export async function sentFrames(page: Page): Promise<SentFrame[]> {
  const frames: SentFrame[] = [];
  for (const entry of await invokeLog(page)) {
    if (entry.cmd !== "ws_send") continue;
    try {
      frames.push(JSON.parse(entry.args?.message ?? "{}") as SentFrame);
    } catch {
      // Not a JSON client frame; skip.
    }
  }
  return frames;
}

/** Poll until a frame of `type` accepted by `has` has gone out, and return it. */
export async function waitForSent(
  page: Page,
  type: string,
  has: (frame: SentFrame) => boolean = () => true,
  timeout = 5_000,
): Promise<SentFrame> {
  let found: SentFrame | undefined;
  await expect(async () => {
    found = (await sentFrames(page)).find((f) => f.type === type && has(f));
    expect(found).toBeDefined();
  }).toPass({ timeout });
  return found!;
}

/** Poll until a frame of `type` carrying `channelId` has gone out. */
export function sentTo(page: Page, type: string, channelId: number): Promise<SentFrame> {
  return waitForSent(page, type, (f) => f.payload?.channel_id === channelId);
}
