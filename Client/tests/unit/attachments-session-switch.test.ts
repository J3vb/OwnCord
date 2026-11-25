/**
 * A server file request carries the sign-in of the session it was started in,
 * and only to that session's server. A request still in flight when the user
 * switches server never picks up the next server's token, and nothing counts
 * as the server's own URL between the switch and the next main page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mocks from "../helpers/attachmentsMocks";

interface Recorded {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly settle: (res: unknown) => void;
}

const { recorded, ensureHttpProxy, nativeFetch } = vi.hoisted(() => {
  const recorded: Recorded[] = [];
  return {
    recorded,
    // Each host has its own loopback tunnel, so the test can tell where a request went.
    ensureHttpProxy: (host: string): Promise<string> =>
      Promise.resolve(`http://127.0.0.1:1/t-${host}`),
    nativeFetch: (url: string, init?: { headers?: Record<string, string> }): Promise<unknown> =>
      new Promise((resolve) => {
        recorded.push({ url, headers: { ...init?.headers }, settle: resolve });
      }),
  };
});

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: nativeFetch }));
vi.mock("@lib/net/httpProxy", () => ({ ensureHttpProxy, stopHttpProxy: () => Promise.resolve() }));
vi.mock("../../src/platform/desktop/externalContent", () =>
  mocks.externalContentMock(vi.fn(), mocks.brokerImageMock),
);
vi.stubGlobal("indexedDB", mocks.failingIndexedDb());

import { authStore, clearAuth } from "../../src/stores/auth.store";
import {
  clearAttachmentCaches,
  setServerHost,
} from "../../src/features/messaging/content/attachments";
import {
  fetchServerFile,
  isServerUrl,
} from "../../src/features/messaging/content/attachmentServerFetch";
import { getFileLink } from "../../src/features/messaging/content/attachmentMedia";
import { fetchAvatarObjectUrl } from "../../src/features/profiles/avatarSource";

URL.createObjectURL = vi.fn(() => "blob:test-image");
URL.revokeObjectURL = vi.fn();

const FILE_URL = "https://a.test/api/v1/files/x";

function signIn(token: string): void {
  authStore.setState((prev) => ({ ...prev, token, uploadPolicy: { thumbnails: true } }));
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function notFound(): unknown {
  return { ok: false, status: 404, headers: { get: () => null } };
}

/** Every Authorization header sent to the a.test tunnel. */
function tokensSentToA(): string[] {
  return recorded
    .filter((r) => r.url.startsWith("http://127.0.0.1:1/t-a.test/"))
    .map((r) => r.headers["Authorization"] ?? "");
}

beforeEach(() => {
  recorded.length = 0;
  clearAuth("user");
  clearAttachmentCaches();
  setServerHost("a.test");
  signIn("TOKEN_A");
});

afterEach(() => {
  clearAuth("user");
});

describe("server file requests across a server switch", () => {
  it("never sends the next server's token to the server an avatar request started on", async () => {
    const avatar = fetchAvatarObjectUrl(FILE_URL, 128);
    await flush();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.url).toBe("http://127.0.0.1:1/t-a.test/api/v1/files/x/thumb?size=128");
    expect(recorded[0]!.headers["Authorization"]).toBe("Bearer TOKEN_A");

    clearAuth("server_switch");
    signIn("TOKEN_B");
    recorded[0]!.settle(notFound());
    await flush();

    expect(tokensSentToA()).not.toContain("Bearer TOKEN_B");
    // The switch ended the session the avatar was asked for: no second request.
    expect(recorded).toHaveLength(1);
    expect(await avatar).toBeNull();
  });

  it("counts no URL as the server's own after the session ends, until a host is set again", () => {
    expect(isServerUrl(FILE_URL)).toBe(true);
    clearAuth("server_switch");
    signIn("TOKEN_B");
    expect(isServerUrl(FILE_URL)).toBe(false);
    setServerHost("b.test");
    expect(isServerUrl("https://b.test/api/v1/files/y")).toBe(true);
    expect(isServerUrl(FILE_URL)).toBe(false);
  });

  it("sends nothing when the session changes while the tunnel is being opened", async () => {
    const pending = fetchServerFile(FILE_URL);
    // The tunnel resolves on a later microtask; the session ends before it does.
    clearAuth("server_switch");
    signIn("TOKEN_B");
    await expect(pending).rejects.toThrow();
    await flush();
    expect(recorded).toHaveLength(0);
  });

  it("sends the token of an unchanged session as before", async () => {
    const pending = fetchServerFile(FILE_URL);
    await flush();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.headers["Authorization"]).toBe("Bearer TOKEN_A");
    recorded[0]!.settle(notFound());
    await expect(pending).resolves.toMatchObject({ status: 404 });
  });

  it("asks for no streaming link once the session changed under the request", async () => {
    const link = getFileLink(FILE_URL);
    clearAuth("server_switch");
    signIn("TOKEN_B");
    await flush();
    expect(tokensSentToA()).not.toContain("Bearer TOKEN_B");
    expect(recorded).toHaveLength(0);
    expect(await link).toBeNull();
  });
});
