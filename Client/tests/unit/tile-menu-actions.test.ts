import { describe, it, expect, vi, beforeEach } from "vitest";

const mockBuildVoiceModOptions = vi.hoisted(() => vi.fn((..._args: unknown[]) => "mod-options"));
const mockOpenProfile = vi.hoisted(() => vi.fn());

vi.mock("@components/ChannelSidebar", () => ({
  buildVoiceModOptions: (...args: unknown[]) => mockBuildVoiceModOptions(...args),
}));
vi.mock("../../src/features/profiles/openUserProfilePopup", () => ({
  openUserProfilePopup: (...args: unknown[]) => mockOpenProfile(...args),
}));

import { createTileMenuActions } from "../../src/pages/main-page/tileMenuActions";
import { channelsStore, type Channel } from "../../src/stores/channels.store";
import { voiceStore, type VoiceUser } from "../../src/stores/voice.store";
import type { WsClient } from "../../src/lib/ws";

const ws = { send: vi.fn() } as unknown as WsClient;
const VOICE = 10;
const DM = 20;

function channel(id: number, type: Channel["type"]): Channel {
  return { id, name: `c${id}`, type } as unknown as Channel;
}

function inCall(channelId: number | null, users: readonly number[]): void {
  const roster = new Map<number, VoiceUser>(
    users.map((userId) => [userId, { userId, username: `u${userId}` } as unknown as VoiceUser]),
  );
  voiceStore.setState((prev) => ({
    ...prev,
    currentChannelId: channelId,
    voiceUsers: channelId === null ? new Map() : new Map([[channelId, roster]]),
  }));
}

describe("createTileMenuActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    channelsStore.setState((prev) => ({
      ...prev,
      channels: new Map([
        [VOICE, channel(VOICE, "voice")],
        [DM, channel(DM, "dm")],
      ]),
    }));
  });

  it("builds the roster's moderation section for a person in your server voice channel", () => {
    inCall(VOICE, [7]);
    const actions = createTileMenuActions(ws, vi.fn(), vi.fn());

    expect(actions.moderation?.(7)).toBe("mod-options");
    const [channelId, user] = mockBuildVoiceModOptions.mock.calls[0]!;
    expect(channelId).toBe(VOICE);
    expect((user as VoiceUser).userId).toBe(7);
  });

  it("offers no moderation in a DM call, out of a call, or for someone not in the roster", () => {
    const actions = createTileMenuActions(ws, vi.fn(), vi.fn());
    inCall(DM, [7]);
    expect(actions.moderation?.(7)).toBeUndefined();
    inCall(null, []);
    expect(actions.moderation?.(7)).toBeUndefined();
    inCall(VOICE, [8]);
    expect(actions.moderation?.(7)).toBeUndefined();
    expect(mockBuildVoiceModOptions).not.toHaveBeenCalled();
  });

  it("opens the profile at the click with a working Message, and Message opens the DM", () => {
    const messageUser = vi.fn();
    const showChat = vi.fn();
    const actions = createTileMenuActions(ws, messageUser, showChat);

    actions.onProfile?.(7, 30, 40);
    const opts = mockOpenProfile.mock.calls[0]![0] as {
      userId: number;
      anchorX: number;
      anchorY: number;
      callbacks: { onMessage: (id: number) => void };
    };
    expect(opts).toMatchObject({ userId: 7, anchorX: 30, anchorY: 40 });
    opts.callbacks.onMessage(7);
    expect(messageUser).toHaveBeenCalledWith(7);

    actions.onMessage?.(9);
    expect(messageUser).toHaveBeenLastCalledWith(9);
    expect(showChat).toHaveBeenCalledTimes(2);
  });

  it("closes an open profile and drops a loading one when the page goes", () => {
    const close = vi.fn();
    mockOpenProfile.mockReturnValue(close);
    const actions = createTileMenuActions(ws, vi.fn(), vi.fn());
    actions.onProfile?.(7, 0, 0);
    const { signal } = mockOpenProfile.mock.calls[0]![0] as { signal: AbortSignal };
    expect(signal.aborted).toBe(false);

    actions.destroy();
    expect(signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
