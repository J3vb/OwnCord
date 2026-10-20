/**
 * The voice row model builders (voiceRowModel.ts): pure functions of a
 * snapshot. The E2EE rule they keep: a peer's badge comes only from that
 * peer's own verification entry, and with none there is no badge at all.
 */

import { describe, it, expect } from "vitest";
import {
  channelVoiceUsers,
  voiceChannelChrome,
  voiceUserModel,
  type VoiceRowInputs,
  type VoiceUserContext,
} from "../../src/features/channels/voiceRowModel";
import { drawVoiceUserRow } from "../../src/features/channels/voiceRow.view";
import { createAvatarElement } from "../../src/components/message-list/avatar";
import { sameModel } from "../../src/lib/reconcile";
import type { Channel } from "../../src/stores/channels.store";
import type { Member } from "../../src/stores/members.store";
import type { PeerVerification, VoiceUser } from "../../src/stores/voice.store";
import { assertNoStoreReads } from "../helpers/storeReadGuard";

const SELF = 1;
const PEER = 2;

function user(userId: number, over: Partial<VoiceUser> = {}): VoiceUser {
  return {
    userId,
    username: `user${userId}`,
    muted: false,
    deafened: false,
    speaking: false,
    camera: false,
    screenshare: false,
    serverMuted: false,
    serverDeafened: false,
    ...over,
  };
}

function verification(
  userId: number,
  status: PeerVerification["status"],
  safetyNumber: string | null = null,
  sessionFingerprint: string | null = null,
): PeerVerification {
  return { userId, status, safetyNumber, sessionFingerprint };
}

function inputs(over: Partial<VoiceRowInputs> = {}): VoiceRowInputs {
  return {
    voiceUsers: new Map([
      [
        10,
        new Map([
          [SELF, user(SELF)],
          [PEER, user(PEER)],
        ]),
      ],
    ]),
    currentChannelId: null,
    peerVerifications: new Map(),
    localSessionFingerprint: null,
    voiceMembers: new Map(),
    selfId: SELF,
    connectionStatus: "connected",
    timeout: null,
    moderatable: [],
    localMute: {},
    ...over,
  };
}

const ctx: VoiceUserContext = {
  avatarColor: () => "#5865f2",
  localSilenced: () => false,
  moderation: false,
};

function channel(over: Partial<Channel> = {}): Channel {
  return {
    id: 10,
    name: "lobby",
    type: "voice",
    category: null,
    position: 0,
    unreadCount: 0,
    lastMessageId: null,
    mentionCount: 0,
    nsfw: false,
    isPrivate: false,
    voiceMaxUsers: 0,
    ...over,
  } as Channel;
}

const STATUSES: readonly PeerVerification["status"][] = [
  "verified",
  "changed",
  "unverified",
  "mismatch",
  "unknown",
];

describe("voiceUserModel", () => {
  it("verify is null without an entry", () => {
    // An entry for someone else must not leak onto this row.
    const snap = inputs({ peerVerifications: new Map([[3, verification(3, "verified", "1")]]) });
    expect(voiceUserModel(user(PEER), 10, snap, ctx).verify).toBeNull();
    const row = drawVoiceUserRow(voiceUserModel(user(PEER), 10, snap, ctx), createAvatarElement);
    expect(row.querySelector(".vu-verify")).toBeNull();
  });

  it("only status verified draws shield-check", () => {
    for (const status of STATUSES) {
      const snap = inputs({
        peerVerifications: new Map([[PEER, verification(PEER, status, "12345", "ABCD")]]),
      });
      const model = voiceUserModel(user(PEER), 10, snap, ctx);
      expect(model.verify?.cls).toBe(status);
      const row = drawVoiceUserRow(model, createAvatarElement);
      const badge = row.querySelector(`.vu-verify.${status}`);
      expect(badge, status).not.toBeNull();
      const icon = badge?.querySelector("svg")?.getAttribute("data-icon");
      expect(icon === "shield-check", status).toBe(status === "verified");
      expect(row.querySelector('[data-icon="shield-check"]') !== null, status).toBe(
        status === "verified",
      );
    }
  });

  it("a changed fingerprint at the same status changes the model", () => {
    const at = (fp: string): VoiceRowInputs =>
      inputs({ peerVerifications: new Map([[PEER, verification(PEER, "unverified", null, fp)]]) });
    const a = voiceUserModel(user(PEER), 10, at("AAAA"), ctx);
    const b = voiceUserModel(user(PEER), 10, at("BBBB"), ctx);
    expect(sameModel(a, b)).toBe(false);
    expect(b.verify?.title).toContain("BBBB");
  });

  it("self gets no localMuted, verify from its own entry only, and the own fingerprint", () => {
    const silenced: VoiceUserContext = { ...ctx, localSilenced: () => true };
    const snap = inputs({
      localSessionFingerprint: "SELF-FP",
      peerVerifications: new Map([[PEER, verification(PEER, "verified", "999")]]),
    });
    const self = voiceUserModel(user(SELF), 10, snap, silenced);
    expect(self.self).toBe(true);
    expect(self.localMuted).toBe(false);
    expect(self.verify).toBeNull();
    expect(self.ownFingerprintTitle).toContain("SELF-FP");

    const withOwn = inputs({
      localSessionFingerprint: "SELF-FP",
      peerVerifications: new Map([[SELF, verification(SELF, "unknown")]]),
    });
    expect(voiceUserModel(user(SELF), 10, withOwn, silenced).verify?.cls).toBe("unknown");

    const peer = voiceUserModel(user(PEER), 10, snap, silenced);
    expect(peer.self).toBe(false);
    expect(peer.localMuted).toBe(true);
    expect(peer.ownFingerprintTitle).toBeNull();
    expect(peer.verify?.cls).toBe("verified");

    // No fingerprint yet: no own badge.
    expect(voiceUserModel(user(SELF), 10, inputs(), silenced).ownFingerprintTitle).toBeNull();
  });

  it("audio normalises a missing serverMuted", () => {
    const bare = (over: Partial<VoiceUser>): VoiceUser => {
      const { serverMuted: _m, serverDeafened: _d, ...rest } = user(PEER, over);
      return rest;
    };
    for (const over of [{ muted: true }, { muted: true, deafened: true }, {}]) {
      expect(
        sameModel(
          voiceUserModel(bare(over), 10, inputs(), ctx),
          voiceUserModel(user(PEER, over), 10, inputs(), ctx),
        ),
      ).toBe(true);
    }
    expect(voiceUserModel(user(PEER, { muted: true }), 10, inputs(), ctx).audio).toEqual({
      icon: "mic-off",
      server: false,
      title: null,
    });
    const deafServerMuted = voiceUserModel(
      user(PEER, { muted: true, deafened: true, serverMuted: true }),
      10,
      inputs(),
      ctx,
    ).audio;
    expect(deafServerMuted?.icon).toBe("headphones-off");
    expect(deafServerMuted?.server).toBe(true);
    expect(voiceUserModel(user(PEER), 10, inputs(), ctx).audio).toBeNull();
  });

  it("names the member's display name, else the username, else Unknown", () => {
    const member = { id: PEER, username: "user2", displayName: "Nick", avatar: "/a" } as Member;
    const named = voiceUserModel(
      user(PEER),
      10,
      inputs({ voiceMembers: new Map([[PEER, member]]) }),
      ctx,
    );
    expect(named.name).toBe("Nick");
    expect(named.avatarName).toBe("Nick");
    expect(named.avatarUrl).toBe("/a");
    expect(voiceUserModel(user(PEER), 10, inputs(), ctx).name).toBe("user2");
    expect(voiceUserModel(user(PEER, { username: "" }), 10, inputs(), ctx).name).toBe("Unknown");
  });

  it("draggable needs moderation, another user, a live socket and a moderatable channel", () => {
    const mod: VoiceUserContext = { ...ctx, moderation: true };
    const ok = inputs({ moderatable: [10] });
    expect(voiceUserModel(user(PEER), 10, ok, mod).draggable).toBe(true);
    expect(voiceUserModel(user(SELF), 10, ok, mod).draggable).toBe(false);
    expect(voiceUserModel(user(PEER), 10, ok, ctx).draggable).toBe(false);
    expect(voiceUserModel(user(PEER), 10, inputs(), mod).draggable).toBe(false);
    expect(
      voiceUserModel(user(PEER), 10, { ...ok, connectionStatus: "reconnecting" }, mod).draggable,
    ).toBe(false);
  });
});

describe("voiceChannelChrome", () => {
  it("draws joined, capacity, and the frozen and timeout reasons by precedence", () => {
    const timeout = { expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const ch = channel({ voiceMaxUsers: 5 });
    const plain = voiceChannelChrome(ch, inputs());
    expect(plain.joined).toBe(false);
    expect(plain.frozenReason).toBeNull();
    expect(plain.timeoutReason).toBeNull();
    expect(plain.capacity?.label).toBe("2/5");
    expect(voiceChannelChrome(channel(), inputs()).capacity).toBeNull();

    const timedOut = voiceChannelChrome(ch, inputs({ timeout }));
    expect(timedOut.timeoutReason).not.toBeNull();
    expect(timedOut.frozenReason).toBe(timedOut.timeoutReason);

    // Joined: a timeout never blocks the leave.
    const joined = voiceChannelChrome(ch, inputs({ timeout, currentChannelId: 10 }));
    expect(joined.joined).toBe(true);
    expect(joined.timeoutReason).toBeNull();
    expect(joined.frozenReason).toBeNull();

    // The socket state wins over the timeout for the frozen reason.
    const down = voiceChannelChrome(ch, inputs({ timeout, connectionStatus: "reconnecting" }));
    expect(down.frozenReason).toBe("Reconnecting…");
    expect(down.timeoutReason).not.toBeNull();
    expect(voiceChannelChrome(ch, inputs({ connectionStatus: "disconnected" })).frozenReason).toBe(
      "Not connected",
    );
  });
});

describe("builders read no store", () => {
  it("voiceUserModel, voiceChannelChrome and channelVoiceUsers take the snapshot only", () => {
    const snap = inputs({
      peerVerifications: new Map([[PEER, verification(PEER, "verified", "1")]]),
      localSessionFingerprint: "FP",
      moderatable: [10],
      timeout: { expiresAt: new Date(Date.now() + 60_000).toISOString() },
    });
    assertNoStoreReads(() => {
      for (const u of channelVoiceUsers(snap, 10)) {
        voiceUserModel(u, 10, snap, { ...ctx, moderation: true });
      }
      voiceChannelChrome(channel({ voiceMaxUsers: 3, nsfw: true, isPrivate: true }), snap);
    });
  });
});
