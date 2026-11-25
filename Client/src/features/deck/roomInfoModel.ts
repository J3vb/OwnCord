/**
 * The room Info model: what Command Deck's Info block shows about the server
 * voice room you are in, built from store states only (no DOM, no store
 * reads). The panel draws it; the Security and Quality values are built once
 * here so the rows and the short-window summary say the same thing.
 *
 * Security never describes who a person is: "Secured" means the call's
 * encryption runs and no key notice is in the room, and any notice replaces it.
 */
import type { ConnectionStats, QualityLevel } from "@lib/voice/connectionStats";
import type { Channel } from "@stores/channels.store";
import type {
  PeerVerification,
  VoiceConfig,
  VoiceState,
  VoiceStatus,
  VoiceUser,
} from "@stores/voice.store";
import { roomInfoText } from "../../i18n/roomInfo";
import { voiceText } from "../../i18n/voice";

export type InfoLevel = "ok" | "warn" | "bad" | "none";

export interface RoomInfoInputs {
  readonly selfId: number | null;
  readonly currentChannelId: number | null;
  readonly channels: ReadonlyMap<number, Channel>;
  readonly voiceUsers: VoiceState["voiceUsers"];
  readonly voiceStatus: VoiceStatus;
  readonly encryptionDegraded: boolean;
  /** Empty when the store has none. */
  readonly peerVerifications: ReadonlyMap<number, PeerVerification>;
  /** Empty when the store has none; scoped to the room here. */
  readonly musicSharers: ReadonlySet<number>;
  readonly voiceConfig: VoiceConfig | null;
}

/** A value as drawn: a never-cut word ("" for none), a cuttable detail, a level, and its spoken text. */
export interface InfoValue {
  readonly word: string;
  readonly detail: string;
  readonly level: InfoLevel;
  readonly sr: string;
}

export interface RoomInfoModel {
  readonly channelId: number;
  readonly roomName: string;
  /** max 0 = no limit. */
  readonly users: { readonly count: number; readonly max: number };
  /** word "", all in detail. */
  readonly audio: InfoValue;
  readonly security: InfoValue;
  /** word "", all in detail. */
  readonly streams: InfoValue;
}

const AUDIO_WORDS: Readonly<Record<string, "audioLow" | "audioMedium" | "audioHigh">> = {
  low: "audioLow",
  medium: "audioMedium",
  high: "audioHigh",
};

/** The poller's quality level as a word and a level. */
const QUALITY: Readonly<
  Record<
    QualityLevel,
    {
      readonly word: "stats.excellent" | "stats.fair" | "stats.poor" | "stats.bad";
      readonly level: InfoLevel;
    }
  >
> = {
  excellent: { word: "stats.excellent", level: "ok" },
  fair: { word: "stats.fair", level: "warn" },
  poor: { word: "stats.poor", level: "bad" },
  bad: { word: "stats.bad", level: "bad" },
};

/** The call's state before it is connected; `idle` with a room reads as connecting. */
const STATE_WORDS: Readonly<
  Record<
    Exclude<VoiceStatus, "connected">,
    "status.reconnectingShort" | "status.joining" | "status.securing"
  >
> = {
  reconnecting: "status.reconnectingShort",
  joining: "status.joining",
  idle: "status.joining",
  securing: "status.securing",
};

/** The most streams drawn before "+N". */
const STREAMS_DRAWN = 2;

/** A value that is all detail, with its spoken text the same. */
function detailOnly(detail: string): InfoValue {
  return { word: "", detail, level: "none", sr: detail };
}

/** A value that is one word, spoken as itself. */
function wordOnly(word: string, level: InfoLevel): InfoValue {
  return { word, detail: "", level, sr: word };
}

/** The server voice room you are in, or null. */
function currentRoom(s: RoomInfoInputs): Channel | null {
  if (s.currentChannelId === null) return null;
  const channel = s.channels.get(s.currentChannelId);
  return channel?.type === "voice" ? channel : null;
}

function roomMembers(s: RoomInfoInputs): ReadonlyMap<number, VoiceUser> {
  return s.currentChannelId === null
    ? new Map()
    : (s.voiceUsers.get(s.currentChannelId) ?? new Map());
}

function audioValue(config: VoiceConfig | null): InfoValue {
  if (config === null || config.bitrate <= 0) return detailOnly(roomInfoText("notKnown"));
  const kbps = voiceText("tile.kbps", { value: Math.round(config.bitrate / 1000) });
  const key = Object.hasOwn(AUDIO_WORDS, config.quality) ? AUDIO_WORDS[config.quality] : undefined;
  if (key === undefined) return detailOnly(kbps);
  return detailOnly(roomInfoText("audioValue", { quality: roomInfoText(key), kbps }));
}

interface NoticeCounts {
  readonly mismatch: number;
  readonly storage: number;
  readonly changed: number;
  readonly unverified: number;
}

/** The key notices among the others in the room; you never count. */
function noticeCounts(s: RoomInfoInputs): NoticeCounts {
  const counts = { mismatch: 0, storage: 0, changed: 0, unverified: 0 };
  for (const userId of roomMembers(s).keys()) {
    if (userId === s.selfId) continue;
    const status = s.peerVerifications.get(userId)?.status;
    if (status === "mismatch") counts.mismatch++;
    else if (status === "unknown") counts.storage++;
    else if (status === "changed") counts.changed++;
    else if (status === "unverified") counts.unverified++;
  }
  return counts;
}

function noticeSentences(n: NoticeCounts): string[] {
  const out: string[] = [];
  if (n.mismatch > 0) out.push(roomInfoText("srMismatch", { count: n.mismatch }));
  if (n.storage > 0) out.push(roomInfoText("srStorage", { count: n.storage }));
  if (n.changed > 0) out.push(roomInfoText("srNewKey", { count: n.changed }));
  if (n.unverified > 0) out.push(roomInfoText("srNoKey", { count: n.unverified }));
  return out;
}

/** Connected: the most serious key notice, or "Secured" with none. */
function connectedSecurity(s: RoomInfoInputs): InfoValue {
  const n = noticeCounts(s);
  const blocked = n.mismatch + n.storage;
  let notice: { word: string; count: number; level: InfoLevel } | null = null;
  if (blocked > 0) notice = { word: roomInfoText("blocked"), count: blocked, level: "bad" };
  else if (n.changed > 0)
    notice = { word: roomInfoText("newKey"), count: n.changed, level: "warn" };
  else if (n.unverified > 0)
    notice = { word: roomInfoText("noKey"), count: n.unverified, level: "none" };
  if (notice === null) return wordOnly(voiceText("widget.secured"), "ok");
  return {
    word: notice.word,
    detail: roomInfoText("noticeCount", { count: notice.count }),
    level: notice.level,
    sr: [`${notice.word}.`, ...noticeSentences(n)].join(" "),
  };
}

/** The Security value, by the precedence table under "Smaller decisions". */
export function securityText(s: RoomInfoInputs): InfoValue {
  if (s.encryptionDegraded) return wordOnly(voiceText("widget.unsecured"), "bad");
  if (s.voiceStatus === "connected") return connectedSecurity(s);
  return wordOnly(voiceText(STATE_WORDS[s.voiceStatus]), "warn");
}

interface StreamEntry {
  readonly name: string;
  readonly text: string;
}

function byName(a: StreamEntry, b: StreamEntry): number {
  return a.name.localeCompare(b.name);
}

/** Screen shares, then cameras, then music, each sorted by name; you are "You". */
function streamEntries(s: RoomInfoInputs): StreamEntry[] {
  const members = roomMembers(s);
  const you = roomInfoText("you");
  const nameOf = (id: number): string =>
    id === s.selfId ? you : (members.get(id)?.username ?? you);
  const screen: StreamEntry[] = [];
  const camera: StreamEntry[] = [];
  for (const user of members.values()) {
    const name = nameOf(user.userId);
    if (user.screenshare) screen.push({ name, text: roomInfoText("screen", { name }) });
    if (user.camera) camera.push({ name, text: roomInfoText("camera", { name }) });
  }
  const music: StreamEntry[] = [];
  for (const id of s.musicSharers) {
    if (!members.has(id) && id !== s.selfId) continue;
    const name = nameOf(id);
    music.push({ name, text: roomInfoText("music", { name }) });
  }
  return [...screen.toSorted(byName), ...camera.toSorted(byName), ...music.toSorted(byName)];
}

function streamsValue(s: RoomInfoInputs): InfoValue {
  const entries = streamEntries(s).map((e) => e.text);
  if (entries.length === 0) return detailOnly(roomInfoText("none"));
  const join = roomInfoText("listJoin");
  const drawn = entries.slice(0, STREAMS_DRAWN);
  const rest = entries.length - drawn.length;
  if (rest > 0) drawn.push(roomInfoText("more", { count: rest }));
  return { word: "", detail: drawn.join(join), level: "none", sr: entries.join(join) };
}

/** The room you are in, or null when you are in none (or in a DM call). */
export function roomInfoModel(s: RoomInfoInputs): RoomInfoModel | null {
  const room = currentRoom(s);
  if (room === null) return null;
  return {
    channelId: room.id,
    roomName: room.name,
    users: { count: roomMembers(s).size, max: room.voiceMaxUsers },
    audio: audioValue(s.voiceConfig),
    security: securityText(s),
    streams: streamsValue(s),
  };
}

/** Equal for models that draw the same; speaking and mute changes leave it unchanged. */
export function roomInfoKey(m: RoomInfoModel | null): string {
  return m === null ? "" : JSON.stringify(m);
}

/** The Quality value for a sample already passed through shownStats: word Good/Fair/Poor/Bad,
 *  detail " · 18 ms · 3% loss"; null gives word "" and detail "Not measured" (level "none"). */
export function qualityLine(shown: ConnectionStats | null): InfoValue {
  if (shown === null) return detailOnly(roomInfoText("notMeasured"));
  const { word: key, level } = QUALITY[shown.quality];
  const word = voiceText(key);
  const join = roomInfoText("join");
  let detail = "";
  if (shown.rtt > 0) detail += join + voiceText("stats.ping", { rtt: Math.round(shown.rtt) });
  if (shown.loss >= 1) detail += join + roomInfoText("loss", { loss: Math.round(shown.loss) });
  return { word, detail, level, sr: word + detail };
}

/** The summary's users text: "4/8", or "4" with no limit; and its spoken form. */
export function summaryUsers(m: RoomInfoModel): { readonly text: string; readonly sr: string } {
  const { count, max } = m.users;
  if (max > 0) {
    return {
      text: roomInfoText("usersShort", { count, max }),
      sr: roomInfoText("srUsersOf", { count, max }),
    };
  }
  return { text: String(count), sr: roomInfoText("srUsers", { count }) };
}
