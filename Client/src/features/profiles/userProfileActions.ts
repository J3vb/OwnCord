/**
 * The action buttons of the user profile popup (Message, Call, Report, Block)
 * and how the card's parts are laid out around them, as a card beside the
 * anchor or as a phone bottom sheet.
 */
import { createElement, appendChildren } from "@lib/dom";
import { createIcon } from "@lib/icons";
import { reportEntryText } from "../../i18n/reportEntry";
import { requestsText } from "../../i18n/requests";
import { shellText } from "../../i18n/shell";
import type { IdentityLines } from "./userProfileLayout";
import type { UserProfileData, UserProfilePopupOptions } from "./userProfileTypes";

export interface ActionDeps {
  readonly options: UserProfilePopupOptions;
  readonly user: UserProfileData;
  readonly signal: AbortSignal;
  readonly close: () => void;
}

/** aria-disabled, not `disabled`, so the button stays focusable and its
 *  reason is reachable by keyboard and read by a screen reader. */
const markUnavailable = (btn: HTMLElement, reason: string, id: string): void => {
  btn.setAttribute("aria-disabled", "true");
  btn.setAttribute("aria-describedby", id);
  btn.title = reason;
  btn.appendChild(createElement("span", { id, class: "sr-only" }, reason));
};

interface PrimarySpec {
  readonly className: string;
  readonly testId: string;
  readonly icon: "send" | "phone";
  readonly label: string;
  readonly reasonId: string;
  readonly run: (userId: number) => void;
}

/** Message and Call: disabled with a reason when the pair cannot talk now. */
function buildPrimaryButton(spec: PrimarySpec, deps: ActionDeps): HTMLElement {
  const unavailable = deps.options.unavailableReason;
  const { run } = spec;
  const btn = createElement("button", {
    class: spec.className,
    "data-testid": spec.testId,
  });
  btn.appendChild(createIcon(spec.icon, 16));
  btn.appendChild(document.createTextNode(spec.label));
  if (unavailable !== undefined) markUnavailable(btn, unavailable, spec.reasonId);
  btn.addEventListener(
    "click",
    () => {
      if (unavailable !== undefined) return;
      run(deps.user.id);
      deps.close();
    },
    { signal: deps.signal },
  );
  return btn;
}

function buildReportButton(onReport: (userId: number) => void, deps: ActionDeps): HTMLElement {
  const reportBtn = createElement("button", {
    class: "upp-action-btn upp-action-btn--quiet",
    "data-testid": "upp-report-btn",
    "aria-haspopup": "dialog",
  });
  reportBtn.appendChild(createIcon("flag", 16));
  reportBtn.appendChild(document.createTextNode(` ${reportEntryText("report")}`));
  reportBtn.addEventListener(
    "click",
    () => {
      // Close first: focus goes back to the opener, which the report
      // dialog then remembers as the place to return to.
      deps.close();
      onReport(deps.user.id);
    },
    { signal: deps.signal },
  );
  return reportBtn;
}

function buildBlockButton(
  onToggleBlock: (userId: number, block: boolean) => void,
  deps: ActionDeps,
): HTMLElement {
  const block = deps.options.blocked !== true;
  const blockBtn = createElement("button", {
    class: "upp-action-btn upp-action-btn--quiet upp-action-btn--danger",
    "data-testid": "upp-block-btn",
    ...(block ? { "aria-haspopup": "dialog" } : {}),
  });
  blockBtn.appendChild(createIcon("ban", 16));
  blockBtn.appendChild(
    document.createTextNode(` ${shellText(block ? "member.block" : "member.unblock")}`),
  );
  blockBtn.addEventListener(
    "click",
    () => {
      // Close first, like Report: the confirm returns focus to the opener.
      deps.close();
      onToggleBlock(deps.user.id, block);
    },
    { signal: deps.signal },
  );
  return blockBtn;
}

/** Only buttons that are actually wired up, so the popup never shows a dead
 *  control (e.g. Call or Message on your own profile). */
export function buildActions(deps: ActionDeps): HTMLDivElement {
  const { options } = deps;
  const actions = createElement("div", { class: "upp-actions" });
  if (options.onMessage !== undefined) {
    actions.appendChild(
      buildPrimaryButton(
        {
          className: "upp-action-btn",
          testId: "upp-message-btn",
          icon: "send",
          label: requestsText("profile.message"),
          reasonId: "upp-message-reason",
          run: options.onMessage,
        },
        deps,
      ),
    );
  }
  if (options.onCall !== undefined) {
    actions.appendChild(
      buildPrimaryButton(
        {
          className: "upp-action-btn upp-action-btn--secondary",
          testId: "upp-call-btn",
          icon: "phone",
          label: requestsText("profile.call"),
          reasonId: "upp-call-reason",
          run: options.onCall,
        },
        deps,
      ),
    );
  }
  if (options.onReport !== undefined)
    actions.appendChild(buildReportButton(options.onReport, deps));
  if (options.onToggleBlock !== undefined) {
    actions.appendChild(buildBlockButton(options.onToggleBlock, deps));
  }
  return actions;
}

export interface CardParts extends IdentityLines {
  readonly body: HTMLElement;
  readonly banner: HTMLElement;
  readonly roleHolder: HTMLElement;
  readonly statusLine: HTMLElement;
  readonly aboutSection: HTMLElement;
  readonly noteSection: HTMLElement;
  readonly joinSection: HTMLElement;
  readonly divider: HTMLElement;
  readonly actions: HTMLElement;
}

/** The phone layout: Message and Call as large buttons under the name,
 *  Report and Block in their own row at the bottom. */
function arrangeSheet(p: CardParts): void {
  p.banner.setAttribute("data-sheet-drag", "");
  const primary = createElement("div", { class: "upp-actions upp-sheet-primary" });
  for (const id of ["upp-message-btn", "upp-call-btn"]) {
    const btn = p.actions.querySelector(`[data-testid="${id}"]`);
    if (btn !== null) primary.appendChild(btn);
  }
  const { body } = p;
  appendChildren(body, p.nameEl, p.handleEl, p.statusLine, p.customStatusEl);
  appendChildren(body, p.activityEl, p.listeningEl);
  if (primary.childElementCount > 0) body.appendChild(primary);
  appendChildren(body, p.roleHolder, p.aboutSection, p.noteSection, p.joinSection);
  if (p.actions.childElementCount > 0) {
    p.actions.classList.add("upp-sheet-secondary");
    appendChildren(body, p.divider, p.actions);
  }
}

/** The card beside the anchor, in the same order of weight as the sheet:
 *  Message and Call on one row, Report and Block quiet on the row under it. */
function arrangeCard(p: CardParts): void {
  const { body, actions } = p;
  appendChildren(
    body,
    p.nameEl,
    p.handleEl,
    p.customStatusEl,
    p.activityEl,
    p.listeningEl,
    p.roleHolder,
    p.statusLine,
    p.aboutSection,
    p.noteSection,
    p.joinSection,
  );
  const primary = createElement("div", { class: "upp-actions" });
  for (const btn of Array.from(actions.children)) {
    if (!btn.classList.contains("upp-action-btn--quiet")) primary.appendChild(btn);
  }
  actions.classList.add("upp-actions--quiet");
  if (primary.childElementCount > 0 || actions.childElementCount > 0) {
    body.appendChild(p.divider);
  }
  if (primary.childElementCount > 0) body.appendChild(primary);
  if (actions.childElementCount > 0) body.appendChild(actions);
}

/** Fill the card body in the layout for the sheet or the anchored card. */
export function arrangeBody(parts: CardParts, asSheet: boolean): void {
  if (asSheet) arrangeSheet(parts);
  else arrangeCard(parts);
}
