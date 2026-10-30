import type { ApiClient } from "@lib/api";
import { createElement } from "@lib/dom";
import { dmPrivacyEnabled } from "@lib/net/serverCapabilities";
import { reportEntryText } from "../../i18n/reportEntry";
import { buildSafetyTab } from "../safety/Notices";

/**
 * The Settings Safety tab's pane: the restrictions and history, with the
 * appeals, then My reports. Blocked users sits above them all, under the
 * Direct messages switches. The sections load on first open, keeping them out of
 * the main bundle; a section that cannot load says so.
 */
export function buildSafetyPane(
  signal: AbortSignal,
  api: Pick<
    ApiClient,
    "getMyReports" | "listBlocks" | "unblockUser" | "getDmPrivacy" | "putDmPrivacy"
  >,
): HTMLDivElement {
  const pane = buildSafetyTab(signal);
  // Whichever lazy section arrives first, Direct messages ends up above
  // Blocked users.
  let dmSection: HTMLElement | null = null;
  let blockedSection: HTMLElement | null = null;
  const place = (section: HTMLElement, below: HTMLElement | null): void => {
    if (below === null) pane.prepend(section);
    else below.after(section);
  };
  // The capability is read once, when the pane opens.
  if (dmPrivacyEnabled()) {
    import("../safety/DmPrivacy").then(
      ({ buildDmPrivacySection }) => {
        if (signal.aborted) return;
        dmSection = buildDmPrivacySection(signal, api);
        if (blockedSection === null) pane.prepend(dmSection);
        else blockedSection.before(dmSection);
      },
      () => {
        if (!signal.aborted) {
          pane.prepend(
            createElement(
              "div",
              { class: "form-error", role: "alert" },
              reportEntryText("dmPrivacyLoadFailed"),
            ),
          );
        }
      },
    );
  }
  import("../safety/BlockedUsers")
    .then(({ loadBlockedUsersSection }) => loadBlockedUsersSection(signal, api))
    .then(
      (section) => {
        if (signal.aborted) return;
        blockedSection = section;
        place(section, dmSection);
      },
      () => {
        if (!signal.aborted) {
          pane.prepend(
            createElement(
              "div",
              { class: "form-error", role: "alert" },
              reportEntryText("blockedLoadFailed"),
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
