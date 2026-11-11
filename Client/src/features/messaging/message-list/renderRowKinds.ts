/**
 * Rows a server draws from its kind alone: system notices, call logs, group events, pins and the welcome row.
 */
import { createElement, setText, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { isPinRowKind, isServerRowKind, isWelcomeRowKind } from "@lib/text/messageKind";
import { groupRowIcon, groupRowText } from "./groupRows";
import { renderPinRowText } from "./pinRows";
import { canWaveIn, renderWaveButton, welcomeGreeting } from "./welcomeRows";
import { type Message } from "@stores/messages.store";
import type { MessageListOptions } from "../MessageList";
import { voiceStore } from "@stores/voice.store";
import { dmCallText } from "../../../i18n/dmCall";
import type { CallInfo } from "../../../lib/types";
import { formatMessageTimestamp, parseTimestamp } from "@lib/text/formatting";
import { resolveAuthor } from "@lib/text/formatting";
import { createAvatarElement, pickAvatarColor } from "../../profiles/avatar";
import { resolveDisplayName } from "@lib/ui/avatar";
import { renderMentions } from "../content/contentParser";
import { fullDateTimeTitle } from "./messageTimes";
import type { MessageRenderOptions } from "./messageRenderOptions";

function renderSystemMessage(msg: Message): HTMLDivElement {
  const el = createElement("div", { class: "system-msg" });
  const icon = createElement("span", { class: "sm-icon" });
  icon.appendChild(createIcon("arrow-right", 14));
  const text = createElement("span", { class: "sm-text" });
  text.appendChild(renderMentions(msg.content));
  const time = createElement("span", { class: "sm-time" }, formatMessageTimestamp(msg.timestamp));
  appendChildren(el, icon, text, time);
  return el;
}

/**
 * A DM call log row, drawn from `kind` and `call` only, never from
 * `content`. Live calls offer Join; an ended call reads "lasted N minutes" to
 * the author and anyone who joined, and "You missed a call" to everyone else.
 */
function renderCallRow(
  msg: Message,
  call: CallInfo,
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const name = resolveDisplayName(resolveAuthor(msg.user));
  const live = call.ended_at === null;
  const missed =
    !live && msg.user.id !== opts.currentUserId && !call.participants.includes(opts.currentUserId);
  const el = createElement("div", {
    class: "message call-row" + (missed ? " call-missed" : ""),
    "data-testid": `message-${msg.id}`,
  });
  const icon = createElement("span", { class: "cr-icon" });
  icon.appendChild(createIcon(missed ? "phone-off" : "phone", 16));
  const text = createElement("span", { class: "cr-text" });
  if (live) {
    setText(text, dmCallText("rowLive", { name }));
  } else {
    const seconds = Math.max(
      0,
      (parseTimestamp(call.ended_at).getTime() - parseTimestamp(call.started_at).getTime()) / 1000,
    );
    const count = Math.floor(seconds / 60);
    const few = count < 1;
    if (missed) {
      setText(
        text,
        few
          ? dmCallText("rowMissedSeconds", { name })
          : dmCallText("rowMissedMinutes", { name, count }),
      );
    } else {
      setText(
        text,
        few
          ? dmCallText("rowLastedSeconds", { name })
          : dmCallText("rowLastedMinutes", { name, count }),
      );
    }
  }
  const time = createElement(
    "span",
    { class: "cr-time", title: fullDateTimeTitle(msg.timestamp) },
    formatMessageTimestamp(msg.timestamp),
  );
  appendChildren(el, icon, text);
  const inThisCall = voiceStore.getState().currentChannelId === msg.channelId;
  if (live && opts.onJoinCall !== undefined && !inThisCall) {
    const join = createElement(
      "button",
      {
        class: "cr-join",
        "data-testid": `call-join-${msg.id}`,
        "aria-label": dmCallText("rowJoinLabel"),
      },
      dmCallText("rowJoin"),
    );
    const onJoinCall = opts.onJoinCall;
    join.addEventListener("click", () => onJoinCall(msg.channelId), { signal });
    el.appendChild(join);
  }
  el.appendChild(time);
  return el;
}

/**
 * A group DM system row: add, remove, leave, rename, icon. A
 * one-line record like a call row, drawn from `kind` + `groupEvent` alone. The
 * group name is set as text, so it is never parsed as markdown or mentions.
 */
function renderGroupRow(msg: Message, text: string): HTMLDivElement {
  const el = createElement("div", {
    class: "message group-row",
    "data-testid": `message-${msg.id}`,
  });
  const icon = createElement("span", { class: "gr-icon" });
  icon.appendChild(createIcon(groupRowIcon(msg.kind), 16));
  const body = createElement("span", { class: "gr-text" });
  setText(body, text);
  const time = createElement(
    "span",
    { class: "gr-time", title: fullDateTimeTitle(msg.timestamp) },
    formatMessageTimestamp(msg.timestamp),
  );
  appendChildren(el, icon, body, time);
  return el;
}

/**
 * A "pinned a message" row: the same one-line record as a group row,
 * with two links in its sentence. See pinRows.ts.
 */
function renderPinRow(msg: Message, opts: MessageListOptions, signal: AbortSignal): HTMLDivElement {
  const el = createElement("div", {
    class: "message pin-row",
    "data-testid": `message-${msg.id}`,
  });
  const icon = createElement("span", { class: "pr-icon" });
  icon.appendChild(createIcon("pin", 16));
  const time = createElement(
    "span",
    { class: "pr-time", title: fullDateTimeTitle(msg.timestamp) },
    formatMessageTimestamp(msg.timestamp),
  );
  appendChildren(el, icon, renderPinRowText(msg, opts, signal), time);
  return el;
}

/**
 * A welcome row: the joiner's avatar, one greeting line picked by the
 * row id, and a Wave button for everyone else who can post in the channel.
 */
function renderWelcomeRow(
  msg: Message,
  opts: MessageListOptions,
  signal: AbortSignal,
): HTMLDivElement {
  const author = resolveAuthor(msg.user);
  const el = createElement("div", {
    class: "message welcome-row",
    "data-testid": `message-${msg.id}`,
  });
  const avatar = createAvatarElement(author, {
    className: "wr-avatar",
    background: pickAvatarColor(author.username),
    attrs: { "data-user-id": String(msg.user.id) },
  });
  const text = createElement("span", { class: "wr-text" });
  setText(text, welcomeGreeting(msg.id, resolveDisplayName(author)));
  const time = createElement(
    "span",
    { class: "wr-time", title: fullDateTimeTitle(msg.timestamp) },
    formatMessageTimestamp(msg.timestamp),
  );
  appendChildren(el, avatar, text);
  if (opts.onWave !== undefined && msg.user.id !== opts.currentUserId && canWaveIn(msg.channelId)) {
    el.appendChild(renderWaveButton(msg.id, opts.onWave, signal));
  }
  el.appendChild(time);
  return el;
}

/** The rows a server draws from its kind alone (a call log, a group DM event,
 *  a pin or welcome row), or null for an ordinary message. */
export function renderKindRow(
  msg: Message,
  opts: MessageRenderOptions,
  signal: AbortSignal,
): HTMLDivElement | null {
  // id 0 is the reserved sentinel for server-synthesized system rows (DB
  // user ids are AUTOINCREMENT starting at 1, so no real account can ever
  // hold it). Dispatching on the username alone let any account that
  // registered the display name "System" render with no author, no role
  // colour and no moderation controls — indistinguishable from a genuine
  // server notice.
  if (msg.user.id === 0 && msg.user.username === "System") {
    return renderSystemMessage(msg);
  }

  // A call log row is drawn from kind + call alone, and a group DM row from
  // kind + groupEvent. Any other kind (a future one) falls back to plain system
  // text; so does a call row with no `call`. An empty kind counts as unset.
  if (!isServerRowKind(msg.kind)) return null;
  if (msg.kind === "call" && msg.call !== undefined) {
    return renderCallRow(msg, msg.call, opts, signal);
  }
  if (isPinRowKind(msg.kind)) return renderPinRow(msg, opts, signal);
  if (isWelcomeRowKind(msg.kind)) return renderWelcomeRow(msg, opts, signal);
  const groupText = groupRowText(msg, opts.currentUserId);
  if (groupText !== null) return renderGroupRow(msg, groupText);
  const fallback = renderSystemMessage(msg);
  fallback.dataset["testid"] = `message-${msg.id}`;
  return fallback;
}
