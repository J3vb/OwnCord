import { appendChildren, clearChildren, createElement, setText } from "@lib/dom";
import { settingsText as t } from "../../i18n/settings";
import { recordSelfTestStage, resetSelfTest } from "@lib/voiceJoinTrace";
import {
  diagnosticLabel,
  getConnectionDiagnosticsSessionSignal,
  runConnectionDiagnostics,
  type DiagnosticResult,
  type DiagnosticStage,
  type DiagnosticStatus,
} from "@lib/connectionDiagnostics";
import { createDisclosure, setStatusIcon, statusIcon, type StatusKind } from "./status";

const DIAGNOSTIC_STATUS_KEYS = {
  running: "diagnostics.status.running",
  passed: "diagnostics.status.passed",
  failed: "diagnostics.status.failed",
} as const satisfies Record<Exclude<DiagnosticStatus, "not-tested">, string>;

const STATUS_KIND: Readonly<Record<DiagnosticStatus, StatusKind>> = {
  running: "pending",
  passed: "ok",
  failed: "crit",
  "not-tested": "pending",
};

function statusLabel(status: DiagnosticStatus): string {
  return status === "not-tested" ? t("diagnostics.notTested") : t(DIAGNOSTIC_STATUS_KEYS[status]);
}

/** The one-line answer and its counts, from the final status of every stage. */
function completion(statuses: readonly DiagnosticStatus[]): {
  kind: StatusKind;
  headline: string;
  counts: string;
} {
  const passed = statuses.filter((s) => s === "passed").length;
  const failed = statuses.filter((s) => s === "failed").length;
  const notTested = statuses.length - passed - failed;
  const counts = [
    passed > 0 ? t("diagnostics.count.passed", { count: passed }) : "",
    failed > 0 ? t("diagnostics.count.failed", { count: failed }) : "",
    notTested > 0 ? t("diagnostics.count.notTested", { count: notTested }) : "",
  ]
    .filter((c) => c !== "")
    .join(" · ");
  if (failed > 0) {
    return {
      kind: "crit",
      headline: t("diagnostics.completeProblems", { count: failed }),
      counts,
    };
  }
  if (passed > 0) return { kind: "ok", headline: t("diagnostics.completeOk"), counts };
  return { kind: "pending", headline: t("diagnostics.completeUntested"), counts };
}

export function createConnectionDiagnosticsPanel(signal: AbortSignal): {
  element: HTMLElement;
  cleanup(): void;
} {
  const element = createElement("section", {
    class: "settings-card",
    "data-testid": "connection-diagnostics",
    "aria-labelledby": "connection-diagnostics-title",
  });
  const head = createElement("div", { class: "settings-card-head" });
  const title = createElement("h3", { id: "connection-diagnostics-title" }, t("diagnostics.title"));
  const start = createElement(
    "button",
    { class: "ac-btn secondary", type: "button", "data-testid": "diagnostics-start" },
    t("diagnostics.start"),
  );
  const cancel = createElement(
    "button",
    { class: "ac-btn secondary", type: "button" },
    t("diagnostics.cancel"),
  );
  cancel.hidden = true;
  appendChildren(head, title, start, cancel);

  const description = createElement("p", { class: "setting-desc" }, t("diagnostics.description"));
  // The answer first: one line, in the existing live status region.
  const summary = createElement("p", {
    class: "summary-line",
    role: "status",
    "data-testid": "diagnostics-status",
  });
  const summaryIcon = createElement("span", { class: "st-ic" });
  summaryIcon.hidden = true;
  const summaryText = createElement("span", {}, t("diagnostics.ready"));
  const summaryCounts = createElement("span", { class: "disclose-count" });
  summary.append(summaryIcon, summaryText, summaryCounts);

  const results = createElement("ul", { class: "status-list", "aria-live": "polite" });
  const micLabel = createElement("label", { class: "form-check" });
  const microphone = createElement("input", { type: "checkbox" });
  microphone.checked = true;
  micLabel.append(microphone, document.createTextNode(t("diagnostics.micCheck")));
  const limits = createDisclosure(t("diagnostics.limitsSummary"));
  limits.details.appendChild(
    createElement("p", { class: "setting-desc" }, t("diagnostics.limitation")),
  );
  appendChildren(element, head, description, summary, results, micLabel, limits.details);

  let attempt: AbortController | null = null;
  let detachSession: (() => void) | null = null;
  let alive = true;
  const rows = new Map<DiagnosticStage, HTMLLIElement>();
  const finalStatus = new Map<DiagnosticStage, DiagnosticStatus>();

  function showSummary(text: string, kind: StatusKind | null = null, counts = ""): void {
    summaryIcon.hidden = kind === null;
    if (kind !== null) setStatusIcon(summaryIcon, kind);
    summary.dataset.state = kind ?? "";
    setText(summaryText, text);
    // The leading space keeps headline and counts apart in the read-out text.
    setText(summaryCounts, counts === "" ? "" : ` ${counts}`);
  }

  function renderRow(result: DiagnosticResult): void {
    let row = rows.get(result.stage);
    if (!row) {
      row = createElement("li", {
        class: "status-item",
        "data-testid": `diagnostic-${result.stage}`,
      });
      rows.set(result.stage, row);
      results.appendChild(row);
    }
    row.dataset.status = result.status;
    finalStatus.set(result.stage, result.status);
    // A passing stage needs no reading: its full sentence stays as detail.
    // Anything else says in words what happened and what to do next.
    const passed = result.status === "passed";
    row.title = result.detail;
    row.replaceChildren(
      statusIcon(STATUS_KIND[result.status]),
      createElement("span", { class: "status-name" }, diagnosticLabel(result.stage)),
      createElement(
        "span",
        { class: "status-result" },
        passed
          ? statusLabel(result.status)
          : t("diagnostics.result", { status: statusLabel(result.status), detail: result.detail }),
      ),
    );
  }

  function reset(text: string): void {
    clearChildren(results);
    rows.clear();
    finalStatus.clear();
    setText(start, t("diagnostics.start"));
    showSummary(text);
  }

  function stop(): void {
    attempt?.abort();
    attempt = null;
    detachSession?.();
    detachSession = null;
  }

  start.addEventListener(
    "click",
    () => {
      stop();
      const current = new AbortController();
      attempt = current;
      clearChildren(results);
      rows.clear();
      resetSelfTest();
      finalStatus.clear();
      start.disabled = true;
      microphone.disabled = true;
      cancel.hidden = false;
      showSummary(t("diagnostics.testing"));
      const sessionSignal = getConnectionDiagnosticsSessionSignal();
      const onSessionChange = (): void => {
        current.abort();
        if (!alive || attempt !== current) return;
        reset(t("diagnostics.sessionChanged"));
        start.disabled = false;
        microphone.disabled = false;
        cancel.hidden = true;
      };
      sessionSignal?.addEventListener("abort", onSessionChange, { once: true });
      detachSession = () => sessionSignal?.removeEventListener("abort", onSessionChange);
      void runConnectionDiagnostics(
        (result) => {
          if (!alive || attempt !== current || current.signal.aborted) return;
          // SRE-M2: the self-test result the diagnostics bundle carries. Only
          // the terminal status of each stage is kept.
          if (result.status !== "running") recordSelfTestStage(result.stage, result.status);
          renderRow(result);
        },
        AbortSignal.any([signal, current.signal]),
        microphone.checked,
      )
        .then(() => {
          if (!alive || attempt !== current || current.signal.aborted) return;
          const done = completion([...finalStatus.values()]);
          showSummary(done.headline, done.kind, done.counts);
          setText(start, t("diagnostics.runAgain"));
        })
        .catch(() => {
          if (!alive || attempt !== current) return;
          if (sessionSignal?.aborted) return;
          reset(current.signal.aborted ? t("diagnostics.cancelled") : t("diagnostics.failed"));
        })
        .finally(() => {
          if (!alive || attempt !== current) return;
          start.disabled = false;
          microphone.disabled = false;
          cancel.hidden = true;
        });
    },
    { signal },
  );
  cancel.addEventListener(
    "click",
    () => {
      attempt?.abort();
    },
    { signal },
  );

  function cleanup(): void {
    alive = false;
    stop();
    signal.removeEventListener("abort", cleanup);
  }
  signal.addEventListener("abort", cleanup, { once: true });
  return { element, cleanup };
}
