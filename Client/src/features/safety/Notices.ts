/**
 * Moderation notice UI (B9-15, owner decision Q4).
 *
 * - The banner: unacknowledged warnings, oldest first, at the top of the app.
 *   Never a modal and never dismissable: the only action is Acknowledge,
 *   and a notice leaves only when the server confirms it. It survives
 *   navigation because it lives on the page root, outside the chat column.
 * - The Safety settings tab's frame; its body (SafetyTab.ts) loads on first
 *   open, outside the MainPage chunk.
 */

import { ApiClientError, type ApiClient } from "@lib/api";
import { createElement, setText } from "@lib/dom";
import { openSettings } from "@stores/ui.store";
import { createLogger } from "@lib/logger";
import { formatWhen, safetyText as t } from "../../i18n/safety";
import {
  refreshOwnModeration,
  removeNotice,
  safetyStore,
  setNoticeAck,
  type ModerationNotice,
} from "./store";

export interface NoticesBannerOptions {
  readonly api: Pick<ApiClient, "acknowledgeNotice" | "getOwnModeration">;
  /** Where focus goes when the last notice leaves while it held focus. */
  readonly fallbackFocus: () => void;
  readonly signal: AbortSignal;
}

interface NoticeRow {
  readonly el: HTMLElement;
  readonly ack: HTMLButtonElement;
  readonly status: HTMLElement;
}

async function acknowledge(
  api: NoticesBannerOptions["api"],
  id: number,
  signal: AbortSignal,
): Promise<void> {
  const notice = safetyStore.getState().notices.find((n) => n.id === id);
  if (notice === undefined || notice.ack === "pending") return;
  setNoticeAck(id, "pending");
  try {
    await api.acknowledgeNotice(id, signal);
  } catch (err) {
    if (signal.aborted) return;
    // 404: already acknowledged (another device) — the server has it.
    if (!(err instanceof ApiClientError && err.status === 404)) {
      setNoticeAck(id, "failed");
      return;
    }
  }
  removeNotice(id);
  refreshOwnModeration(api);
}

function applyAck(row: NoticeRow, n: ModerationNotice): void {
  const pending = n.ack === "pending";
  setText(row.ack, t(pending ? "notice.acknowledging" : "notice.acknowledge"));
  // Not `disabled`: that would drop focus to <body> (b9-ui-contract, Focus).
  if (pending) {
    row.ack.setAttribute("aria-busy", "true");
    row.ack.setAttribute("aria-disabled", "true");
  } else {
    row.ack.removeAttribute("aria-busy");
    row.ack.removeAttribute("aria-disabled");
  }
  setText(row.status, n.ack === "failed" ? t("notice.ackFailed") : "");
  row.status.classList.toggle("form-error", n.ack === "failed");
}

/** The persistent warning banner. Mount it on the page root. */
export function createNoticesBanner(opts: NoticesBannerOptions): HTMLElement {
  const { api, signal } = opts;
  const root = createElement("section", {
    class: "moderation-notices",
    "aria-label": t("banner.label"),
    "data-testid": "moderation-notices",
  });
  const list = createElement("div", { class: "moderation-notices-list" });
  // Outside the list and always present, so "acknowledged" is announced
  // even when the last notice leaves and the list hides.
  const announcer = createElement("div", { class: "sr-only", role: "status" });
  root.append(list, announcer);
  const rows = new Map<number, NoticeRow>();

  function buildRow(n: ModerationNotice): NoticeRow {
    const titleId = `moderation-notice-${n.id}-title`;
    const el = createElement("div", {
      class: "moderation-notice",
      role: "group",
      "aria-labelledby": titleId,
      "data-testid": `moderation-notice-${n.id}`,
    });
    const title = createElement("p", { class: "moderation-notice-title", id: titleId });
    title.append(
      createElement("strong", {}, t("notice.title")),
      " ",
      createElement(
        "span",
        { class: "moderation-notice-date" },
        t("notice.date", { date: formatWhen(n.createdAt) }),
      ),
    );
    const reason = createElement(
      "p",
      { class: "moderation-notice-reason" },
      n.reason === "" ? t("notice.noReason") : t("notice.reason", { reason: n.reason }),
    );
    const ack = createElement("button", {
      type: "button",
      class: "ac-btn moderation-notice-ack",
      "data-testid": "moderation-notice-ack",
    });
    ack.addEventListener("click", () => void acknowledge(api, n.id, signal), { signal });
    const view = createElement(
      "button",
      { type: "button", class: "moderation-notice-link" },
      t("notice.viewSafety"),
    );
    // i18n-exempt: tab key; its label is settingsText("tabs.safety")
    view.addEventListener("click", () => openSettings("Safety"), { signal });
    const actions = createElement("div", { class: "moderation-notice-actions" });
    actions.append(ack, view);
    const status = createElement("p", { class: "moderation-notice-status", role: "status" });
    el.append(title, reason, actions, status);
    return { el, ack, status };
  }

  function render(notices: readonly ModerationNotice[]): void {
    const ids = new Set(notices.map((n) => n.id));
    let lostFocusAt: number | null = null;
    [...rows.keys()].forEach((id, index) => {
      if (ids.has(id)) return;
      const row = rows.get(id)!;
      if (row.el.contains(document.activeElement)) lostFocusAt = index;
      row.el.remove();
      rows.delete(id);
      setText(announcer, t("toast.acknowledged"));
    });
    // Oldest first. Only a row out of place moves: moving a node drops its focus.
    let prev: Element | null = null;
    for (const n of notices) {
      let row = rows.get(n.id);
      if (row === undefined) {
        row = buildRow(n);
        rows.set(n.id, row);
      }
      applyAck(row, n);
      const slot: Element | null = prev === null ? list.firstElementChild : prev.nextElementSibling;
      if (slot !== row.el) list.insertBefore(row.el, slot);
      prev = row.el;
    }
    root.classList.toggle("visible", notices.length > 0);
    if (lostFocusAt !== null) {
      const next = [...rows.values()][Math.min(lostFocusAt, rows.size - 1)];
      if (next !== undefined) next.ack.focus();
      else opts.fallbackFocus();
    }
  }

  render(safetyStore.getState().notices);
  const unsub = safetyStore.subscribeSelector((s) => s.notices, render);
  signal.addEventListener("abort", unsub, { once: true });
  return root;
}

const log = createLogger("safety");

/** The Settings "Safety" tab (the B9-4 destination). Its body loads on first open. */
export function buildSafetyTab(signal: AbortSignal): HTMLDivElement {
  const pane = createElement("div", { class: "settings-pane active safety-tab" });
  // A slot of its own keeps this body first, above sections added after it.
  const body = createElement("div");
  pane.appendChild(body);
  import("./SafetyTab")
    .then(({ renderSafetyTab }) => {
      if (!signal.aborted) renderSafetyTab(body, signal);
    })
    .catch((err: unknown) => log.error("Safety tab failed to load", { error: String(err) }));
  return pane;
}
