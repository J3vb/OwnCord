import { appendChildren, clearChildren, createElement } from "@lib/dom";
import { settingsText as t } from "../../i18n/settings";
import {
  diagnosticLabel,
  getConnectionDiagnosticsSessionSignal,
  runConnectionDiagnostics,
  type DiagnosticStage,
  type DiagnosticStatus,
} from "@lib/connectionDiagnostics";

const DIAGNOSTIC_STATUS_KEYS = {
  running: "diagnostics.status.running",
  passed: "diagnostics.status.passed",
  failed: "diagnostics.status.failed",
} as const satisfies Record<Exclude<DiagnosticStatus, "not-tested">, string>;

export function createConnectionDiagnosticsPanel(signal: AbortSignal): {
  element: HTMLDivElement;
  cleanup(): void;
} {
  const element = createElement("div", {
    "data-testid": "connection-diagnostics",
    style:
      "padding: 16px; margin-bottom: 16px; background: var(--bg-tertiary); border-radius: 8px;",
  });
  const title = createElement("h3", { style: "margin: 0 0 8px;" }, t("diagnostics.title"));
  const description = createElement("p", { class: "setting-desc" }, t("diagnostics.description"));
  const micLabel = createElement("label", { style: "display: block; margin: 12px 0;" });
  const microphone = createElement("input", { type: "checkbox" });
  microphone.checked = true;
  micLabel.append(microphone, document.createTextNode(t("diagnostics.micCheck")));
  const controls = createElement("div", { style: "display: flex; gap: 8px;" });
  const start = createElement("button", { class: "ac-btn" }, t("diagnostics.start"));
  const cancel = createElement("button", { class: "ac-btn" }, t("diagnostics.cancel"));
  cancel.hidden = true;
  appendChildren(controls, start, cancel);
  const summary = createElement(
    "p",
    { role: "status", "data-testid": "diagnostics-status" },
    t("diagnostics.ready"),
  );
  const results = createElement("div", { "aria-live": "polite" });
  const limitation = createElement("p", { class: "setting-desc" }, t("diagnostics.limitation"));
  appendChildren(element, title, description, micLabel, controls, summary, results, limitation);

  let attempt: AbortController | null = null;
  let detachSession: (() => void) | null = null;
  let alive = true;
  const rows = new Map<DiagnosticStage, HTMLDivElement>();

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
      start.disabled = true;
      microphone.disabled = true;
      cancel.hidden = false;
      summary.textContent = t("diagnostics.testing");
      const sessionSignal = getConnectionDiagnosticsSessionSignal();
      const onSessionChange = (): void => {
        current.abort();
        if (!alive || attempt !== current) return;
        clearChildren(results);
        summary.textContent = t("diagnostics.sessionChanged");
        start.disabled = false;
        microphone.disabled = false;
        cancel.hidden = true;
      };
      sessionSignal?.addEventListener("abort", onSessionChange, { once: true });
      detachSession = () => sessionSignal?.removeEventListener("abort", onSessionChange);
      void runConnectionDiagnostics(
        (result) => {
          if (!alive || attempt !== current || current.signal.aborted) return;
          let row = rows.get(result.stage);
          if (!row) {
            row = createElement("div", {
              "data-testid": `diagnostic-${result.stage}`,
              style: "padding: 10px 0; border-top: 1px solid var(--bg-active);",
            });
            rows.set(result.stage, row);
            results.appendChild(row);
          }
          row.dataset.status = result.status;
          const label =
            result.status === "not-tested"
              ? t("diagnostics.notTested")
              : t(DIAGNOSTIC_STATUS_KEYS[result.status]);
          row.textContent = `${diagnosticLabel(result.stage)} — ${label}: ${result.detail}`;
        },
        AbortSignal.any([signal, current.signal]),
        microphone.checked,
      )
        .then(() => {
          if (!alive || attempt !== current || current.signal.aborted) return;
          summary.textContent = t("diagnostics.complete");
        })
        .catch(() => {
          if (!alive || attempt !== current) return;
          clearChildren(results);
          if (!sessionSignal?.aborted)
            summary.textContent = current.signal.aborted
              ? t("diagnostics.cancelled")
              : t("diagnostics.failed");
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
