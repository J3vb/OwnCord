/** Opening the edit-channel dialog from the channel list. */

import type { MountableComponent } from "@lib/text/safeRender";
import { errorText } from "@lib/api";
import { channelsStore, type Channel } from "@stores/channels.store";
import { shellText } from "../../i18n/shell";
import type { SidebarScope } from "../../pages/main-page/sidebar-area/sidebarScope";

type EditModalFields = Pick<
  Parameters<typeof import("./editChannelDialog").createEditChannelModal>[0],
  | "channelId"
  | "channelName"
  | "channelType"
  | "channelTopic"
  | "channelCategory"
  | "channelCategoryId"
  | "channelSlowMode"
  | "channelNsfw"
  | "channelVoiceMaxUsers"
  | "channelVoiceMaxVideo"
  | "channelPasswordProtected"
>;

/**
 * Pre-fill from the store rather than from the sidebar's row: the store is
 * what channel_update writes into, so the modal opens on the current values
 * even if the row was rendered before the last edit landed.
 */
function editModalFields(channel: Channel): EditModalFields {
  const stored = channelsStore.getState().channels.get(channel.id);
  return {
    channelId: channel.id,
    channelName: stored?.name ?? channel.name,
    channelType: channel.type,
    channelTopic: stored?.topic ?? "",
    channelCategory: stored?.category ?? "",
    channelCategoryId: stored?.categoryId ?? 0,
    ...editModalLimits(stored),
  };
}

function editModalLimits(
  stored: Channel | undefined,
): Omit<
  EditModalFields,
  | "channelId"
  | "channelName"
  | "channelType"
  | "channelTopic"
  | "channelCategory"
  | "channelCategoryId"
> {
  return {
    channelSlowMode: stored?.slowMode ?? 0,
    channelNsfw: stored?.nsfw ?? false,
    channelVoiceMaxUsers: stored?.voiceMaxUsers ?? 0,
    channelVoiceMaxVideo: stored?.voiceMaxVideo ?? 0,
    channelPasswordProtected: stored?.passwordProtected ?? false,
  };
}

/** The editor is admin-only and never on first paint, so it loads on demand. */
export function openEditChannelModal(sc: SidebarScope, channel: Channel): void {
  if (sc.activeModal !== null) return;
  // The placeholder holds the modal slot while it loads: a second click is
  // refused, and a teardown in between drops the late modal.
  const pending: MountableComponent = { mount: () => {} };
  sc.activeModal = pending;
  void import("./editChannelDialog").then(
    ({ createEditChannelModal }) => {
      if (sc.activeModal !== pending) return;
      const modal = createEditChannelModal({
        ...editModalFields(channel),
        // The editor's own write: the live channel_update reaches the store.
        onSaveForum: async (body) => {
          await sc.api.adminUpdateForumSettings(channel.id, body);
        },
        onSave: async (data) => {
          try {
            await sc.api.adminUpdateChannel(channel.id, data);
            modal.destroy?.();
            sc.activeModal = null;
          } catch (err) {
            const msg = errorText(err, shellText("channel.updateFailed"));
            sc.getToast()?.show(msg, "error");
            // Propagate so the modal re-enables its save button and shows
            // the inline error.
            throw err;
          }
        },
        onClose: () => {
          modal.destroy?.();
          sc.activeModal = null;
        },
      });
      sc.activeModal = modal;
      modal.mount(document.body);
    },
    () => {
      if (sc.activeModal === pending) sc.activeModal = null;
    },
  );
}
