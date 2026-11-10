// One search result row, plus the scope chip label it shares stores with.
import { buildPreview, fillHighlighted } from "./searchHighlight";
import { createElement, setText, appendChildren } from "@lib/dom";
import type { SearchResultItem } from "@lib/types";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { channelsStore } from "@stores/channels.store";
import { blocksStore } from "@stores/blocks.store";
import { parseTimestamp, resolveAuthor } from "@lib/text/formatting";
import { resolveDisplayName } from "@lib/ui/avatar";
import { createImportedName, createImportedTag } from "../messaging/message-list/importedAuthor";
import { formatDate } from "../../i18n/format";
import { messagingText } from "../../i18n/messaging";

/** "in #general" / "in @bob", falling back to a generic label when unknown. */
export function channelScopeLabel(channelId: number): string {
  const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
  if (dm !== undefined) return messagingText("search.scope.inDm", { name: dmDisplayName(dm) });
  const channel = channelsStore.getState().channels.get(channelId);
  return channel !== undefined && channel.name !== ""
    ? messagingText("search.scope.inChannel", { channel: channel.name })
    : messagingText("search.scope.channel");
}

function formatTimestamp(ts: string): string {
  try {
    const d = parseTimestamp(ts);
    return (
      formatDate(d, { year: "numeric", month: "short", day: "numeric" }) +
      " " +
      formatDate(d, { hour: "2-digit", minute: "2-digit" })
    );
  } catch {
    return ts;
  }
}

/** One result row: channel, author, time and the highlighted (or blocked) preview. */
export function buildResultItem(
  r: SearchResultItem,
  i: number,
  isActive: boolean,
  terms: readonly string[],
): HTMLDivElement {
  const item = createElement("div", {
    class: isActive ? "search-result-item search-result-item--active" : "search-result-item",
    id: `search-result-option-${i}`,
    role: "option",
    "aria-selected": isActive ? "true" : "false",
    "data-testid": `search-result-${i}`,
  });

  const header = createElement("div", { class: "search-result-header" });
  const channel = createElement("span", { class: "search-result-channel" });
  const dm = dmStore.getState().channels.find((c) => c.channelId === r.channel_id);
  setText(channel, dm !== undefined ? `@${dmDisplayName(dm)}` : `#${r.channel_name}`);
  if (r.imported_author !== undefined) {
    // No account behind it: the Discord name and tag, and no @handle.
    appendChildren(
      header,
      channel,
      createImportedName(r.imported_author, "search-result-author"),
      createImportedTag(),
    );
  } else {
    const who = resolveAuthor(r.user);
    const authorName = resolveDisplayName(who);
    const author = createElement("span", { class: "search-result-author" });
    setText(author, authorName);
    appendChildren(header, channel, author);
    if (authorName !== who.username) {
      const handle = createElement("span", { class: "search-result-handle" });
      setText(handle, messagingText("search.authorHandle", { username: who.username }));
      header.appendChild(handle);
    }
  }
  const time = createElement("span", { class: "search-result-time" });
  setText(time, formatTimestamp(r.timestamp));
  header.appendChild(time);

  const blocked = blocksStore.getState().blockedByMe.has(r.user.id);
  const content = createElement("div", {
    class: blocked
      ? "search-result-content search-result-content--blocked"
      : "search-result-content",
  });
  if (blocked) setText(content, messagingText("blocked.message"));
  else {
    fillHighlighted(
      content,
      buildPreview(r.content, terms, messagingText("search.spoiler")),
      terms,
    );
  }

  appendChildren(item, header, content);

  return item;
}
