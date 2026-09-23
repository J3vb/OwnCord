// B9-7: NSFW consent is the server's per-account acknowledgement, held in the
// channel store and enforced before any content request leaves the client.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockFetch } = vi.hoisted(() => ({ mockFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: mockFetch }));
vi.mock("../../lib/httpProxy", () => ({
  ensureHttpProxy: (host: string) => Promise.resolve(`https://${host}`),
  stopHttpProxy: () => Promise.resolve(),
}));

import { ApiClientError, createApiClient } from "../../lib/api";
import type { ReadyChannel } from "../../lib/types";
import {
  addChannel,
  channelsStore,
  resetChannelsStore,
  setChannels,
  setNsfwAcknowledged,
  updateChannel,
} from "../../stores/channels.store";
import { handleNsfwAck } from "../channels/wsHandlers";
import { NSFW_ACKNOWLEDGEMENT_REQUIRED, nsfwConsentRequired, nsfwContentBlocked } from "./nsfw";

const SPICY = 7;
const PLAIN = 8;

function ready(ack?: boolean): void {
  const spicy: ReadyChannel = {
    id: SPICY,
    name: "spicy",
    type: "text",
    category: null,
    position: 0,
    nsfw: true,
    ...(ack === undefined ? {} : { nsfw_acknowledged: ack }),
  };
  setChannels([spicy, { id: PLAIN, name: "plain", type: "text", category: null, position: 1 }]);
}

function json(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    headers: new Headers(),
  } as unknown as Response;
}

beforeEach(() => {
  resetChannelsStore();
  mockFetch.mockReset();
});

describe("nsfwConsentRequired", () => {
  it("gates only a labelled channel without a confirmed acknowledgement", () => {
    expect(nsfwConsentRequired(undefined)).toBe(false);
    expect(nsfwConsentRequired({ nsfw: false })).toBe(false);
    expect(nsfwConsentRequired({ nsfw: true })).toBe(true);
    expect(nsfwConsentRequired({ nsfw: true, nsfwAcknowledged: false })).toBe(true);
    expect(nsfwConsentRequired({ nsfw: true, nsfwAcknowledged: true })).toBe(false);
  });
});

describe("consent state in the channel store", () => {
  it("takes the acknowledgement from ready, failing closed when it is absent", () => {
    ready(true);
    expect(nsfwContentBlocked(SPICY)).toBe(false);
    ready();
    expect(nsfwContentBlocked(SPICY)).toBe(true);
    expect(nsfwContentBlocked(PLAIN)).toBe(false);
  });

  it("never migrates a leftover local acknowledgement into consent", () => {
    sessionStorage.setItem(`owncord:nsfw-ack:${SPICY}`, "1");
    ready(false);
    expect(nsfwContentBlocked(SPICY)).toBe(true);
    sessionStorage.clear();
  });

  it("follows nsfw_ack from another device both ways", () => {
    ready(false);
    handleNsfwAck({ channel_id: SPICY, acknowledged: true });
    expect(nsfwContentBlocked(SPICY)).toBe(false);
    handleNsfwAck({ channel_id: SPICY, acknowledged: false });
    expect(nsfwContentBlocked(SPICY)).toBe(true);
  });

  it("drops the acknowledgement when the label is cleared, so a relabel gates again", () => {
    ready(true);
    updateChannel({ id: SPICY, nsfw: false });
    expect(channelsStore.getState().channels.get(SPICY)?.nsfwAcknowledged).toBe(false);
    updateChannel({ id: SPICY, nsfw: true });
    expect(nsfwContentBlocked(SPICY)).toBe(true);
  });

  it("keeps the acknowledgement across unrelated updates and a re-sent channel_create", () => {
    ready(true);
    updateChannel({ id: SPICY, topic: "new topic", nsfw: true });
    addChannel({ id: SPICY, name: "spicy", type: "text", category: null, position: 0, nsfw: true });
    expect(nsfwContentBlocked(SPICY)).toBe(false);
  });

  it("ignores an acknowledgement for an unlabelled or unknown channel", () => {
    ready(false);
    setNsfwAcknowledged(PLAIN, true);
    setNsfwAcknowledged(999, true);
    expect(nsfwContentBlocked(PLAIN)).toBe(false);
    expect(channelsStore.getState().channels.get(PLAIN)?.nsfwAcknowledged).toBe(false);
    expect(channelsStore.getState().channels.has(999)).toBe(false);
  });
});

async function refusal(p: Promise<unknown>): Promise<ApiClientError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiClientError);
  return err as ApiClientError;
}

describe("content admission at the API client", () => {
  let api: ReturnType<typeof createApiClient>;

  beforeEach(() => {
    api = createApiClient({ host: "chat.example.com", token: "t" });
  });

  it("sends no content request for a gated channel, on any read path", async () => {
    ready(false);
    const reads = [
      api.getMessages(SPICY, { limit: 50 }),
      api.getMessagesAround(SPICY, 1),
      api.getPins(SPICY),
      api.getReactionUsers(SPICY, 1, "👍"),
      api.search("hello", { channelId: SPICY }),
    ];
    for (const err of await Promise.all(reads.map(refusal))) {
      expect(err.status).toBe(403);
      expect(err.code).toBe(NSFW_ACKNOWLEDGEMENT_REQUIRED);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("leaves unlabelled channels and server-wide search to the server", async () => {
    ready(false);
    mockFetch.mockResolvedValue(json({ messages: [], has_more: false, results: [] }));
    await api.getMessages(PLAIN);
    await api.search("hello");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("fetches once consent is confirmed", async () => {
    ready(true);
    mockFetch.mockResolvedValue(json({ messages: [], has_more: false }));
    await expect(api.getMessages(SPICY)).resolves.toEqual({ messages: [], has_more: false });
  });

  it("discards a response that lands after consent was withdrawn", async () => {
    ready(true);
    let respond!: (r: Response) => void;
    mockFetch.mockReturnValue(new Promise<Response>((r) => (respond = r)));
    const read = api.getMessages(SPICY);
    await vi.waitFor(() => expect(mockFetch).toHaveBeenCalled());
    setNsfwAcknowledged(SPICY, false);
    respond(json({ messages: [{ id: 1 }], has_more: false }));
    expect((await refusal(read)).code).toBe(NSFW_ACKNOWLEDGEMENT_REQUIRED);
  });

  it("acknowledges and revokes through the B5-7 route", async () => {
    mockFetch.mockResolvedValue(json(undefined, 204));
    await api.acknowledgeNsfw(SPICY);
    await api.revokeNsfw(SPICY);
    const calls = mockFetch.mock.calls.map(([url, init]) => [
      String(url),
      (init as RequestInit).method,
    ]);
    expect(calls).toEqual([
      [`https://chat.example.com/api/v1/channels/${SPICY}/nsfw-acknowledgement`, "PUT"],
      [`https://chat.example.com/api/v1/channels/${SPICY}/nsfw-acknowledgement`, "DELETE"],
    ]);
  });
});
