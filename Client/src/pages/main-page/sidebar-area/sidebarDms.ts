/**
 * Sidebar build step: the DM list and its actions (open, close or leave, rename
 * and icon for groups, the member picker, returning to a channel).
 */
import { isTextLikeChannel } from "@lib/types";
import type { MountableComponent } from "@lib/text/safeRender";
import { errorText } from "@lib/api";
import { createDmSidebar, type DmSidebar } from "@components/DmSidebar";
import type { DmMenuActions } from "@components/dmContextMenu";
import { selectDmConversation, handleCreateDm, handleCreateGroupDm } from "../SidebarDmHelpers";
import { createPromptModal } from "@lib/ui/modalFactory";
import { muteChannel, toggleChannelMute, unmuteChannel } from "@lib/prefs/channelMutes";
import { markChannelRead } from "@lib/readState";
import { setSidebarMode } from "@stores/ui.store";
import { authStore } from "@stores/auth.store";
import { channelsStore, setActiveChannel } from "@stores/channels.store";
import { keepDmForCall, releaseKeptDm } from "../../../features/direct-messages/keptCallDms";
import { dmStore, closeDmLocally, restoreDmChannel } from "@stores/dm.store";
import { clearChannelVoiceUsers } from "@stores/voice.store";
import { shellText } from "../../../i18n/shell";
import { connectText } from "../../../i18n/connect";
import {
  collapseSpaces,
  lineHintText,
  visibleLength,
  MAX_GROUP_DM_NAME_LEN,
} from "@lib/text/nameLimits";
import { memberPickerScreen, dmConversations } from "./sidebarShared";
import type { SidebarScope } from "./sidebarScope";

export function mountDmSidebar(sc: SidebarScope): void {
  // ---------------------------------------------------------------------------
  // DM helper dependencies (shared by DM section and DM sidebar)
  // ---------------------------------------------------------------------------

  sc.dmDeps = {
    api: sc.api,
    getToast: sc.getToast,
    getChannelBeforeDm: () => sc.channelBeforeDm,
    setChannelBeforeDm: (id) => {
      sc.channelBeforeDm = id;
    },
  };

  /**
   * Show the member picker. One selection opens a 1:1 DM; two or more create a
   * group — the picker itself decides which, so the sidebar does not need two
   * entry points for what the user experiences as one action.
   */
  sc.showMemberPicker = function showMemberPicker(): void {
    if (sc.activeModal !== null) return;
    const pending: MountableComponent = { mount: () => {} };
    sc.activeModal = pending;
    void memberPickerScreen
      .load(() => sc.activeModal === pending)
      .then((screen) => {
        if (screen === null) {
          if (sc.activeModal === pending) sc.activeModal = null;
          return;
        }
        if (sc.activeModal !== pending) return;
        const picker = screen.createMemberPickerModal({
          onSelect: (userId) => {
            sc.closePickerModal();
            void handleCreateDm(userId, sc.dmDeps);
          },
          onSelectGroup: (userIds, name) => {
            sc.closePickerModal();
            void handleCreateGroupDm(userIds, name, sc.dmDeps);
          },
          onClose: () => {
            sc.activeModal = null;
          },
        });
        sc.activeModal = picker;
        picker.mount(document.body);
      });
  };

  sc.closePickerModal = function closePickerModal(): void {
    if (sc.activeModal !== null) {
      sc.activeModal.destroy?.();
      sc.activeModal = null;
    }
  };

  // ---------------------------------------------------------------------------
  // DM sidebar builder (dms mode)
  // ---------------------------------------------------------------------------

  /**
   * Leave the DM list gracefully after a conversation goes away: fall back to
   * another DM if there is one, otherwise to the channel the user came from.
   */
  sc.fallBackFromDm = function fallBackFromDm(): void {
    const remaining = dmStore.getState().channels;
    if (remaining.length > 0) {
      selectDmConversation(remaining[0]!, sc.dmDeps);
      return;
    }
    setSidebarMode("channels");
    if (sc.channelBeforeDm !== null && channelsStore.getState().channels.has(sc.channelBeforeDm)) {
      setActiveChannel(sc.channelBeforeDm);
      return;
    }
    for (const ch of channelsStore.getState().channels.values()) {
      if (isTextLikeChannel(ch)) {
        setActiveChannel(ch.id);
        break;
      }
    }
  };

  /**
   * Close a 1:1 DM or leave a group.
   *
   * The client does not decide which: the server's DELETE /dms/{id} is a hide
   * for a 1:1 and a leave for a group, and duplicating that branch here would
   * be a second place to get it wrong. Locally, both mean "drop it from the
   * list" — the row is removed optimistically so the sidebar reacts at once.
   *
   * If the server refuses, the row comes back: the DmChannel and its
   * index are kept from just before the removal and it is re-inserted at that
   * index, so the list's recency order is unchanged. The failure toast still
   * fires so the user knows why.
   */
  sc.closeOrLeaveDm = function closeOrLeaveDm(channelId: number): void {
    const channels = dmStore.getState().channels;
    const index = channels.findIndex((c) => c.channelId === channelId);
    const removed = channels[index];
    // A closed 1:1 keeps its live call through a network blip; a group leave
    // does not (the server removes the leaver from the call).
    if (removed !== undefined && !removed.isGroup) keepDmForCall(channelId);
    closeDmLocally(channelId, sc.fallBackFromDm);
    void sc.api.closeDm(channelId).then(
      () => {
        // The leave committed: the server stops sending this room's voice
        // events, so drop the roster rather than let it go stale.
        if (removed?.isGroup === true) clearChannelVoiceUsers(channelId);
      },
      () => {
        releaseKeptDm(channelId);
        if (removed !== undefined) restoreDmChannel(removed, index);
        sc.getToast()?.show(shellText("dm.leaveFailed"), "error");
      },
    );
  };

  /** Rename a group DM (participants only; the server refuses a 1:1). */
  sc.renameGroup = function renameGroup(channelId: number): void {
    const dm = dmStore.getState().channels.find((c) => c.channelId === channelId);
    if (dm === undefined || !dm.isGroup) return;
    const prompt = createPromptModal({
      title: shellText("dm.renameGroup"),
      label: shellText("dm.renameGroupHint"),
      initialValue: dm.name,
      placeholder: shellText("dm.groupNamePlaceholder"),
      maxLength: MAX_GROUP_DM_NAME_LEN,
      hint: lineHintText(MAX_GROUP_DM_NAME_LEN),
      testId: "dm-rename-input",
      validate: (name) =>
        visibleLength(name) > MAX_GROUP_DM_NAME_LEN
          ? connectText("limits.groupNameTooLong", { max: MAX_GROUP_DM_NAME_LEN })
          : null,
      // The store is updated by the dm_channel_open the server fans out to
      // every participant, so the response is only used for the error path:
      // the server's refusal shows under the field and the typed name stays.
      onSubmit: (name) =>
        sc.api
          .renameGroupDm(channelId, collapseSpaces(name))
          .then(() => null)
          .catch((err: unknown) => errorText(err, shellText("dm.renameFailed"))),
      onClose: () => {
        sc.activePrompt = null;
      },
    });
    sc.activePrompt = prompt;
  };

  /** Show a group icon failure; null means it worked and the dm_channel_open does the rest. */
  sc.showGroupIconResult = function showGroupIconResult(error: string | null): void {
    if (error !== null) sc.getToast()?.show(error, "error");
  };

  /**
   * Pick, crop and upload a group's icon. The picker opens synchronously from
   * the menu click (WebKit refuses one opened after an await), on an input
   * that is attached to the page and removed on change or cancel; the crop and
   * upload code is imported only once a file is chosen. The store updates from
   * the dm_channel_open that follows.
   */
  sc.changeGroupIcon = function changeGroupIcon(channelId: number): void {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener(
      "change",
      () => {
        const file = input.files?.[0];
        input.remove();
        if (file === undefined) return;
        void import("../../../features/direct-messages/groupIcon").then(
          async (icon) =>
            sc.showGroupIconResult(await icon.uploadGroupIcon(sc.api, channelId, file)),
          () => sc.showGroupIconResult(shellText("dm.iconFailed")),
        );
      },
      { once: true },
    );
    input.addEventListener("cancel", () => input.remove(), { once: true });
    input.click();
  };

  sc.removeGroupIconFor = function removeGroupIconFor(channelId: number): void {
    void import("../../../features/direct-messages/groupIcon").then(
      async (icon) => sc.showGroupIconResult(await icon.removeGroupIcon(sc.api, channelId)),
      () => sc.showGroupIconResult(shellText("dm.iconFailed")),
    );
  };

  /**
   * Leave DM mode for the channel the user came from. The DM sidebar's back
   * arrow and a content view's Close/Escape both take this path.
   */
  sc.returnToChannel = function returnToChannel(): void {
    setSidebarMode("channels");
    const saved = sc.channelBeforeDm;
    sc.channelBeforeDm = null;
    if (saved !== null && channelsStore.getState().channels.has(saved)) {
      setActiveChannel(saved);
      return;
    }
    // No saved channel, or it was deleted. The former happens when DM mode
    // was entered without going through selectDmConversation (e.g.
    // SidebarDmSection's "View all messages" button, which does a bare
    // setSidebarMode). If a real
    // non-DM channel is already active, leave it alone instead of
    // silently jumping to the first text channel in Map order.
    const st = channelsStore.getState();
    const current = st.activeChannelId !== null ? st.channels.get(st.activeChannelId) : undefined;
    if (current !== undefined && current.type !== "dm") return;
    for (const ch of channelsStore.getState().channels.values()) {
      if (isTextLikeChannel(ch)) {
        setActiveChannel(ch.id);
        break;
      }
    }
  };

  /** Remember the channel on screen as the one returnToChannel goes back to. */
  sc.rememberChannel = function rememberChannel(): void {
    const st = channelsStore.getState();
    const current = st.activeChannelId !== null ? st.channels.get(st.activeChannelId) : undefined;
    if (current !== undefined && current.type !== "dm") sc.channelBeforeDm = current.id;
  };

  /** Make `channelId` the active DM; false when it is no longer in the list. */
  sc.selectDm = function selectDm(channelId: number): boolean {
    const dmChannel = dmStore.getState().channels.find((c) => c.channelId === channelId);
    if (dmChannel === undefined) return false;
    selectDmConversation(dmChannel, sc.dmDeps);
    return true;
  };

  /** The DM row menu's actions, shared by the full list and the compact preview. */
  sc.dmMenuActions = function dmMenuActions(): DmMenuActions {
    return {
      onCloseDm: (channelId) => sc.closeOrLeaveDm(channelId),
      onToggleMute: (channelId) => {
        toggleChannelMute(channelId);
        // Mute state is not in a store, so nothing re-renders on its own.
        sc.refreshDmSidebarRef?.();
      },
      onSetMute: (channelId, muted) => {
        if (muted) muteChannel(channelId);
        else unmuteChannel(channelId);
        sc.refreshDmSidebarRef?.();
      },
      onMuteFor: (channelId, durationMs) => {
        muteChannel(channelId, durationMs);
        sc.refreshDmSidebarRef?.();
      },
      onMarkRead: markChannelRead,
      onOpenProfile: (channelId) => {
        if (sc.selectDm(channelId)) sc.opts.onOpenDmProfile?.();
      },
      onCall: (channelId) => {
        if (sc.selectDm(channelId)) sc.opts.onStartCall?.();
      },
      onToggleBlock: (userId, username, block) => {
        void import("../../../features/blocks/blockActions").then(
          ({ confirmAndToggleBlock }) =>
            confirmAndToggleBlock(
              { api: sc.api, notify: (msg, type) => sc.getToast()?.show(msg, type) },
              userId,
              username,
              block,
            ),
          () =>
            sc
              .getToast()
              ?.show(shellText(block ? "members.blockFailed" : "members.unblockFailed"), "error"),
        );
      },
      onRenameGroup: (channelId) => sc.renameGroup(channelId),
      onChangeGroupIcon: (channelId) => sc.changeGroupIcon(channelId),
      onRemoveGroupIcon: (channelId) => sc.removeGroupIconFor(channelId),
    };
  };

  sc.buildDmSidebar = function buildDmSidebar(): DmSidebar {
    const serverName = authStore.getState().serverName ?? shellText("common.serverFallback");
    const activeChannelId = channelsStore.getState().activeChannelId;
    const conversations = dmConversations(activeChannelId);

    return createDmSidebar({
      conversations,
      onSelectConversation: (channelId) => {
        const dmChannel = dmStore.getState().channels.find((c) => c.channelId === channelId);
        if (dmChannel !== undefined) {
          selectDmConversation(dmChannel, sc.dmDeps);
        }
      },
      ...sc.dmMenuActions(),
      onNewDm: () => {
        sc.showMemberPicker();
      },
      onBack: sc.returnToChannel,
      serverName,
    });
  };
}
