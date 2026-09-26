import type { ApiClient } from "@lib/api";
import { createElement } from "@lib/dom";
import { reportEntryText } from "../../i18n/reportEntry";
import { buildSafetyTab } from "../safety/Notices";

/**
 * The Settings Safety tab's pane (Q2): B9-15's restrictions and history with
 * B9-16's appeals, then B9-10's My reports. The sections load on first open,
 * keeping them out of the main bundle; a section that cannot load says so.
 */
export function buildSafetyPane(
  signal: AbortSignal,
  api: Pick<ApiClient, "getMyReports">,
): HTMLDivElement {
  const pane = buildSafetyTab(signal);
  import("./myReports").then(
    ({ buildMyReportsSection }) => {
      if (!signal.aborted) pane.appendChild(buildMyReportsSection(signal, api));
    },
    () => {
      if (!signal.aborted) {
        pane.appendChild(
          createElement(
            "div",
            { class: "form-error", role: "alert" },
            reportEntryText("safetyLoadFailed"),
          ),
        );
      }
    },
  );
  return pane;
}
