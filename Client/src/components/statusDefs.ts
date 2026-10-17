/**
 * The selectable presence statuses, shared by the status dropdown and the
 * self profile card so the two can never offer different options.
 */

import type { UserStatus } from "@lib/types";

export interface StatusDef {
  readonly value: UserStatus;
  readonly labelKey: "status.online" | "status.idle" | "status.dnd" | "status.invisible";
  readonly color: string;
  /** The one-line consequence shown under the label, where there is one. */
  readonly noteKey?: "status.dndNote" | "status.invisibleNote";
}

/**
 * "invisible" is its own value now, not "offline" wearing a different label.
 * The server stores it as chosen and shows everyone else offline, so the
 * picker can finally send what it means — and the status survives a reconnect
 * instead of flashing back to online.
 */
export const STATUS_DEFS: readonly StatusDef[] = [
  { value: "online", labelKey: "status.online", color: "var(--green)" },
  { value: "idle", labelKey: "status.idle", color: "var(--yellow)" },
  { value: "dnd", labelKey: "status.dnd", color: "var(--red)", noteKey: "status.dndNote" },
  {
    value: "invisible",
    labelKey: "status.invisible",
    color: "var(--text-micro)",
    noteKey: "status.invisibleNote",
  },
];

export function colorForStatus(status: UserStatus): string {
  return STATUS_DEFS.find((d) => d.value === status)?.color ?? "var(--text-micro)";
}
