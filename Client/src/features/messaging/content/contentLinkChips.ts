/**
 * Chips for the in-app links a message can carry: `#channel`, a pasted
 * `owncord://message/…` permalink and a pasted `owncord://invite/…` link.
 */

import { createElement, setText } from "@lib/dom";
import { navigateToChannel, findChannelByName, findChannelById } from "@lib/nav/channelNavigation";
import { parseInviteLink, parseMessageLink } from "@lib/nav/deepLink";
import { getChannelMutesHost } from "@lib/prefs/channelMutes";
import { normalizeHostForCertCompare } from "@lib/net/hostNormalize";
import { requestInviteJoin } from "@lib/nav/inviteNavigation";
import { jumpToMessage } from "@lib/nav/messageNavigation";
import { showToast } from "@lib/ui/toast";
import { authStore } from "@stores/auth.store";
import { messagingText } from "../../../i18n/messaging";
import { desktop } from "../../../platform/desktop";

/** Build the clickable chip for a `#name` that resolves, or null. */
export function buildChannelNode(name: string): HTMLSpanElement | null {
  const channel = findChannelByName(name);
  if (channel === null) return null;
  const chip = createElement("span", {
    class: "channel-mention",
    role: "link",
    tabindex: "0",
    "data-channel-id": String(channel.id),
    title: messagingText("channel.goTo", { channel: channel.name }),
  });
  setText(chip, `#${channel.name}`);
  // Listeners are attached per node with no signal, matching the code-block
  // copy button above: these spans live and die with the message row.
  chip.addEventListener("click", () => navigateToChannel(channel.id));
  chip.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      navigateToChannel(channel.id);
    }
  });
  return chip;
}

/**
 * Build the compact chip for a pasted `owncord://message/…` permalink, or null
 * when the link does not parse or points at a channel this user cannot see —
 * an unreachable jump reads better as the raw text it was typed as.
 */
export function buildMessageLinkNode(url: string): HTMLSpanElement | null {
  const link = parseMessageLink(url);
  if (link === null) return null;
  const channel = findChannelById(link.channelId);
  if (channel === null) return null;

  // A DM channel has no user-visible #name; every other DM-labelling surface
  // uses '@', so the chip must too (F15).
  const channelLabel = `${channel.isDm ? "@" : "#"}${channel.name}`;
  const chip = createElement("span", {
    class: "message-link-chip",
    role: "link",
    tabindex: "0",
    "data-channel-id": String(link.channelId),
    "data-message-id": String(link.messageId),
    title: messagingText("message.jumpIn", { channel: channelLabel }),
  });
  const label = createElement("span", { class: "mlc-channel" });
  setText(label, channelLabel);
  const action = createElement("span", { class: "mlc-action" });
  setText(action, messagingText("message.jump"));
  chip.appendChild(label);
  chip.appendChild(action);

  const go = (): void => jumpToMessage(link.channelId, link.messageId);
  // Per-node listeners with no signal, like the #channel chip above: these
  // spans live and die with the message row.
  chip.addEventListener("click", go);
  chip.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go();
    }
  });
  return chip;
}

/** Same server, ignoring case, whitespace, a default :443 and IPv6 brackets. */
function sameHost(a: string, b: string): boolean {
  return normalizeHostForCertCompare(a.trim()) === normalizeHostForCertCompare(b.trim());
}

/**
 * The web client is bound to the server that served it, so it cannot switch to
 * another one: an invite for another server opens that server's own page in a
 * new tab, where its browser client (if it hosts one) takes the code.
 */
function openInviteOnItsServer(code: string, host: string): void {
  let url: URL;
  try {
    url = new URL(`https://${host}/`);
  } catch {
    showToast(messagingText("invite.openTabFailed"), "error");
    return;
  }
  url.searchParams.set("invite", code);
  desktop.urlOpener
    .open(url.href)
    .catch(() => showToast(messagingText("invite.openTabFailed"), "error"));
}

/**
 * Build the chip for a pasted `owncord://invite/…` link, or null when it does
 * not parse. Joining signs out of the current server, so a chip for another
 * server confirms first, and one for the server already open just says so.
 */
export function buildInviteLinkNode(url: string): HTMLSpanElement | null {
  const invite = parseInviteLink(url);
  if (invite === null) return null;
  const current = getChannelMutesHost();
  const alreadyIn = invite.host !== undefined && current !== null && sameHost(invite.host, current);
  const target = invite.host ?? messagingText("invite.thisServer");

  const chip = createElement("span", {
    class: alreadyIn ? "message-link-chip invite-chip-here" : "message-link-chip",
    "data-invite-code": invite.code,
    "data-raw": url,
    title: alreadyIn
      ? messagingText("invite.alreadyIn")
      : messagingText("invite.joinTitle", { server: target }),
  });
  const label = createElement("span", { class: "mlc-channel" });
  setText(label, target);
  const action = createElement("span", { class: "mlc-action" });
  setText(action, alreadyIn ? messagingText("invite.alreadyIn") : messagingText("invite.join"));
  chip.appendChild(label);
  chip.appendChild(action);
  if (alreadyIn) return chip;

  chip.setAttribute("role", "link");
  chip.setAttribute("tabindex", "0");
  const go = (): void => {
    if (__OWNCORD_WEB__ && invite.host !== undefined) {
      openInviteOnItsServer(invite.code, invite.host);
      return;
    }
    const name = authStore.getState().serverName ?? current ?? "";
    const body =
      invite.host === undefined
        ? messagingText("invite.confirmBodyNoHost", { current: name })
        : messagingText("invite.confirmBody", { current: name, target });
    // On demand, like the masked-link guard: keeps the modal off the startup chunk.
    void import("../../invites/InviteJoinConfirm").then((m) =>
      m.confirmInviteJoin(body, () => requestInviteJoin(invite.code, invite.host)),
    );
  };
  chip.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    go();
  });
  chip.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      go();
    }
  });
  return chip;
}
