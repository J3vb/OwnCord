/**
 * VoiceJoinSheet — what tapping a voice channel opens on a phone: who is in
 * there, and a Join button, so a stray tap in the drawer does not put you in
 * a call. On a desktop the click joins at once and this is never opened.
 *
 * The list follows the channel while the sheet is open, Join is held back
 * while the socket is down or a timeout is on (the same guards as a direct
 * tap), and a channel deleted under the sheet closes it.
 */

import { createElement, appendChildren, setText, clearChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import type { IconName } from "@lib/icons";
import { openBottomSheet } from "@lib/ui/bottomSheet";
import { channelsStore } from "@stores/channels.store";
import { membersStore } from "@stores/members.store";
import { uiStore } from "@stores/ui.store";
import { voiceStore } from "@stores/voice.store";
import { safetyStore } from "../features/safety/store";
import { formatUntil, safetyText } from "../i18n/safety";
import { shellText } from "../i18n/shell";
import { voiceText as t } from "../i18n/voice";
import {
  callParticipants,
  participantAvatar,
  participantKey,
  type CallParticipant,
} from "./callParticipants";

export interface VoiceJoinSheetOptions {
  readonly channelId: number;
  /** The same join a direct tap makes. */
  readonly onJoin: (channelId: number) => void;
  /** The opener's lifetime: an abort closes the sheet. */
  readonly signal: AbortSignal;
  readonly fallbackFocus?: () => HTMLElement | null;
}

/** Why Join does nothing now (socket down, timed out); null when it works. */
function joinBlockedReason(): string | null {
  const status = uiStore.getState().connectionStatus;
  if (status !== "connected") {
    return shellText(status === "reconnecting" ? "channel.reconnecting" : "channel.notConnected");
  }
  const timeout = safetyStore.getState().timeout;
  return timeout === null
    ? null
    : safetyText("timeout.voice", { time: formatUntil(timeout.expiresAt) });
}

/** What a row draws, as one comparable key; speaking is not drawn. */
function rowKey(p: CallParticipant): string {
  return `${participantKey(p)}|${p.camera}|${p.screenshare}|${p.audio ?? ""}`;
}

function marker(icon: IconName, label: string): HTMLSpanElement {
  const el = createElement("span", { class: "js-marker", role: "img", "aria-label": label });
  el.appendChild(createIcon(icon, 16));
  return el;
}

function personRow(person: CallParticipant): HTMLLIElement {
  const row = createElement("li", {
    class: "js-person",
    "data-voice-uid": String(person.userId),
  });
  appendChildren(
    row,
    participantAvatar(person, "js-avatar"),
    createElement("span", { class: "js-name" }, person.name),
  );
  if (person.camera) row.appendChild(marker("camera", t("joinSheet.camera")));
  if (person.screenshare) row.appendChild(marker("monitor", shellText("channel.live")));
  if (person.audio !== null) {
    const label =
      person.audio === "headphones-off" ? shellText("channel.deafened") : t("joinSheet.muted");
    row.appendChild(marker(person.audio, label));
  }
  return row;
}

export function openVoiceJoinSheet(options: VoiceJoinSheetOptions): void {
  const { channelId, onJoin } = options;
  const nameOf = (): string =>
    channelsStore.getState().channels.get(channelId)?.name ?? t("widget.channelFallback");

  const icon = createElement("span", { class: "js-icon", "aria-hidden": "true" });
  icon.appendChild(createIcon("volume-2", 28));
  const nameEl = createElement("div", { class: "js-channel" });
  const countEl = createElement("div", { class: "js-count", "data-testid": "join-sheet-count" });
  const list = createElement("ul", { class: "js-people", "data-testid": "join-sheet-people" });
  const note = createElement("div", { class: "js-note", role: "status" });
  const joinBtn = createElement(
    "button",
    { type: "button", class: "js-join", "data-testid": "join-sheet-join" },
    t("joinSheet.join"),
  );
  const cancelBtn = createElement(
    "button",
    { type: "button", class: "js-cancel", "data-testid": "join-sheet-cancel" },
    t("joinSheet.cancel"),
  );
  const content = createElement("div", { class: "join-sheet" });
  appendChildren(content, icon, nameEl, countEl, list, note, joinBtn, cancelBtn);

  const sheet = openBottomSheet({
    label: t("joinSheet.label", { name: nameOf() }),
    content,
    className: "join-sheet-panel",
    testId: "voice-join-sheet",
    signal: options.signal,
    ...(options.fallbackFocus !== undefined ? { fallbackFocus: options.fallbackFocus } : {}),
  });
  if (sheet.signal.aborted) return;

  let rowsKey: string | null = null;

  function render(): void {
    // The channel is gone (deleted, or no longer visible): nothing to join.
    if (!channelsStore.getState().channels.has(channelId)) {
      sheet.close();
      return;
    }
    const name = nameOf();
    setText(nameEl, name);
    list.setAttribute("aria-label", t("joinSheet.people", { name }));
    const people = callParticipants(channelId);
    setText(
      countEl,
      people.length === 0 ? t("joinSheet.empty") : t("joinSheet.inHere", { count: people.length }),
    );
    // Members change often (presence); the rows only when what they draw does.
    const key = people.map(rowKey).join(",");
    if (key !== rowsKey) {
      rowsKey = key;
      clearChildren(list);
      list.append(...people.map(personRow));
    }
    list.hidden = people.length === 0;

    const reason = joinBlockedReason();
    joinBtn.disabled = reason !== null;
    if (note.textContent !== (reason ?? "")) setText(note, reason ?? "");
  }

  joinBtn.addEventListener(
    "click",
    () => {
      // The gate may have closed since the last render.
      if (joinBlockedReason() !== null) return;
      // Closed first: the join may close the drawer and move focus.
      sheet.close();
      onJoin(channelId);
    },
    { signal: sheet.signal },
  );
  cancelBtn.addEventListener("click", () => sheet.close(), { signal: sheet.signal });

  const unsubs = [
    // The roster, not the speaking flags that rebuild its map several times a second.
    voiceStore.subscribeSelector(
      (s) =>
        Array.from(
          s.voiceUsers.get(channelId)?.values() ?? [],
          (u) => `${u.userId}|${u.username}|${u.muted}|${u.deafened}|${u.camera}|${u.screenshare}`,
        ).join(","),
      render,
    ),
    membersStore.subscribeSelector((s) => s.members, render),
    channelsStore.subscribeSelector((s) => s.channels, render),
    uiStore.subscribeSelector((s) => s.connectionStatus, render),
    safetyStore.subscribeSelector((s) => s.timeout, render),
  ];
  sheet.signal.addEventListener("abort", () => unsubs.forEach((off) => off()), { once: true });
  render();
}
