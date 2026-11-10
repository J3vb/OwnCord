/**
 * What a participant's volume menu offers a moderator: the server's verdict
 * per channel, the role-level explanation when it gave none, and the sockets
 * state that greys the actions out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authStore } from "@stores/auth.store";
import { channelsStore, setRoles, type Channel } from "@stores/channels.store";
import { setConnectionStatus } from "@stores/ui.store";
import type { VoiceUser } from "@stores/voice.store";
import { Permission } from "@lib/types";
import { voiceText } from "../../src/i18n/voice";
import { buildVoiceModOptions } from "../../src/features/channels/voiceModOptions";
import type { VoiceModerationCallbacks } from "../../src/features/channels/channelSidebarTypes";
import { makeChannel } from "../helpers/channelFactory";
import { resetAuthState, resetChannelsState } from "../helpers/storeSeeds";

const user: VoiceUser = {
  userId: 8,
  username: "bob",
  muted: false,
  deafened: false,
  speaking: false,
  camera: false,
  screenshare: false,
};

function seed(verdicts: Partial<Channel>): void {
  channelsStore.setState((prev) => ({
    ...prev,
    channels: new Map([
      [5, makeChannel({ id: 5, type: "voice", ...verdicts })],
      [6, makeChannel({ id: 6, name: "other voice", type: "voice" })],
      [7, makeChannel({ id: 7, name: "a text channel" })],
    ]),
  }));
}

function signInWith(permissions: number): void {
  setRoles([{ id: 9, name: "Mod", color: null, permissions }]);
  authStore.setState(() => ({
    token: "t",
    user: { id: 1, username: "me", avatar: null, role: "Mod" },
    serverName: "s",
    motd: "",
    isAuthenticated: true,
  }));
}

const callbacks = (): VoiceModerationCallbacks => ({
  onServerMute: vi.fn(),
  onServerDeafen: vi.fn(),
  onMove: vi.fn(),
  onDisconnect: vi.fn(),
});

beforeEach(() => {
  resetChannelsState();
  resetAuthState();
  setConnectionStatus("connected");
});

afterEach(() => {
  setConnectionStatus("disconnected");
});

describe("buildVoiceModOptions", () => {
  it("offers nothing without the page's callbacks", () => {
    seed({ canModerateVoice: true });
    expect(buildVoiceModOptions(5, user)).toBeUndefined();
  });

  it("offers every action, wired to the participant, to a channel the server lets the user moderate", () => {
    seed({ canModerateVoice: true, canMoveVoice: true });
    const cb = callbacks();
    const opts = buildVoiceModOptions(5, { ...user, serverMuted: true }, cb);
    expect(opts).toMatchObject({
      serverMuted: true,
      serverDeafened: false,
      moveTargets: [{ id: 6, name: "other voice" }],
    });
    if (typeof opts !== "object") throw new Error("expected options");
    expect(opts).not.toHaveProperty("disabledReason");
    opts.onServerMute?.(true);
    opts.onServerDeafen?.(true);
    opts.onMove(6);
    opts.onDisconnect?.();
    expect(cb.onServerMute).toHaveBeenCalledWith(5, 8, true);
    expect(cb.onServerDeafen).toHaveBeenCalledWith(5, 8, true);
    expect(cb.onMove).toHaveBeenCalledWith(8, 6);
    expect(cb.onDisconnect).toHaveBeenCalledWith(8);
  });

  it("gives a mute-only verdict no move targets", () => {
    seed({ canModerateVoice: true, canMoveVoice: false });
    expect(buildVoiceModOptions(5, user, callbacks())).toMatchObject({ moveTargets: [] });
  });

  it("gives a Move Members-only verdict just Move to", () => {
    seed({ canModerateVoice: false, canMoveVoice: true });
    const opts = buildVoiceModOptions(5, user, callbacks());
    expect(opts).toMatchObject({ moveTargets: [{ id: 6, name: "other voice" }] });
    expect(opts).not.toHaveProperty("onServerMute");
    expect(opts).not.toHaveProperty("onDisconnect");
  });

  it("hides the section when the server said no to both", () => {
    seed({ canModerateVoice: false, canMoveVoice: false });
    signInWith(Permission.MUTE_MEMBERS);
    expect(buildVoiceModOptions(5, user, callbacks())).toBeUndefined();
  });

  it("greys the actions out with the reason while the socket is down", () => {
    seed({ canModerateVoice: true });
    setConnectionStatus("reconnecting");
    expect(buildVoiceModOptions(5, user, callbacks())).toMatchObject({
      disabledReason: voiceText("volume.modReconnecting"),
    });
    setConnectionStatus("disconnected");
    expect(buildVoiceModOptions(5, user, callbacks())).toMatchObject({
      disabledReason: voiceText("volume.modNotConnected"),
    });
  });

  describe("when the server gave no verdict", () => {
    it("explains why to a role that holds MUTE_MEMBERS or MOVE_MEMBERS", () => {
      seed({});
      signInWith(Permission.MUTE_MEMBERS);
      expect(buildVoiceModOptions(5, user, callbacks())).toBe(voiceText("volume.modUnknown"));
      signInWith(Permission.MOVE_MEMBERS);
      expect(buildVoiceModOptions(5, user, callbacks())).toBe(voiceText("volume.modUnknown"));
    });

    it("says nothing to a role that holds neither", () => {
      seed({});
      signInWith(0);
      expect(buildVoiceModOptions(5, user, callbacks())).toBeUndefined();
    });

    it("says nothing when only one of the two verdicts is missing and it is no", () => {
      seed({ canModerateVoice: false });
      signInWith(Permission.MUTE_MEMBERS);
      expect(buildVoiceModOptions(5, user, callbacks())).toBeUndefined();
    });
  });
});
