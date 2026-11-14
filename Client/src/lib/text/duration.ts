/**
 * A duration in milliseconds as "m:ss", or "h:mm:ss" from an hour on. `padded`
 * gives the call-timer look, "mm:ss" or "hh:mm:ss". Negative or non-finite
 * counts as 0, and part of a second is dropped.
 */
export function formatDuration(ms: number, padded = false): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  const lead = padded ? 2 : 1;
  if (hours > 0) {
    return `${String(hours).padStart(lead, "0")}:${String(minutes).padStart(2, "0")}:${seconds}`;
  }
  return `${String(minutes).padStart(lead, "0")}:${seconds}`;
}
