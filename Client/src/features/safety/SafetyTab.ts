/**
 * The Settings "Safety" tab body (B9-15): the current restriction and the
 * caller's own moderation history (GET /users/me/moderation). Shows only what
 * that member-safe read returns: never an actor, reporter, evidence or note.
 * Loaded on first open (destinations.ts), outside the MainPage chunk.
 */

import type { OwnModerationAction } from "@lib/api";
import { createElement, setText } from "@lib/dom";
import { formatUntil, formatWhen, safetyText as t } from "../../i18n/safety";
import { refreshOwnModeration, safetyStore, serverNow, serverTime } from "./store";

function historyStatus(row: OwnModerationAction): string[] {
  const parts: string[] = [];
  if (row.kind === "warning") {
    parts.push(t(row.acknowledged_at === null ? "status.unacknowledged" : "status.acknowledged"));
  } else if (row.lifted_at !== null) {
    parts.push(t("status.lifted", { date: formatWhen(row.lifted_at) }));
  } else if (row.expires_at !== null) {
    parts.push(
      serverTime(row.expires_at) > serverNow()
        ? t("status.activeUntil", { time: formatUntil(row.expires_at) })
        : t("status.ended", { date: formatWhen(row.expires_at) }),
    );
  }
  if (row.appeal !== null) {
    // i18n-exempt: a catalog key built from the wire state
    parts.push(t("status.appeal", { state: t(`appeal.${row.appeal.state}`) }));
  }
  return parts;
}

function buildHistoryRow(row: OwnModerationAction): HTMLLIElement {
  const li = createElement("li", {
    class: "safety-history-row",
    "data-testid": `safety-history-${row.id}`,
  });
  const head = createElement("p", { class: "safety-history-head" });
  head.append(
    // i18n-exempt: a catalog key built from the wire kind
    createElement("strong", {}, t(`kind.${row.kind}`)),
    ` · ${formatWhen(row.created_at)}`,
  );
  li.appendChild(head);
  li.appendChild(
    createElement(
      "p",
      { class: "safety-history-reason" },
      row.reason === "" ? t("notice.noReason") : t("notice.reason", { reason: row.reason }),
    ),
  );
  const status = historyStatus(row);
  if (status.length > 0) {
    li.appendChild(createElement("p", { class: "setting-desc" }, status.join(" · ")));
  }
  return li;
}

/** Fill the Safety tab `pane` (the Q2 destination the banner links to). */
export function renderSafetyTab(pane: HTMLDivElement, signal: AbortSignal): void {
  const restrictions = createElement("p", { class: "setting-desc", role: "status" });
  const historyStatusEl = createElement("p", { class: "setting-desc", role: "status" });
  const retry = createElement(
    "button",
    { type: "button", class: "ac-btn safety-retry" },
    t("tab.retry"),
  );
  retry.addEventListener("click", () => refreshOwnModeration(), { signal });
  const list = createElement("ul", { class: "safety-history", "aria-label": t("tab.history") });

  pane.append(
    createElement("h3", { class: "safety-heading" }, t("tab.restrictions")),
    restrictions,
    createElement("h3", { class: "safety-heading" }, t("tab.history")),
    createElement("p", { class: "setting-desc" }, t("tab.historyHint")),
    historyStatusEl,
    retry,
    list,
  );

  function render(): void {
    const { timeout, history, historyFailed } = safetyStore.getState();
    setText(
      restrictions,
      timeout === null
        ? t("tab.none")
        : t("tab.timedOut", { time: formatUntil(timeout.expiresAt) }),
    );
    retry.hidden = !historyFailed;
    let status = "";
    if (historyFailed) status = t("tab.loadFailed");
    else if (history === null) status = t("tab.loading");
    else if (history.length === 0) status = t("tab.empty");
    setText(historyStatusEl, status);
    list.replaceChildren(...(historyFailed ? [] : (history ?? []).map(buildHistoryRow)));
  }

  render();
  const unsub = safetyStore.subscribe(render);
  signal.addEventListener("abort", unsub, { once: true });
  // Opening the tab re-reads: removals and lapsed bans arrive no other way.
  refreshOwnModeration();
}
