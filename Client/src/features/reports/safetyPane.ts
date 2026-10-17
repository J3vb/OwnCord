import type { ApiClient } from "@lib/api";
import { createElement } from "@lib/dom";
import { blockedUsersText } from "../../i18n/blockedUsers";
import { reportEntryText } from "../../i18n/reportEntry";
import { buildSafetyTab } from "../safety/Notices";

/**
 * The Settings Safety tab's pane (Q2): B9-15's restrictions and history with
 * B9-16's appeals, then B9-10's My reports. 3B-7's Blocked users sits above
 * them all. The sections load on first open, keeping them out of the main
 * bundle; a section that cannot load says so.
 */
export function buildSafetyPane(
  signal: AbortSignal,
  api: Pick<ApiClient, "getMyReports" | "listBlocks" | "unblockUser">,
): HTMLDivElement {
  const pane = buildSafetyTab(signal);
  import("../safety/BlockedUsers")
    .then(({ loadBlockedUsersSection }) => loadBlockedUsersSection(signal, api))
    .then(
      (section) => {
        if (!signal.aborted) pane.prepend(section);
      },
      () => {
        if (!signal.aborted) {
          pane.prepend(
            createElement(
              "div",
              { class: "form-error", role: "alert" },
              blockedUsersText("chunkFailed"),
            ),
          );
        }
      },
    );
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
