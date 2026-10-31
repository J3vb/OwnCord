/**
 * The presence dot, in one place. Every site that draws a member's status
 * (member list, DM lists, profile cards, the user bar) calls
 * `applyStatusIndicator` instead of colouring the dot itself, so the round dot
 * and the phone shape a member on the Android app gets cannot drift apart.
 *
 * The phone is the same element in the same colour: the `status-mobile` class
 * only changes its shape in CSS (see `styles/app/member-list.css`).
 */

import type { UserStatus } from "../types";
import { statusLabelFor } from "../../i18n/shell";
import { createIcon } from "../icons";

/** The class that turns the round dot into the phone shape. */
export const STATUS_MOBILE_CLASS = "status-mobile";

/** The dot's fill for a status. Anything that is not online, idle or do not disturb is grey. */
export function statusColor(status: UserStatus | (string & {})): string {
  switch (status) {
    case "online":
      return "var(--green)";
    case "idle":
      return "var(--yellow)";
    case "dnd":
      return "var(--red)";
    default:
      return "var(--text-micro)";
  }
}

/** Whether the phone shape shows: only a member who is online, idle or do not
 *  disturb can be on the phone app, never one who reads as offline. */
export function showsPhone(status: UserStatus | (string & {}), mobile: boolean): boolean {
  return mobile && (status === "online" || status === "idle" || status === "dnd");
}

/** The hover and screen-reader text for a status: "Online on the phone app" for
 *  a member on the phone, else the plain status label. */
export function statusIndicatorLabel(status: UserStatus | (string & {}), mobile: boolean): string {
  return statusLabelFor(status, showsPhone(status, mobile));
}

/** Paint `el` as the status dot for `status`: its colour, the phone class and
 *  its title. Returns the label so a caller can mirror it into `aria-label`. */
export function applyStatusIndicator(
  el: HTMLElement,
  status: UserStatus | (string & {}),
  mobile: boolean,
): string {
  const label = statusIndicatorLabel(status, mobile);
  el.style.background = statusColor(status);
  el.classList.toggle(STATUS_MOBILE_CLASS, showsPhone(status, mobile));
  el.title = label;
  return label;
}

/** The class on a profile status line's marker while it shows the phone. */
export const STATUS_LINE_PHONE_CLASS = "status-line-phone";

/** Paint the small marker in front of a profile's status text: the status
 *  colour as a dot, or a muted phone stroke icon while the member is on the
 *  phone app. Returns the status text the line should read. */
export function applyStatusLine(
  marker: HTMLElement,
  status: UserStatus | (string & {}),
  mobile: boolean,
): string {
  const phone = showsPhone(status, mobile);
  marker.classList.toggle(STATUS_LINE_PHONE_CLASS, phone);
  if (phone) {
    marker.style.background = "";
    if (marker.firstElementChild === null) {
      const icon = createIcon("smartphone", 12);
      icon.setAttribute("aria-hidden", "true");
      marker.appendChild(icon);
    }
  } else {
    marker.replaceChildren();
    marker.style.background = statusColor(status);
  }
  return statusIndicatorLabel(status, mobile);
}
