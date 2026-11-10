/**
 * Sidebar build step: the channel list and the create-channel modal.
 */
import type { ChannelType } from "@lib/types";
import type { MountableComponent } from "@lib/text/safeRender";
import { errorText } from "@lib/api";
import { createChannelSidebar } from "../../../features/channels/ChannelSidebar";
import { openEditChannelModal } from "../../../features/channels/editChannelModal";
import { rollBackRejectedReorders } from "../../../features/channels/channelReorderRollback";
import { withThreadsStore } from "@stores/threadsLoader";
import {
  requestOpenThread,
  requestOpenThreadList,
} from "../../../features/threads/threadNavigation";
import { createDeleteChannelModal } from "../../../features/channels/DeleteChannelModal";
import { createSidebarVoiceCallbacks, createVoiceModerationCallbacks } from "../VoiceCallbacks";
import { markChannelRead } from "@lib/readState";
import { uiStore } from "@stores/ui.store";
import { type CategoryRef } from "@stores/channels.store";
import { shellText } from "../../../i18n/shell";
import { createChannelModalScreen } from "./sidebarShared";
import type { SidebarScope } from "./sidebarScope";

export function mountChannelSidebar(sc: SidebarScope): void {
  // The category "+", the empty-state button and the server menu share this.
  sc.openCreateChannelModal = function openCreateChannelModal(
    category: CategoryRef,
    type?: ChannelType,
  ): void {
    if (sc.activeModal !== null) return;
    // The placeholder holds the modal slot while the dialog loads: a second
    // click is refused, and a teardown or another modal in between drops the
    // late one (the same shape as the edit dialog below).
    const pending: MountableComponent = { mount: () => {} };
    sc.activeModal = pending;
    void createChannelModalScreen
      .load(() => sc.activeModal === pending)
      .then((screen) => {
        if (screen === null) {
          if (sc.activeModal === pending) sc.activeModal = null;
          return;
        }
        if (sc.activeModal !== pending) return;
        const modal = screen.createCreateChannelModal({
          category,
          type,
          onCreate: async (data) => {
            try {
              await sc.api.adminCreateChannel(data);
              modal.destroy?.();
              sc.activeModal = null;
            } catch (err) {
              const msg = errorText(err, shellText("channel.createFailed"));
              sc.getToast()?.show(msg, "error");
              // The modal's own catch re-enables its submit button and renders
              // the inline error, so the failure must propagate to it.
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
      });
  };

  // ---------------------------------------------------------------------------
  // Channel sidebar builder (channels mode)
  // ---------------------------------------------------------------------------

  sc.buildChannelSidebar = function buildChannelSidebar(): MountableComponent {
    const sidebarVoice = createSidebarVoiceCallbacks(sc.ws);
    return createChannelSidebar({
      onVoiceJoin: sidebarVoice.onVoiceJoin,
      onOpenCall: () => sc.opts.onOpenCall?.(),
      onVoiceModerate: createVoiceModerationCallbacks(sc.ws),
      onWatchStream: sc.opts.onWatchStream,
      onOpenThread: requestOpenThread,
      onOpenThreadList: requestOpenThreadList,
      onUnfollowThread: (threadId) => {
        // Dropped while the socket is down: a lost frame would leave the row until the next ready.
        if (uiStore.getState().connectionStatus !== "connected") return;
        sc.ws.send({ type: "thread_follow", payload: { thread_id: threadId, follow: false } });
      },
      onMarkThreadRead: (threadId) => {
        // Dropped while the socket is down, like Unfollow: a lost mark_read would clear the row for nothing.
        if (uiStore.getState().connectionStatus !== "connected") return;
        // mark_read accepts a thread id; the same path as a channel's Mark as Read.
        markChannelRead(threadId);
        withThreadsStore((m) => m.clearFollowedCounts(threadId));
      },
      onInviteFromChannel: () => {
        void sc.headerInviteCtrl.open();
      },
      onCreateChannel: sc.openCreateChannelModal,
      onCreateCategory: sc.categoryDialogs.create,
      onRenameCategory: sc.categoryDialogs.rename,
      onDeleteCategory: sc.categoryDialogs.remove,
      onMoveCategory: sc.categoryDialogs.move,
      onEditChannel: (channel) => openEditChannelModal(sc, channel),
      onDeleteChannel: (channel) => {
        if (sc.activeModal !== null) return;
        const modal = createDeleteChannelModal({
          channelId: channel.id,
          channelName: channel.name,
          onConfirm: async () => {
            try {
              await sc.api.adminDeleteChannel(channel.id);
              modal.destroy?.();
              sc.activeModal = null;
            } catch (err) {
              const msg = errorText(err, shellText("channel.deleteFailed"));
              sc.getToast()?.show(msg, "error");
              // Propagate so the modal re-enables its confirm button and shows
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
      onReorderCategory: sc.categoryDialogs.place,
      onReorderChannel: (reorders) => {
        // The store already applied the optimistic order (drag-reorder.ts,
        // on mouseup). Aggregate the per-channel PATCHes and surface a single
        // failure toast — same try/catch+toast contract as onSave/onDelete
        // above. A drop into another category sends the moved channel's
        // `category_id` with its position. A rejected PATCH is rolled
        // back to its previous position, and previous category, only
        // if no channel_update broadcast arrived for that channel since the
        // request started (the server broadcasts before it answers, so a
        // broadcast means the write landed) and it still shows the optimistic
        // value. Only the broadcast counts: unread/mention badge mutations also
        // replace the channel object but confirm nothing. A request that failed
        // only because its response was lost is covered by the reconnect
        // resync, so it needs no reconciliation here.
        // The moved channel's category PATCH and its peers' position PATCHes run
        // concurrently. That is safe only because the server does not enforce
        // unique positions: no ordering between them can make one collide.
        const touched = new Set<number>();
        const unsubscribe = sc.ws.on("channel_update", (payload) => {
          touched.add(payload.id);
        });
        void Promise.allSettled(
          reorders.map((r) =>
            sc.api.adminUpdateChannel(
              r.channelId,
              r.category === undefined
                ? { position: r.newPosition }
                : { category_id: r.category.next.categoryId ?? 0, position: r.newPosition },
            ),
          ),
        ).then((results) => {
          unsubscribe();
          const outcome = rollBackRejectedReorders(results, reorders, touched);
          if (outcome.failed) {
            sc.getToast()?.show(
              outcome.movedFailed
                ? errorText(outcome.failure, shellText("channel.moveFailed"))
                : shellText("channel.reorderFailed"),
              "error",
            );
          }
        });
      },
      onPurgeChannel: async (channel, count) => {
        try {
          // The store is updated by the chat_bulk_deleted broadcast, so the
          // response is only used for the toast's honest count.
          const result = await sc.api.purgeMessages(channel.id, count);
          sc.getToast()?.show(
            result.count === 0
              ? shellText("purge.none", { channel: channel.name })
              : shellText("purge.done", { count: result.count, channel: channel.name }),
            result.count === 0 ? "info" : "success",
          );
        } catch (err) {
          const msg = errorText(err, shellText("purge.failed"));
          sc.getToast()?.show(msg, "error");
        }
      },
    });
  };
}
