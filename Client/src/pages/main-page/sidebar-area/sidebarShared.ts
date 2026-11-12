/** Constants and small helpers the voice settings modules share. */
import { createElement } from "@lib/dom";
import { createIcon, type IconName } from "@lib/icons";
import { createLogger } from "@lib/logger";
import { createLazyScreen } from "@lib/ui/lazyScreen";

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

// Loads on first use, so its code stays out of the main-page chunk.
export const createChannelModalScreen = createLazyScreen(
  "create-channel-modal",
  () => import("../../../features/channels/CreateChannelModal"),
);
