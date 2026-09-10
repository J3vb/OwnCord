import { appendChildren, clearChildren, createElement } from "@lib/dom";
import {
  DIAGNOSTIC_LABELS,
  getConnectionDiagnosticsSessionSignal,
  runConnectionDiagnostics,
  type DiagnosticStage,
} from "@lib/connectionDiagnostics";

export function createConnectionDiagnosticsPanel(signal: AbortSignal): {
  element: HTMLDivElement;
  cleanup(): void;
} {
  const element = createElement("div", {
    "data-testid": "connection-diagnostics",
    style:
      "padding: 16px; margin-bottom: 16px; background: var(--bg-tertiary); border-radius: 8px;",
  });
  const title = createElement("h3", { style: "margin: 0 0 8px;" }, "Test my connection and voice");
  const description = createElement(
    "p",
    { class: "setting-desc" },
    "Checks this client's connection. To check incoming voice or video, join a call with someone speaking or sharing video before starting. The test does not join a call or send microphone audio.",
  );
  const micLabel = createElement("label", { style: "display: block; margin: 12px 0;" });
  const microphone = createElement("input", { type: "checkbox" });
  microphone.checked = true;
  micLabel.append(
    microphone,
    document.createTextNode(" Include a brief microphone permission check"),
  );
  const controls = createElement("div", { style: "display: flex; gap: 8px;" });
  const start = createElement("button", { class: "ac-btn" }, "Start connection test");
  const cancel = createElement("button", { class: "ac-btn" }, "Cancel test");
  cancel.hidden = true;
  appendChildren(controls, start, cancel);
  const summary = createElement(
    "p",
    { role: "status", "data-testid": "diagnostics-status" },
    "Ready to test.",
  );
  const results = createElement("div", { "aria-live": "polite" });
  const limitation = createElement(
    "p",
    { class: "setting-desc" },
    "Results describe this device and this moment. Incoming media checks do not verify speaker output, outgoing delivery or anyone's encryption identity. Other networks may behave differently.",
  );
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
      summary.textContent = "Testing…";
      const sessionSignal = getConnectionDiagnosticsSessionSignal();
      const onSessionChange = (): void => {
        current.abort();
        if (!alive || attempt !== current) return;
        clearChildren(results);
        summary.textContent =
          "The signed-in session changed. Run a new test for the current server.";
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
              ? "Not tested"
              : result.status[0]!.toUpperCase() + result.status.slice(1);
          row.textContent = `${DIAGNOSTIC_LABELS[result.stage]} — ${label}: ${result.detail}`;
        },
        AbortSignal.any([signal, current.signal]),
        microphone.checked,
      )
        .then(() => {
          if (!alive || attempt !== current || current.signal.aborted) return;
          summary.textContent = "Test complete. Review each result below.";
        })
        .catch(() => {
          if (!alive || attempt !== current) return;
          clearChildren(results);
          if (!sessionSignal?.aborted)
            summary.textContent = current.signal.aborted
              ? "Test cancelled."
              : "The test could not finish. Try again.";
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
