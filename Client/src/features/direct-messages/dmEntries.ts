/**
 * The People and Message requests rows both DM lists open with: DM mode's top
 * rows and the Direct folder's first two rows.
 */
import { createDmNavRow } from "./dmNavRow";
import { navigationText } from "../../i18n/navigation";
import type { ContentViewId, NavigationDestinations } from "../navigation/destinations";

/** The People row (when `destinations.people` is set), then the Message requests row (when
 *  `destinations.requests` is set). The badge is the pending-request count, kept apart from
 *  the unread counts. Every subscription a row makes goes on `unsubs`. */
export function buildDmEntries(
  deps: {
    readonly destinations: NavigationDestinations | undefined;
    readonly onOpenView: ((id: ContentViewId, opener: HTMLElement) => void) | undefined;
  },
  unsubs: Array<() => void>,
  tag: "button" | "div" = "button",
): HTMLElement[] {
  const requests = deps.destinations?.requests;
  const open = (view: "people" | "requests") => (opener: HTMLElement) =>
    deps.onOpenView?.(view, opener);
  const rows: HTMLElement[] = [];
  if (deps.destinations?.people !== undefined) {
    rows.push(
      createDmNavRow(
        {
          testId: "dm-people-entry",
          icon: "users",
          label: navigationText("people.title"),
          view: "people",
          onOpen: open("people"),
          tag,
        },
        unsubs,
      ),
    );
  }
  if (requests !== undefined) {
    rows.push(
      createDmNavRow(
        {
          testId: "dm-requests-entry",
          icon: "inbox",
          label: navigationText("requests.row"),
          view: "requests",
          onOpen: open("requests"),
          count: requests.pending,
          countLabel: (count) => navigationText("requests.rowWaiting", { count }),
          tag,
        },
        unsubs,
      ),
    );
  }
  return rows;
}
