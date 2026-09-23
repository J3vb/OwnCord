import type { ApiClient } from "@lib/api";
import { createElement } from "@lib/dom";
import { createLogger } from "@lib/logger";

const log = createLogger("safety-tab");

/**
 * The Settings Safety tab's pane (Q2). B9-10's My reports is its first
 * section; B9-15/16 add notices, restrictions and appeals beside it. The
 * sections load on first open, keeping them out of the main bundle.
 */
export function buildSafetyPane(
  signal: AbortSignal,
  api: Pick<ApiClient, "getMyReports">,
): HTMLDivElement {
  const pane = createElement("div", { class: "settings-pane active" });
  import("./myReports").then(
    ({ buildMyReportsSection }) => {
      if (!signal.aborted) pane.appendChild(buildMyReportsSection(signal, api));
    },
    (err: unknown) => log.error("Safety tab failed to load", { error: String(err) }),
  );
  return pane;
}
