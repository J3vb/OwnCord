/**
 * Command Deck's Info block: the server voice room you are in, under Buddies
 * in the member column. A read-only view: it builds its own DOM, reads the
 * stores through two selections (the room, and the live connection sample),
 * writes no store and starts no timer. Each patch writes only its own nodes,
 * so a sample every 2 s touches only the Quality value and the summary's ping.
 *
 * Nothing in it takes focus and it has no live region. The drawn Security,
 * Quality and Streams parts are aria-hidden, each followed by an sr-only
 * sibling holding the full text, so no sr-only text sits inside a hidden one.
 * The member column hides it during the call view with `room-info--aside`.
 */
import { Disposable } from "@lib/disposable";
import { createElement, setText } from "@lib/dom";
import { select } from "@lib/ui/select";
import { liveStatsStore, shownPing, shownStats } from "@lib/voice/liveStats";
import { authStore, type AuthState } from "@stores/auth.store";
import { channelsStore, type ChannelsState } from "@stores/channels.store";
import { voiceStore, type VoiceState } from "@stores/voice.store";
import { roomInfoText } from "../../i18n/roomInfo";
import { voiceText } from "../../i18n/voice";
import {
  qualityLine,
  roomInfoKey,
  roomInfoModel,
  summaryUsers,
  type InfoValue,
  type RoomInfoInputs,
  type RoomInfoModel,
} from "./roomInfoModel";

export interface RoomInfoPanel {
  readonly element: HTMLElement;
  destroy(): void;
}

interface QualityAndPing {
  readonly quality: InfoValue;
  readonly ping: string;
}

/** The drawn parts of one value: a dot, a never-cut word, a cut-first detail. */
interface ValueParts {
  readonly dot: HTMLSpanElement;
  readonly word: HTMLSpanElement;
  readonly detail: HTMLSpanElement;
  /** Present on the values whose drawn parts are aria-hidden. */
  readonly sr: HTMLSpanElement | null;
}

const EMPTY_VERIFICATIONS: RoomInfoInputs["peerVerifications"] = new Map();
const EMPTY_SHARERS: RoomInfoInputs["musicSharers"] = new Set();

function inputsOf(v: VoiceState, c: ChannelsState, a: AuthState): RoomInfoInputs {
  const roomId = v.currentChannelId;
  return {
    selfId: a.user?.id ?? null,
    currentChannelId: roomId,
    channels: c.channels,
    voiceUsers: v.voiceUsers,
    voiceStatus: v.voiceStatus,
    encryptionDegraded: v.encryptionDegraded === true,
    peerVerifications: v.peerVerifications ?? EMPTY_VERIFICATIONS,
    musicSharers: v.musicSharers ?? EMPTY_SHARERS,
    voiceConfig: roomId === null ? null : (v.voiceConfigs.get(roomId) ?? null),
  };
}

function sameQualityAndPing(x: QualityAndPing, y: QualityAndPing): boolean {
  return (
    x.ping === y.ping &&
    x.quality.word === y.quality.word &&
    x.quality.detail === y.quality.detail &&
    x.quality.level === y.quality.level &&
    x.quality.sr === y.quality.sr
  );
}

const hiddenSpan = (className: string): HTMLSpanElement =>
  createElement("span", { class: className, "aria-hidden": "true" });

/** One row: `div > dt > span.room-info-label` and an empty `dd`. */
function buildRow(
  rows: HTMLElement,
  name: string,
  label: string,
): { readonly row: HTMLElement; readonly dd: HTMLElement } {
  const row = createElement("div", { class: "room-info-row", "data-testid": `room-info-${name}` });
  const dt = createElement("dt");
  dt.appendChild(createElement("span", { class: "room-info-label" }, label));
  const dd = createElement("dd");
  row.append(dt, dd);
  rows.appendChild(row);
  return { row, dd };
}

/** The parts of a value in `dd`; with `spoken`, they are aria-hidden and an sr-only sibling follows. */
function buildParts(dd: HTMLElement, spoken: boolean): ValueParts {
  const part = (className: string): HTMLSpanElement =>
    spoken ? hiddenSpan(className) : createElement("span", { class: className });
  const dot = hiddenSpan("room-info-dot");
  const word = part("room-info-word");
  const detail = part("room-info-detail");
  const sr = spoken ? createElement("span", { class: "sr-only" }) : null;
  dd.append(dot, word, detail);
  if (sr !== null) dd.appendChild(sr);
  return { dot, word, detail, sr };
}

/** The texts a muted value shows; resolved when drawing. */
function isMuted(v: InfoValue): boolean {
  if (v.word !== "") return false;
  return [roomInfoText("notKnown"), roomInfoText("notMeasured"), roomInfoText("none")].includes(
    v.detail,
  );
}

function drawValue(parts: ValueParts, v: InfoValue, withDot: boolean): void {
  // A value with no word ("Not measured") draws no dot; "No key" keeps its grey one.
  parts.dot.hidden = !withDot || v.word === "";
  parts.dot.dataset["level"] = v.level;
  parts.word.hidden = v.word === "";
  setText(parts.word, v.word);
  setText(parts.detail, v.detail);
  parts.detail.classList.toggle("room-info-muted", isMuted(v));
  if (parts.sr !== null) setText(parts.sr, v.sr);
}

export function createRoomInfoPanel(): RoomInfoPanel {
  const owner = new Disposable();
  try {
    return buildPanel(owner);
  } catch (err) {
    owner.destroy();
    throw err;
  }
}

function buildPanel(owner: Disposable): RoomInfoPanel {
  const element = createElement("section", {
    class: "room-info",
    "data-testid": "room-info",
    "aria-labelledby": "room-info-title",
  });
  element.hidden = true;

  const head = createElement("div", { class: "room-info-head" });
  const light = hiddenSpan("room-info-light");
  const title = createElement("h2", { id: "room-info-title", class: "room-info-title" });
  const roomName = createElement("span", { class: "room-info-room" });
  title.append(
    createElement("span", { class: "room-info-prefix" }, roomInfoText("title")),
    roomName,
  );
  head.append(light, title);

  const rows = createElement("dl", { class: "room-info-rows" });
  const users = buildParts(buildRow(rows, "users", roomInfoText("users")).dd, false);
  const audio = buildParts(buildRow(rows, "audio", roomInfoText("audio")).dd, false);
  const security = buildParts(buildRow(rows, "security", roomInfoText("security")).dd, true);
  const quality = buildParts(buildRow(rows, "quality", roomInfoText("quality")).dd, true);
  const streams = buildParts(buildRow(rows, "streams", roomInfoText("streams")).dd, true);

  const summary = createElement("p", {
    class: "room-info-summary",
    "data-testid": "room-info-summary",
  });
  const sumUsers = hiddenSpan("room-info-sum-users");
  const sumUsersSr = createElement("span", { class: "sr-only" });
  const sumSecurity = hiddenSpan("room-info-sum-security");
  const sumDot = createElement("span", { class: "room-info-dot" });
  const sumWord = createElement("span", { class: "room-info-word" });
  sumSecurity.append(sumDot, sumWord);
  const sumSecuritySr = createElement("span", { class: "sr-only" });
  const sumPingSep = hiddenSpan("room-info-sep");
  const sumPing = hiddenSpan("room-info-sum-ping");
  const sumPingSr = createElement("span", { class: "sr-only" });
  summary.append(
    sumUsers,
    sumUsersSr,
    createElement("span", { class: "room-info-sep", "aria-hidden": "true" }, roomInfoText("join")),
    sumSecurity,
    sumSecuritySr,
    sumPingSep,
    sumPing,
    sumPingSr,
  );
  setText(sumPingSep, roomInfoText("join"));
  element.append(head, rows, summary);

  function patchRoom(m: RoomInfoModel | null): void {
    if (m === null) {
      element.hidden = true;
      return;
    }
    element.hidden = false;
    setText(roomName, m.roomName);
    light.dataset["level"] = m.security.level;
    const { count, max } = m.users;
    const usersText = max > 0 ? roomInfoText("usersOf", { count, max }) : String(count);
    drawValue(users, { word: usersText, detail: "", level: "none", sr: usersText }, false);
    drawValue(audio, m.audio, false);
    drawValue(security, m.security, true);
    drawValue(streams, m.streams, false);
    const sum = summaryUsers(m);
    setText(sumUsers, sum.text);
    setText(sumUsersSr, sum.sr);
    sumDot.dataset["level"] = m.security.level;
    setText(sumWord, m.security.word);
    setText(sumSecuritySr, m.security.sr);
  }

  function patchQuality(q: QualityAndPing): void {
    drawValue(quality, q.quality, true);
    sumPingSep.hidden = q.ping === "";
    setText(sumPing, q.ping);
    setText(sumPingSr, q.quality.sr);
  }

  const room = select(
    [voiceStore, channelsStore, authStore],
    (v, c, a) => roomInfoModel(inputsOf(v, c, a)),
    patchRoom,
    { signal: owner.signal, equals: (x, y) => roomInfoKey(x) === roomInfoKey(y) },
  );
  const sample = select(
    [liveStatsStore, voiceStore],
    (l, v): QualityAndPing => {
      const shown = shownStats(l, v.voiceStatus === "connected", v.joinedAt);
      const rtt = shownPing(shown);
      return {
        quality: qualityLine(shown),
        ping: rtt === null ? "" : voiceText("stats.ping", { rtt }),
      };
    },
    patchQuality,
    { signal: owner.signal, equals: sameQualityAndPing },
  );
  patchRoom(room.get());
  patchQuality(sample.get());

  return {
    element,
    destroy: () => owner.destroy(),
  };
}
