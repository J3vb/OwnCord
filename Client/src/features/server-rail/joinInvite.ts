/**
 * The rail's "Join with an invite link" path: read what the user pasted, ask
 * "Leave <current> to join <target>?" and hand the code to the invite flow.
 */

import { normaliseInviteCode, parseInviteLink } from "@lib/deep-link";
import { requestInviteJoin } from "@lib/invite-navigation";
import { createLogger } from "@lib/logger";
import { authStore } from "@stores/auth.store";
import { messagingText } from "../../i18n/messaging";

const log = createLogger("server-rail");

export interface ParsedInvite {
  readonly code: string;
  readonly host?: string;
}

/** Plausible bare invite code: letters, digits, dash, underscore. */
const BARE_CODE = /^[A-Za-z0-9_-]{4,64}$/;

/**
 * A full owncord:// invite link, or a bare code (meaning the current server).
 * Anything else (a message link, a web URL, free text) is null. Pure.
 */
export function parseInviteInput(raw: string): ParsedInvite | null {
  const text = raw.trim();
  if (text === "") return null;
  if (text.includes("://")) return parseInviteLink(text);
  if (!BARE_CODE.test(text)) return null;
  const code = normaliseInviteCode(text);
  return code === "" ? null : { code };
}

/** Confirm, then join. The dialog module loads on demand, off the startup chunk. */
export function confirmAndJoinInvite(
  invite: ParsedInvite,
  currentName: string,
  run: (code: string, host?: string) => void = requestInviteJoin,
): void {
  const body =
    invite.host === undefined
      ? messagingText("invite.confirmBodyNoHost", { current: currentName })
      : messagingText("invite.confirmBody", { current: currentName, target: invite.host });
  void import("@components/InviteJoinConfirm")
    .then((m) => m.confirmInviteJoin(body, () => run(invite.code, invite.host)))
    .catch((err: unknown) => log.warn("Invite confirmation failed to open", err));
}

/** The name of the server being left, for the confirm text. */
export function currentServerName(fallbackHost: string): string {
  const name = authStore.getState().serverName;
  if (name !== null && name !== "") return name;
  return fallbackHost !== "" ? fallbackHost : messagingText("invite.thisServer");
}
