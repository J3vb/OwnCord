// A chat_message `kind` marks a row the server wrote itself (a call log row, a
// group DM event). Ordinary messages arrive with `kind` unset; an empty string
// counts as unset too. Every gate that treats those rows as read-only system
// lines asks this one question, so a future kind inherits the behaviour.

/** True when `kind` names a server-written row rather than an ordinary message. */
export function isServerRowKind(kind: string | undefined): boolean {
  return kind !== undefined && kind !== "";
}

/** True for the "X just joined" welcome row (WP 8.6): deletable like a pin row, and the one server row a member may reply to. */
export function isWelcomeRowKind(kind: string | undefined): boolean {
  return kind === "member_join";
}

/** True for the "X pinned a message" row, the one server row a member may delete. */
export function isPinRowKind(kind: string | undefined): boolean {
  return kind === "pin_add";
}
