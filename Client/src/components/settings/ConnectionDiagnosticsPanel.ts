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

const SHORT_LABEL_KEYS = {
  connection: "diagnostics.short.connection",
  authentication: "diagnostics.short.authentication",
  websocket: "diagnostics.short.websocket",
  microphone: "diagnostics.short.microphone",
  signaling: "diagnostics.short.signaling",
  media: "diagnostics.short.media",
} as const satisfies Record<DiagnosticStage, string>;

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
    { class: "ac-btn", type: "button", "data-testid": "diagnostics-start" },
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
  // Headline and counts flow as one text block beside the icon.
  const summaryBody = createElement("span", {});
  summaryBody.append(summaryText, summaryCounts);
  summary.append(summaryIcon, summaryBody);

  // Stages run left to right as a stepper. Each stage's whole sentence is in
  // its list item for assistive technology; the line below shows one stage's
  // detail for sighted readers (the failing one, or the one picked).
  const results = createElement("ol", { class: "diag-stepper", "aria-live": "polite" });
  const detail = createElement("p", {
    class: "diag-step-detail",
    "data-testid": "diagnostics-detail",
    "aria-hidden": "true",
  });
  detail.hidden = true;
  const micLabel = createElement("label", { class: "form-check" });
  const microphone = createElement("input", { type: "checkbox" });
  microphone.checked = true;
  micLabel.append(microphone, document.createTextNode(t("diagnostics.micCheck")));
  const limits = createDisclosure(t("diagnostics.limitsSummary"));
  limits.details.appendChild(
    createElement("p", { class: "setting-desc" }, t("diagnostics.limitation")),
  );
  appendChildren(element, head, description, summary, results, detail, micLabel, limits.details);

  let attempt: AbortController | null = null;
  let detachSession: (() => void) | null = null;
  let alive = true;
  const rows = new Map<DiagnosticStage, HTMLLIElement>();
  const finalStatus = new Map<DiagnosticStage, DiagnosticStatus>();
  const details = new Map<DiagnosticStage, string>();
  let picked: DiagnosticStage | null = null;

  function showSummary(text: string, kind: StatusKind | null = null, counts = ""): void {
    summaryIcon.hidden = kind === null;
    if (kind !== null) setStatusIcon(summaryIcon, kind);
    summary.dataset.state = kind ?? "";
    setText(summaryText, text);
    // The leading space keeps headline and counts apart in the read-out text.
    setText(summaryCounts, counts === "" ? "" : ` ${counts}`);
  }

  /** The stage whose detail shows: the picked one, else the first failure, else the first untested. */
  function shownStage(): DiagnosticStage | null {
    if (picked !== null && finalStatus.has(picked)) return picked;
    const stages = [...finalStatus.keys()];
    return (
      stages.find((st) => finalStatus.get(st) === "failed") ??
      stages.find((st) => finalStatus.get(st) === "not-tested") ??
      null
    );
  }

  function paintSelection(): void {
    const shown = shownStage();
    for (const [stage, row] of rows) {
      row.querySelector("button")!.setAttribute("aria-pressed", String(stage === shown));
    }
    detail.hidden = shown === null;
    if (shown === null) return;
    setText(
      detail,
      t("diagnostics.result", {
        status: t("diagnostics.stepDetail", {
          stage: diagnosticLabel(shown),
          status: statusLabel(finalStatus.get(shown)!),
        }),
        detail: details.get(shown) ?? "",
      }),
    );
  }

  function renderRow(result: DiagnosticResult): void {
    let row = rows.get(result.stage);
    if (!row) {
      row = createElement("li", {
        class: "diag-step",
        "data-testid": `diagnostic-${result.stage}`,
      });
      rows.set(result.stage, row);
      results.appendChild(row);
    }
    row.dataset.status = result.status;
    finalStatus.set(result.stage, result.status);
    details.set(result.stage, result.detail);
    const button = createElement("button", {
      class: "diag-step-btn",
      type: "button",
      "aria-label": t("diagnostics.stepName", {
        label: t(SHORT_LABEL_KEYS[result.stage]),
        stage: diagnosticLabel(result.stage),
        status: statusLabel(result.status),
      }),
    });
    button.append(
      statusIcon(STATUS_KIND[result.status]),
      createElement("span", { class: "diag-step-label" }, t(SHORT_LABEL_KEYS[result.stage])),
    );
    button.addEventListener(
      "click",
      () => {
        picked = result.stage;
        paintSelection();
      },
      { signal },
    );
    row.replaceChildren(button, createElement("span", { class: "sr-only" }, result.detail));
    paintSelection();
  }

  function clearResults(): void {
    clearChildren(results);
    rows.clear();
    finalStatus.clear();
    details.clear();
    picked = null;
    detail.hidden = true;
  }

  function reset(text: string): void {
    clearResults();
    setText(start, t("diagnostics.start"));
    start.classList.remove("secondary");
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
      clearResults();
      resetSelfTest();
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
          start.classList.add("secondary");
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
