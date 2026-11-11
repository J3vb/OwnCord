/**
 * Message time labels: the header time and the full-date tooltip.
 */
import { formatClockTime, formatMessageTimestamp, parseTimestamp } from "@lib/text/formatting";
import { formatFullDateTime } from "@lib/text/discordTimestamp";
import { isPhoneLayout } from "@lib/ui/bottomSheet";

/** Weekday, date and time for a tooltip, in Discord's "F" style. */
export function fullDateTimeTitle(iso: string): string {
  return formatFullDateTime(parseTimestamp(iso));
}

/**
 * The time in a message's header. A phone shows the clock alone ("14:05"): the
 * day separators carry the date, and the full date would cost about 90 px a
 * row. The title keeps the full date either way. Read when the row is drawn;
 * `relabelRenderedTimes` redraws the rows on a rotation.
 */
export function messageHeaderTime(iso: string): string {
  return isPhoneLayout() ? formatClockTime(iso) : formatMessageTimestamp(iso);
}
