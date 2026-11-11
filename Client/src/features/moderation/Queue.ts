/**
 * The Moderation Center: the report queue and the selected
 * report's evidence, for MODERATE_MEMBERS holders. view.ts loads this module
 * on first open.
 *
 * The server authorizes everything here. The list is GET /moderation/queue
 * with the state filters the server supports and the count of what it
 * returned; the detail is a separate read per report. A 403 from either
 * clears every report on screen; a 404 is a report that is gone or about the
 * reader, and is never probed further.
 *
 * Every request is bound to the view's signal and to the selection or filter
 * it was made for, so a late answer is dropped. mod_queue and a reconnect only
 * trigger a fresh read. Withdrawing NSFW consent takes the evidence off screen
 * at once; closing the view, losing the permission, signing out or switching
 * profile removes it all, from the DOM and from memory.
 *
 * Review: taking, noting and closing a report are single writes. One
 * write runs at a time; whatever the answer, the queue and the report are read
 * again, so a conflict with another moderator (409) shows the server's current
 * state rather than this view's guess. The next write waits for that read, so
 * controls built before the write can't send it twice. A report the reader's
 * own write moves out of the current filter stays open and is read by id; one
 * that leaves the list for any other reason closes and says so. An unsaved
 * note and chosen outcome live only while the report can still take them and
 * the view is live.
 *
 * Actions: a warning or timeout is sent through the report, and lifting
 * a timeout through the member's own route; each is one write under the same
 * guard. Success is said only once the server answers, and a timeout says
 * whether its voice half was applied or skipped, as the server reported it. A
 * 403 on an action is shown as the server's refusal (a member ranked at or
 * above the reader) and the report is read again: if the reader lost the
 * permission, that read's own 403 clears the view. An action that gets no
 * answer may still have been recorded, so the history is read, not guessed.
 *
 * Removal, kick and ban go through the report the same way. A change
 * to the reader's role rebuilds the open report, so an action their role no
 * longer holds stops being offered before the server has to refuse it.
 *
 * Appeals: the view is two tabs, Reports and Appeals (AppealQueue.ts,
 * rendered the first time its tab is chosen). A 403 in either tab clears
 * both. An appeal's linked report opens here by id, outside the filter, and
 * its read is authorized again like any other.
 */

import { appendChildren, clearChildren, createElement } from "@lib/dom";
import { moderationText as t } from "../../i18n/moderation";
import type { FeatureViewContext } from "../navigation/destinations";
import { renderAppeals, type AppealsView } from "./AppealQueue";
import { nextViewSeq } from "./queueModel";
import { renderReports } from "./ReportsView";

const TABS = ["reports", "appeals"] as const;

export function renderModerationCenter(root: HTMLElement, ctx: FeatureViewContext): void {
  const seq = nextViewSeq();
  const tablist = createElement("div", {
    class: "mod-tabs",
    role: "tablist",
    "aria-label": t("tabs.label"),
  });
  const tabs = TABS.map((name) =>
    createElement(
      "button",
      {
        type: "button",
        class: "mod-tab",
        role: "tab",
        id: `mod-tab-${seq}-${name}`,
        "aria-controls": `mod-panel-${seq}-${name}`,
        "data-testid": `mod-tab-${name}`,
      },
      t(name === "reports" ? "tabs.reports" : "tabs.appeals"),
    ),
  );
  const panels = TABS.map((name) =>
    createElement("div", {
      class: "mod-panel",
      role: "tabpanel",
      id: `mod-panel-${seq}-${name}`,
      "aria-labelledby": `mod-tab-${seq}-${name}`,
    }),
  );
  tablist.append(...tabs);
  appendChildren(root, tablist, ...panels);

  let appeals: AppealsView | null = null;
  const reports = renderReports(panels[0]!, ctx, () => appeals?.deny());

  /** Show one tab; activation follows focus (the WAI-ARIA tabs pattern). */
  function choose(index: number, focus: boolean): void {
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i]!.hidden = i !== index;
    });
    if (focus) tabs[index]!.focus();
    if (index === 1 && appeals === null) {
      appeals = renderAppeals(panels[1]!, ctx, {
        onDenied: reports.deny,
        openReport: (id) => {
          choose(0, false);
          // The appeal's control is now hidden: let the report take focus.
          (document.activeElement as HTMLElement | null)?.blur();
          reports.openLinked(id);
        },
      });
    }
  }
  const { signal } = ctx;
  tabs.forEach((tab, i) => tab.addEventListener("click", () => choose(i, false), { signal }));
  tablist.addEventListener(
    "keydown",
    (e: KeyboardEvent) => {
      const at = tabs.indexOf(document.activeElement as HTMLButtonElement);
      if (at < 0) return;
      const to =
        e.key === "ArrowRight"
          ? (at + 1) % tabs.length
          : e.key === "ArrowLeft"
            ? (at + tabs.length - 1) % tabs.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? tabs.length - 1
                : -1;
      if (to < 0) return;
      e.preventDefault();
      choose(to, true);
    },
    { signal },
  );
  signal.addEventListener("abort", () => clearChildren(root), { once: true });
  choose(0, false);
}
