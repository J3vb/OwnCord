/**
 * The Safety tab's appeals (B9-16): file an appeal against an own moderation
 * action, withdraw one, and track each appeal's status.
 *
 * - Eligibility is the server's: only a history row the server marks
 *   `appealable` offers Appeal, and its ledger id is the action_id sent.
 * - One panel, outside both lists, holds the appeal form or the withdraw
 *   confirmation, so a list re-render never drops a draft or focus. A failed
 *   send keeps the draft and never retries by itself.
 * - Status comes from GET /appeals/mine (on open, reconnect and after each
 *   change) and live appeal_status frames, both through the safety store.
 * - A kick has no appeal and a currently banned account cannot sign in: the
 *   section says so instead of offering a path that does not exist.
 */

import { ApiClientError, type ApiClient, type MyAppeal, type OwnModerationAction } from "@lib/api";
import { createElement, setText } from "@lib/dom";
import { appealsText as at } from "../../i18n/appeals";
import { formatWhen, safetyText as t } from "../../i18n/safety";
import { refreshOwnModeration, safetyStore } from "./store";

export type AppealsApi = Pick<ApiClient, "fileAppeal" | "withdrawAppeal">;

export interface AppealsSection {
  readonly root: HTMLElement;
  /** The history row's Appeal button, or null when the server says it is not appealable. */
  appealButton(row: OwnModerationAction): HTMLButtonElement | null;
}

/** Collapse what the server refuses as control characters (line breaks, tabs) to spaces. */
export function appealBody(raw: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

function kindText(kind: MyAppeal["action_kind"]): string {
  if (kind === "") return at("appeals.erasedKind");
  // i18n-exempt: a catalog key built from the wire kind
  return t(`kind.${kind}`);
}

/**
 * Replace `list`'s children, keeping focus on the control with the same
 * data-focus-key when one had it, else on `fallback`.
 */
export function replaceKeepingFocus(
  list: HTMLElement,
  children: readonly HTMLElement[],
  fallback: HTMLElement,
): void {
  const active = document.activeElement;
  const key =
    active instanceof HTMLElement && list.contains(active) ? active.dataset["focusKey"] : undefined;
  list.replaceChildren(...children);
  if (key === undefined) return;
  const same = list.querySelector<HTMLElement>(`[data-focus-key="${key}"]`);
  (same ?? fallback).focus();
}

type Panel =
  | { readonly mode: "file"; readonly actionId: number; readonly opener: string }
  | { readonly mode: "withdraw"; readonly appealId: string; readonly opener: string };

export function createAppealsSection(api: AppealsApi | null, signal: AbortSignal): AppealsSection {
  const root = createElement("section", {
    class: "safety-appeals",
    "aria-labelledby": "safety-appeals-heading",
  });
  const heading = createElement(
    "h3",
    { class: "safety-heading", id: "safety-appeals-heading", tabindex: "-1" },
    at("appeals.heading"),
  );
  const status = createElement("p", { class: "setting-desc", role: "status" });
  const retry = createElement(
    "button",
    { type: "button", class: "ac-btn safety-retry" },
    t("tab.retry"),
  );
  retry.addEventListener("click", () => refreshOwnModeration(), { signal });
  const list = createElement("ul", {
    class: "safety-history safety-appeals-list",
    "aria-label": at("appeals.list"),
  });
  // Always present, so a result is announced after the panel hides.
  const announcer = createElement("div", { class: "sr-only", role: "status" });

  // The panel: the appeal form or the withdraw confirmation.
  const panel = createElement("div", {
    class: "safety-appeal-panel",
    role: "group",
    "aria-labelledby": "safety-appeal-panel-title",
    "data-testid": "safety-appeal-panel",
  });
  panel.hidden = true;
  const panelTitle = createElement("p", {
    class: "safety-appeal-title",
    id: "safety-appeal-panel-title",
  });
  const panelReason = createElement("p", { class: "setting-desc" });
  const bodyLabel = createElement("label", { for: "safety-appeal-body" }, at("form.body"));
  const body = createElement("textarea", {
    id: "safety-appeal-body",
    class: "form-input safety-appeal-body",
    rows: "4",
    maxlength: "4000",
    "aria-describedby": "safety-appeal-body-hint safety-appeal-error",
    "data-testid": "safety-appeal-body",
  });
  const bodyHint = createElement(
    "p",
    { class: "setting-desc", id: "safety-appeal-body-hint" },
    at("form.bodyHint"),
  );
  const fields = createElement("div", { class: "safety-appeal-fields" });
  fields.append(bodyLabel, body, bodyHint);
  const warning = createElement("p", { class: "setting-desc" }, at("withdraw.warning"));
  // Present before any error, so each one is announced (b9-ui-contract, Announcements).
  const panelStatus = createElement("p", {
    class: "safety-appeal-status",
    id: "safety-appeal-error",
    role: "alert",
  });
  const primary = createElement("button", {
    type: "button",
    class: "ac-btn",
    "data-testid": "safety-appeal-primary",
  });
  const cancel = createElement("button", { type: "button", class: "ac-btn safety-appeal-cancel" });
  const actions = createElement("div", { class: "safety-appeal-actions" });
  actions.append(primary, cancel);
  panel.append(panelTitle, panelReason, fields, warning, panelStatus, actions);

  root.append(
    heading,
    createElement("p", { class: "setting-desc" }, at("appeals.hint")),
    createElement("p", { class: "setting-desc" }, at("appeals.unavailable")),
    panel,
    status,
    retry,
    list,
    announcer,
  );

  let open: Panel | null = null;
  let pending = false;

  function setPending(on: boolean): void {
    pending = on;
    const [idle, busy] =
      open?.mode === "withdraw"
        ? [at("withdraw.confirm"), at("withdraw.pending")]
        : [at("form.send"), at("form.sending")];
    setText(primary, on ? busy : idle);
    // Not `disabled`: that would drop focus to <body> (b9-ui-contract, Focus).
    for (const b of [primary, cancel]) {
      if (on) b.setAttribute("aria-disabled", "true");
      else b.removeAttribute("aria-disabled");
    }
    if (on) primary.setAttribute("aria-busy", "true");
    else primary.removeAttribute("aria-busy");
  }

  /** `invalid`: the server refused the text itself, so focus returns to it. */
  function showError(text: string, invalid = false): void {
    setText(panelStatus, text);
    panelStatus.classList.toggle("form-error", text !== "");
    if (invalid) body.setAttribute("aria-invalid", "true");
    else body.removeAttribute("aria-invalid");
    if (invalid) body.focus();
  }

  function show(next: Panel, title: string, reason: string): void {
    open = next;
    setPending(false);
    showError("");
    setText(panelTitle, title);
    setText(panelReason, reason === "" ? t("notice.noReason") : t("notice.reason", { reason }));
    const filing = next.mode === "file";
    fields.hidden = !filing;
    warning.hidden = filing;
    setText(cancel, at(filing ? "form.cancel" : "withdraw.keep"));
    if (filing) body.value = "";
    panel.hidden = false;
    (filing ? body : primary).focus();
  }

  /** Hide the panel; focus goes back to its opener, else to the heading. */
  function hide(done?: string): void {
    const opener = open?.opener;
    setPending(false);
    open = null;
    panel.hidden = true;
    if (done !== undefined) {
      setText(announcer, done);
      heading.focus();
      return;
    }
    const el =
      opener === undefined
        ? null
        : root.ownerDocument.querySelector<HTMLElement>(`[data-focus-key="${opener}"]`);
    (el ?? heading).focus();
  }

  cancel.addEventListener(
    "click",
    () => {
      if (!pending) hide();
    },
    { signal },
  );

  async function submit(p: Extract<Panel, { mode: "file" }>): Promise<void> {
    if (api === null) return;
    setPending(true);
    showError("");
    try {
      await api.fileAppeal(p.actionId, appealBody(body.value), signal);
    } catch (err) {
      if (signal.aborted || open !== p) return;
      setPending(false);
      showError(fileError(err), err instanceof ApiClientError && err.status === 400);
      if (err instanceof ApiClientError && (err.status === 404 || err.status === 409)) {
        refreshOwnModeration();
      }
      return;
    }
    if (signal.aborted) return;
    hide(at("form.sent"));
    refreshOwnModeration();
  }

  async function withdraw(p: Extract<Panel, { mode: "withdraw" }>): Promise<void> {
    if (api === null) return;
    setPending(true);
    showError("");
    try {
      await api.withdrawAppeal(p.appealId, signal);
    } catch (err) {
      if (signal.aborted || open !== p) return;
      setPending(false);
      const known = err instanceof ApiClientError && (err.status === 404 || err.status === 409);
      showError(
        known
          ? at(err.status === 404 ? "withdraw.gone" : "withdraw.decided")
          : at("withdraw.failed"),
      );
      if (known) refreshOwnModeration();
      return;
    }
    if (signal.aborted) return;
    hide(at("withdraw.done"));
    refreshOwnModeration();
  }

  primary.addEventListener(
    "click",
    () => {
      if (pending || open === null) return;
      void (open.mode === "file" ? submit(open) : withdraw(open));
    },
    { signal },
  );

  function buildAppealRow(a: MyAppeal): HTMLLIElement {
    const li = createElement("li", {
      class: "safety-history-row",
      "data-testid": `safety-appeal-${a.id}`,
    });
    const erased = a.action_kind === "";
    const head = createElement("p", { class: "safety-history-head" });
    head.append(
      createElement("strong", {}, kindText(a.action_kind)),
      erased ? "" : ` · ${formatWhen(a.action_created_at)}`,
    );
    li.appendChild(head);
    li.appendChild(
      createElement(
        "p",
        { class: "safety-history-reason" },
        erased
          ? at("appeals.erased")
          : a.action_reason === ""
            ? t("notice.noReason")
            : t("notice.reason", { reason: a.action_reason }),
      ),
    );
    const parts = [
      // i18n-exempt: a catalog key built from the wire state
      at("appeals.state", { state: t(`appeal.${a.state}`) }),
      at("appeals.filed", { date: formatWhen(a.created_at) }),
    ];
    if (a.decided_at !== null)
      parts.push(at("appeals.decided", { date: formatWhen(a.decided_at) }));
    li.appendChild(createElement("p", { class: "setting-desc" }, parts.join(" · ")));
    if (a.decision_note !== null && a.decision_note !== "") {
      li.appendChild(
        createElement(
          "p",
          { class: "setting-desc" },
          at("appeals.note", { note: a.decision_note }),
        ),
      );
    }
    if (a.state === "overturned" && a.action_kind === "removal") {
      li.appendChild(
        createElement("p", { class: "setting-desc" }, at("appeals.overturnedRemoval")),
      );
    }
    if (api !== null && (a.state === "open" || a.state === "assigned")) {
      const date = erased ? formatWhen(a.created_at) : formatWhen(a.action_created_at);
      const opener = `withdraw-${a.id}`;
      const btn = createElement(
        "button",
        {
          type: "button",
          class: "ac-btn safety-appeal-withdraw",
          "data-focus-key": opener,
          "aria-label": at("appeals.withdrawLabel", { kind: kindText(a.action_kind), date }),
        },
        at("appeals.withdraw"),
      );
      btn.addEventListener(
        "click",
        () => {
          if (pending) return;
          show(
            { mode: "withdraw", appealId: a.id, opener },
            at("withdraw.title", { kind: kindText(a.action_kind), date }),
            erased ? "" : a.action_reason,
          );
        },
        { signal },
      );
      li.appendChild(btn);
    }
    return li;
  }

  function render(): void {
    const { appeals, appealsFailed } = safetyStore.getState();
    retry.hidden = !appealsFailed;
    let text = "";
    if (appealsFailed) text = at("appeals.loadFailed");
    else if (appeals === null) text = at("appeals.loading");
    else if (appeals.length === 0) text = at("appeals.empty");
    setText(status, text);
    replaceKeepingFocus(list, appealsFailed ? [] : (appeals ?? []).map(buildAppealRow), heading);
  }

  render();
  const unsub = safetyStore.subscribeSelector(
    (s) => [s.appeals, s.appealsFailed] as const,
    render,
    (a, b) => a[0] === b[0] && a[1] === b[1],
  );
  signal.addEventListener("abort", unsub, { once: true });

  return {
    root,
    appealButton(row) {
      if (api === null || !row.appealable) return null;
      const kind = kindText(row.kind);
      const date = formatWhen(row.created_at);
      const opener = `appeal-${row.id}`;
      const btn = createElement(
        "button",
        {
          type: "button",
          class: "ac-btn safety-appeal-open",
          "data-focus-key": opener,
          "aria-label": at("appeals.appealLabel", { kind, date }),
          "data-testid": `safety-appeal-open-${row.id}`,
        },
        at("appeals.appeal"),
      );
      btn.addEventListener(
        "click",
        () => {
          if (pending) return;
          show(
            { mode: "file", actionId: row.id, opener },
            at("form.title", { kind, date }),
            row.reason,
          );
        },
        { signal },
      );
      return btn;
    },
  };
}

function fileError(err: unknown): string {
  if (!(err instanceof ApiClientError)) return at("form.failed");
  if (err.code === "ALREADY_APPEALED") return at("form.alreadyAppealed");
  if (err.status === 429) return at("form.rateLimited");
  if (err.status === 404 || err.status === 403) return at("form.gone");
  if (err.status === 400) return at("form.invalid", { message: err.message });
  return at("form.failed");
}
