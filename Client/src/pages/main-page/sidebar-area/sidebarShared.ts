/** Constants and small helpers the voice settings modules share. */
import { createElement } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { createLogger } from "@lib/logger";
import type { DmConversation } from "@components/DmSidebar";
import { createLazyScreen } from "@components/lazyScreen";
import { buildDmConversations, isDmInCall } from "../SidebarDmHelpers";

export const log = createLogger("SidebarArea");

/** A server-header icon button: named by its aria-label, the title is its
 *  hover tooltip. */
export function headerAction(
  label: string,
  hint: string,
  icon: IconName,
  testId: string,
): HTMLButtonElement {
  const btn = createElement("button", {
    type: "button",
    class: "sidebar-header-action",
    title: hint,
    "aria-label": label,
    "data-testid": testId,
  });
  btn.appendChild(createIcon(icon, 16));
  return btn;
}

// Both modals load on first use, so their code stays out of the main-page chunk.
export const createChannelModalScreen = createLazyScreen(
  "create-channel-modal",
  () => import("@components/CreateChannelModal"),
);
export const memberPickerScreen = createLazyScreen(
  "member-picker",
  () => import("../MemberPickerModal"),
);

/** The DM rows, each marked when someone is in that DM's call. */
export function dmConversations(activeChannelId: number | null): DmConversation[] {
  return buildDmConversations(activeChannelId).map((c) => ({
    ...c,
    inCall: isDmInCall(c.channelId),
  }));
}
