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
import {
  drawVoiceChannelChrome,
  patchVoiceChannelChrome,
  drawVoiceUserRow,
  patchVoiceUserRow,
  VOICE_USER_PATCH_FIELDS,
} from "../../src/features/channels/voiceRow.view";
import { createAvatarElement } from "../../src/components/message-list/avatar";
import { reconcileModels, sameModel } from "../../src/lib/reconcile";
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
    localSafetyNumber: null,
    voiceMembers: new Map(),
    selfId: SELF,
    connectionStatus: "connected",
    timeout: null,
    movable: [],
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

    // The own safety number leads the title, ahead of the session fingerprint.
    const signed = voiceUserModel(
      user(SELF),
      10,
      inputs({ localSafetyNumber: "AB12 CD34", localSessionFingerprint: "SELF-FP" }),
      silenced,
    );
    expect(signed.ownFingerprintTitle).toMatch(/^Your safety number: AB12 CD34 · .*SELF-FP/);
    expect(
      voiceUserModel(user(PEER), 10, inputs({ localSafetyNumber: "AB12 CD34" }), silenced)
        .ownFingerprintTitle,
    ).toBeNull();

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

  it("draggable needs moderation, another user, a live socket and a movable channel", () => {
    const mod: VoiceUserContext = { ...ctx, moderation: true };
    const ok = inputs({ movable: [10] });
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

describe("voiceChannelChrome mentions", () => {
  it("carries the channel's mention count and never its unread count", () => {
    const chrome = voiceChannelChrome(channel({ mentionCount: 3, unreadCount: 9 }), inputs());
    expect(chrome.mentionCount).toBe(3);
    expect("unread" in chrome).toBe(false);
  });
});

describe("voice row mention badge", () => {
  const chromeFor = (mentionCount: number) =>
    voiceChannelChrome(channel({ mentionCount, unreadCount: 9 }), inputs());

  it("draws the text row's mention badge markup, and no unread marker", () => {
    const wrapper = drawVoiceChannelChrome(chromeFor(3));
    const badge = wrapper.querySelector(".channel-item > .mention-badge");
    expect(badge?.textContent).toBe("3");
    expect(badge?.getAttribute("data-testid")).toBe("channel-mentions-10");
    expect(badge?.getAttribute("title")).toBe("3 mentions");
    expect(wrapper.querySelector(".unread")).toBeNull();
    expect(drawVoiceChannelChrome(chromeFor(0)).querySelector(".mention-badge")).toBeNull();
  });

  it("patches the badge in, up and out, and keeps it after the capacity badge", () => {
    const wrapper = drawVoiceChannelChrome(chromeFor(0));
    patchVoiceChannelChrome(wrapper, chromeFor(2));
    expect(wrapper.querySelector(".mention-badge")?.textContent).toBe("2");
    patchVoiceChannelChrome(wrapper, chromeFor(5));
    expect(wrapper.querySelectorAll(".mention-badge")).toHaveLength(1);
    expect(wrapper.querySelector(".mention-badge")?.textContent).toBe("5");
    patchVoiceChannelChrome(wrapper, chromeFor(0));
    expect(wrapper.querySelector(".mention-badge")).toBeNull();
  });
});

describe("builders read no store", () => {
  it("voiceUserModel, voiceChannelChrome and channelVoiceUsers take the snapshot only", () => {
    const snap = inputs({
      peerVerifications: new Map([[PEER, verification(PEER, "verified", "1")]]),
      localSessionFingerprint: "FP",
      movable: [10],
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

describe("voice rows through reconcileModels", () => {
  function render(list: HTMLElement, snap: VoiceRowInputs, users: readonly VoiceUser[]): void {
    reconcileModels(list, users, {
      key: (u) => String(u.userId),
      model: (u) => voiceUserModel(u, 10, snap, ctx),
      patch: { fields: VOICE_USER_PATCH_FIELDS, apply: patchVoiceUserRow },
      create: (m) => drawVoiceUserRow(m, createAvatarElement),
    });
  }
  const row = (list: HTMLElement): Element => list.querySelector(`[data-voice-uid="${PEER}"]`)!;

  it("rebuilds a verified row as mismatch, never patching the badge", () => {
    const list = document.createElement("div");
    const peer = user(PEER);
    render(
      list,
      inputs({ peerVerifications: new Map([[PEER, verification(PEER, "verified", "123")]]) }),
      [peer],
    );
    const before = row(list);
    expect(before.querySelector(".vu-verify.verified")).not.toBeNull();
    render(
      list,
      inputs({ peerVerifications: new Map([[PEER, verification(PEER, "mismatch", "123")]]) }),
      [peer],
    );
    const after = row(list);
    expect(after).not.toBe(before);
    expect(after.querySelector(".vu-verify.mismatch")).not.toBeNull();
    expect(after.querySelector(".vu-verify.verified")).toBeNull();
  });

  it("redraws the badge title when only the fingerprint changes", () => {
    const list = document.createElement("div");
    const peer = user(PEER);
    const at = (fp: string): VoiceRowInputs =>
      inputs({ peerVerifications: new Map([[PEER, verification(PEER, "unverified", null, fp)]]) });
    render(list, at("aaaa"), [peer]);
    const title = (): string | null => row(list).querySelector(".vu-verify")!.getAttribute("title");
    const first = title();
    render(list, at("bbbb"), [peer]);
    expect(title()).not.toBe(first);
  });

  it("keeps the row node when only speaking changes", () => {
    const list = document.createElement("div");
    render(list, inputs(), [user(PEER)]);
    const before = row(list);
    render(list, inputs(), [user(PEER, { speaking: true })]);
    expect(row(list)).toBe(before);
    expect(before.classList.contains("speaking")).toBe(true);
  });
});
