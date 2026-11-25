// The room Info model: pure, from store states to what Info draws and says.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  qualityLine,
  roomInfoKey,
  roomInfoModel,
  securityText,
  summaryUsers,
  type RoomInfoInputs,
} from "../../../src/features/deck/roomInfoModel";
import type { Channel } from "../../../src/stores/channels.store";
import type { PeerVerification, VoiceConfig, VoiceUser } from "../../../src/stores/voice.store";
import { roomInfoText } from "../../../src/i18n/roomInfo";
import { voiceText } from "../../../src/i18n/voice";
import { makeChannel } from "../../helpers/channelFactory";
import { voiceUser } from "../../helpers/voiceUsers";
import { statsSample } from "../../helpers/connectionStatsSample";

const ME = 1;
const LOUNGE = 10;
const HALL = 11;
const DM = 20;
const TEXT = 30;

const CHANNELS: ReadonlyMap<number, Channel> = new Map([
  [LOUNGE, makeChannel({ id: LOUNGE, name: "Lounge", type: "voice", voiceMaxUsers: 8 })],
  [HALL, makeChannel({ id: HALL, name: "Hall", type: "voice", voiceMaxUsers: 0 })],
  [DM, makeChannel({ id: DM, name: "mira", type: "dm" })],
  [TEXT, makeChannel({ id: TEXT, name: "general", type: "text" })],
]);

function users(...list: VoiceUser[]): ReadonlyMap<number, VoiceUser> {
  return new Map(list.map((u) => [u.userId, u]));
}

const verification = (userId: number, status: PeerVerification["status"]): PeerVerification => ({
  userId,
  status,
  safetyNumber: null,
  sessionFingerprint: null,
});

function inputs(over: Partial<RoomInfoInputs> = {}): RoomInfoInputs {
  return {
    selfId: ME,
    currentChannelId: LOUNGE,
    channels: CHANNELS,
    voiceUsers: new Map([
      [
        LOUNGE,
        users(voiceUser(ME, { username: "me" }), voiceUser(2, { username: "Rin" }), voiceUser(3)),
      ],
    ]),
    voiceStatus: "connected",
    encryptionDegraded: false,
    peerVerifications: new Map(),
    musicSharers: new Set(),
    voiceConfig: null,
    ...over,
  };
}

function config(quality: string, bitrate: number): VoiceConfig {
  return {
    quality,
    bitrate,
    threshold_mode: "auto",
    mixing_threshold: 0,
    top_speakers: 0,
    max_users: 0,
  };
}

const stats = statsSample;

const SECURED = voiceText("widget.secured");

const audioOf = (c: VoiceConfig | null) => roomInfoModel(inputs({ voiceConfig: c }))!.audio;
const streamsOf = (over: Partial<RoomInfoInputs>) => roomInfoModel(inputs(over))!.streams;

describe("roomInfoModel: the room", () => {
  it("is null with no room, in a DM call, and for a channel that is not a voice room", () => {
    expect(roomInfoModel(inputs({ currentChannelId: null }))).toBeNull();
    expect(roomInfoModel(inputs({ currentChannelId: DM }))).toBeNull();
    expect(roomInfoModel(inputs({ currentChannelId: TEXT }))).toBeNull();
    expect(roomInfoModel(inputs({ currentChannelId: 999 }))).toBeNull();
  });

  it("names the room and counts everyone in it, you included, out of its limit", () => {
    const m = roomInfoModel(inputs())!;
    expect(m.channelId).toBe(LOUNGE);
    expect(m.roomName).toBe("Lounge");
    expect(m.users).toEqual({ count: 3, max: 8 });
    expect(summaryUsers(m)).toEqual({ text: "3/8", sr: "In the room: 3 of 8." });
  });

  it("with no limit the count stands alone", () => {
    const m = roomInfoModel(
      inputs({ currentChannelId: HALL, voiceUsers: new Map([[HALL, users(voiceUser(ME))]]) }),
    )!;
    expect(m.users).toEqual({ count: 1, max: 0 });
    expect(summaryUsers(m)).toEqual({ text: "1", sr: "In the room: 1." });
  });

  it("an empty room roster counts 0", () => {
    const m = roomInfoModel(inputs({ voiceUsers: new Map() }))!;
    expect(m.users.count).toBe(0);
  });
});

describe("roomInfoModel: Audio", () => {
  it.each([
    ["low", 32_000, "Low · 32 kbps"],
    ["medium", 64_000, "Medium · 64 kbps"],
    ["high", 128_000, "High · 128 kbps"],
  ])("%s at %i bit/s reads %s", (quality, bitrate, text) => {
    expect(audioOf(config(quality, bitrate))).toEqual({
      word: "",
      detail: text,
      level: "none",
      sr: text,
    });
  });

  it("an unknown quality string shows only the kbps figure", () => {
    expect(audioOf(config("ultra", 96_400)).detail).toBe("96 kbps");
    expect(audioOf(config("toString", 64_000)).detail).toBe("64 kbps");
  });

  it("no config, or a bitrate of 0, is Not known", () => {
    expect(audioOf(null)).toEqual({
      word: "",
      detail: "Not known",
      level: "none",
      sr: "Not known",
    });
    expect(audioOf(config("medium", 0)).detail).toBe("Not known");
  });
});

describe("securityText: precedence", () => {
  const cases: Array<{
    name: string;
    over: Partial<RoomInfoInputs>;
    word: string;
    detail: string;
    level: string;
    sr: string;
  }> = [
    {
      name: "degraded",
      over: { encryptionDegraded: true },
      word: "Unsecured",
      detail: "",
      level: "bad",
      sr: "Unsecured",
    },
    {
      name: "degraded while reconnecting",
      over: { encryptionDegraded: true, voiceStatus: "reconnecting" },
      word: "Unsecured",
      detail: "",
      level: "bad",
      sr: "Unsecured",
    },
    {
      name: "degraded outranks a key notice",
      over: {
        encryptionDegraded: true,
        peerVerifications: new Map([[2, verification(2, "mismatch")]]),
      },
      word: "Unsecured",
      detail: "",
      level: "bad",
      sr: "Unsecured",
    },
    {
      name: "reconnecting",
      over: { voiceStatus: "reconnecting" },
      word: "Reconnecting…",
      detail: "",
      level: "warn",
      sr: "Reconnecting…",
    },
    {
      name: "joining",
      over: { voiceStatus: "joining" },
      word: "Connecting…",
      detail: "",
      level: "warn",
      sr: "Connecting…",
    },
    {
      name: "idle with a room",
      over: { voiceStatus: "idle" },
      word: "Connecting…",
      detail: "",
      level: "warn",
      sr: "Connecting…",
    },
    {
      name: "securing",
      over: { voiceStatus: "securing" },
      word: "Securing…",
      detail: "",
      level: "warn",
      sr: "Securing…",
    },
    {
      name: "a notice before connected does not show",
      over: {
        voiceStatus: "securing",
        peerVerifications: new Map([[2, verification(2, "mismatch")]]),
      },
      word: "Securing…",
      detail: "",
      level: "warn",
      sr: "Securing…",
    },
    {
      name: "connected, a mismatch",
      over: { peerVerifications: new Map([[2, verification(2, "mismatch")]]) },
      word: "Blocked",
      detail: "(1)",
      level: "bad",
      sr: "Blocked. 1 participant: key does not match.",
    },
    {
      name: "connected, a key store that could not be read",
      over: { peerVerifications: new Map([[2, verification(2, "unknown")]]) },
      word: "Blocked",
      detail: "(1)",
      level: "bad",
      sr: "Blocked. 1 participant: key storage unavailable.",
    },
    {
      name: "connected, a new key",
      over: { peerVerifications: new Map([[2, verification(2, "changed")]]) },
      word: "New key",
      detail: "(1)",
      level: "warn",
      sr: "New key. 1 participant with a new key.",
    },
    {
      name: "connected, no key",
      over: { peerVerifications: new Map([[2, verification(2, "unverified")]]) },
      word: "No key",
      detail: "(1)",
      level: "none",
      sr: "No key. 1 participant with no key.",
    },
    {
      name: "connected, no notice",
      over: {},
      word: SECURED,
      detail: "",
      level: "ok",
      sr: SECURED,
    },
  ];

  it.each(cases)("$name", ({ over, word, detail, level, sr }) => {
    expect(securityText(inputs(over))).toEqual({ word, detail, level, sr });
  });

  it("the model's Security is securityText's", () => {
    const i = inputs({ voiceStatus: "joining" });
    expect(roomInfoModel(i)!.security).toEqual(securityText(i));
  });
});

describe("securityText: key notices", () => {
  const roster = new Map([
    [
      LOUNGE,
      users(
        voiceUser(ME),
        voiceUser(2),
        voiceUser(3),
        voiceUser(4),
        voiceUser(5),
        voiceUser(6),
        voiceUser(7),
      ),
    ],
  ]);
  const withPeers = (entries: Array<[number, PeerVerification["status"]]>) =>
    securityText(
      inputs({
        voiceUsers: roster,
        peerVerifications: new Map(entries.map(([id, st]) => [id, verification(id, st)])),
      }),
    );

  it("names the most serious and counts it; the spoken text names every non-zero notice", () => {
    const v = withPeers([
      [2, "mismatch"],
      [3, "changed"],
      [4, "changed"],
    ]);
    expect(v.word).toBe("Blocked");
    expect(v.detail).toBe("(1)");
    expect(v.sr).toBe("Blocked. 1 participant: key does not match. 2 participants with a new key.");
  });

  it("Blocked counts mismatch and unknown together, and the spoken text keeps them apart", () => {
    const v = withPeers([
      [2, "mismatch"],
      [3, "unknown"],
      [4, "unknown"],
      [5, "unverified"],
    ]);
    expect(v.word).toBe("Blocked");
    expect(v.detail).toBe("(3)");
    expect(v.sr).toBe(
      "Blocked. 1 participant: key does not match. 2 participants: key storage unavailable. 1 participant with no key.",
    );
  });

  it("New key outranks No key", () => {
    const v = withPeers([
      [2, "unverified"],
      [3, "changed"],
      [4, "unverified"],
    ]);
    expect(v.word).toBe("New key");
    expect(v.level).toBe("warn");
    expect(v.sr).toBe("New key. 1 participant with a new key. 2 participants with no key.");
  });

  it("verified peers, and peers with no entry yet, count nowhere", () => {
    expect(withPeers([[2, "verified"]]).word).toBe(SECURED);
    expect(withPeers([]).word).toBe(SECURED);
  });

  it("you never count", () => {
    expect(withPeers([[ME, "mismatch"]]).word).toBe(SECURED);
  });

  it("a peer outside the room never counts", () => {
    const v = securityText(
      inputs({ peerVerifications: new Map([[99, verification(99, "mismatch")]]) }),
    );
    expect(v.word).toBe(SECURED);
  });

  it("no value with a notice holds the Secured text anywhere", () => {
    for (const status of ["mismatch", "unknown", "changed", "unverified"] as const) {
      const v = withPeers([[2, status]]);
      for (const part of [v.word, v.detail, v.sr]) expect(part).not.toContain(SECURED);
    }
  });
});

describe("roomInfoModel: Streams", () => {
  it("is None with no share", () => {
    expect(streamsOf({})).toEqual({ word: "", detail: "None", level: "none", sr: "None" });
  });

  it("orders screen, then camera, then music, each by name; you are You", () => {
    const v = streamsOf({
      voiceUsers: new Map([
        [
          LOUNGE,
          users(
            voiceUser(ME, { username: "me", camera: true }),
            voiceUser(2, { username: "Rin", screenshare: true }),
            voiceUser(3, { username: "Juno", screenshare: true, camera: true }),
          ),
        ],
      ]),
      musicSharers: new Set([2]),
    });
    expect(v.word).toBe("");
    expect(v.sr).toBe("Juno · screen, Rin · screen, Juno · camera, You · camera, Rin · music");
    expect(v.detail).toBe("Juno · screen, Rin · screen, +3");
  });

  it("two shares are drawn whole", () => {
    const v = streamsOf({
      voiceUsers: new Map([
        [LOUNGE, users(voiceUser(ME), voiceUser(2, { username: "Rin", screenshare: true }))],
      ]),
      musicSharers: new Set([ME]),
    });
    expect(v.detail).toBe("Rin · screen, You · music");
    expect(v.sr).toBe(v.detail);
  });

  it("music counts only for users in the room, or you", () => {
    const v = streamsOf({ musicSharers: new Set([ME, 77]) });
    expect(v.sr).toBe("You · music");
  });

  it("a switch from A to B with a stale sharer from A shows no music entry", () => {
    const v = streamsOf({
      currentChannelId: HALL,
      voiceUsers: new Map([
        [LOUNGE, users(voiceUser(2, { username: "Rin" }))],
        [HALL, users(voiceUser(ME))],
      ]),
      musicSharers: new Set([2]),
    });
    expect(v.detail).toBe("None");
  });
});

describe("roomInfoKey", () => {
  it("is empty for no model", () => {
    expect(roomInfoKey(null)).toBe("");
  });

  it.each(["speaking", "muted", "deafened"] as const)("ignores %s", (flag) => {
    const before = roomInfoModel(inputs());
    const after = roomInfoModel(
      inputs({
        voiceUsers: new Map([
          [
            LOUNGE,
            users(
              voiceUser(ME, { username: "me" }),
              voiceUser(2, { username: "Rin", [flag]: true }),
              voiceUser(3),
            ),
          ],
        ]),
      }),
    );
    expect(roomInfoKey(after)).toBe(roomInfoKey(before));
  });

  it("changes with what Info draws", () => {
    const before = roomInfoKey(roomInfoModel(inputs()));
    expect(roomInfoKey(roomInfoModel(inputs({ voiceStatus: "joining" })))).not.toBe(before);
    expect(roomInfoKey(roomInfoModel(inputs({ voiceConfig: config("high", 128_000) })))).not.toBe(
      before,
    );
  });
});

describe("qualityLine", () => {
  it("null is Not measured, with no word and no level", () => {
    expect(qualityLine(null)).toEqual({
      word: "",
      detail: "Not measured",
      level: "none",
      sr: "Not measured",
    });
  });

  it("drops the ms figure while rtt is 0", () => {
    expect(qualityLine(stats({ rtt: 0 }))).toEqual({
      word: "Good",
      detail: "",
      level: "ok",
      sr: "Good",
    });
  });

  it("rounds the rtt", () => {
    expect(qualityLine(stats({ rtt: 18.4 })).detail).toBe(" · 18 ms");
  });

  it("leaves out loss below 1%, and shows it rounded from 1%", () => {
    expect(qualityLine(stats({ loss: 0.9 })).detail).toBe(" · 18 ms");
    expect(qualityLine(stats({ loss: 1 })).detail).toBe(" · 18 ms · 1% loss");
    expect(qualityLine(stats({ loss: 3.4 })).detail).toBe(" · 18 ms · 3% loss");
    expect(qualityLine(stats({ loss: 3.4 })).sr).toBe("Good · 18 ms · 3% loss");
  });

  it.each([
    ["excellent", "Good", "ok"],
    ["fair", "Fair", "warn"],
    ["poor", "Poor", "bad"],
    ["bad", "Bad", "bad"],
  ] as const)("%s reads %s at level %s", (quality, word, level) => {
    const v = qualityLine(stats({ quality }));
    expect(v.word).toBe(word);
    expect(v.level).toBe(level);
  });
});

describe("the roomInfo catalog", () => {
  // The catalog's whole source: every value, singular and plural, and every key.
  it("never says verified", () => {
    const source = readFileSync(join(process.cwd(), "src/i18n/roomInfo.ts"), "utf8");
    expect(source).toContain('defineCatalog("roomInfo"');
    expect(source.toLowerCase()).not.toContain("verif");
    expect(roomInfoText("srMismatch", { count: 2 })).toBe("2 participants: key does not match.");
  });
});
