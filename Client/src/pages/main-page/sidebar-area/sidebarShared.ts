/** Constants and small helpers the voice settings modules share. */
import { createLogger } from "@lib/logger";
import { createLazyScreen } from "@lib/ui/lazyScreen";

export const log = createLogger("SidebarArea");

// Loads on first use, so its code stays out of the main-page chunk.
export const createChannelModalScreen = createLazyScreen(
  "create-channel-modal",
  () => import("../../../features/channels/CreateChannelModal"),
);
