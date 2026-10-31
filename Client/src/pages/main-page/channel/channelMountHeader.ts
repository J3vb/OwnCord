/**
 * Channel mount step for a DM's chat header: its avatar, name and the live
 * updates that keep them current.
 */
import { setText } from "@lib/dom";
import type { ChannelType } from "@lib/types";
import {
  updateChatHeaderForDm,
  setChatHeaderChannelType,
  setChatHeaderThreads,
  setChatHeaderMedia,
  setChatHeaderTopic,
} from "../ChatHeader";
import { dmStore, dmDisplayName } from "@stores/dm.store";
import { membersStore } from "@stores/members.store";
import { channelsStore } from "@stores/channels.store";
import { requestsText } from "../../../i18n/requests";
import { shellText, statusLabel } from "../../../i18n/shell";
import { channelMediaEnabled, threadsEnabled } from "@lib/net/serverCapabilities";
import { buildDmHeaderAvatar, dmHeaderAvatarKey } from "./channelShared";
import type { ChannelState, ChannelApi, MountScope } from "./channelState";

export function mountDmHeader(st: ChannelState, cc: ChannelApi, ms: MountScope): void {
  // Block gating is a 1:1 rule (Discord semantics, mirrored by the server's
  // requireDMNotBlocked): a group DM is a shared room, and gating one
  // member's composer over a block with one other member would leave the
  // group reading a conversation that person cannot join.
  ms.gatedDm =
    ms.channelType === "dm"
      ? dmStore.getState().channels.find((c) => c.channelId === ms.channelId)
      : undefined;

  ms.dmRecipientId =
    ms.gatedDm !== undefined && !ms.gatedDm.isGroup ? ms.gatedDm.recipient.id : null;

  // Update header
  if (st.chatHeaderRefs !== null && ms.channelType === "dm") {
    // Presence changes re-run this; the picture only needs rebuilding when
    // what it is drawn from changed, or it would flicker on every update.
    let headerAvatar: { key: string; el: HTMLElement } | null = null;
    const refreshDmHeader = (): void => {
      const dmChannel = dmStore.getState().channels.find((c) => c.channelId === ms.channelId);
      // A group has no single presence to show, so the subtitle lists who is
      // in it instead — that is the fact a group header is asked for, and a
      // first member's status presented as the group's would be a lie.
      let subtitle = shellText("status.offline");
      if (dmChannel !== undefined && dmChannel.isGroup) {
        const names = dmChannel.participants.map((p) => (p.displayName ?? "") || p.username);
        subtitle = requestsText("dm.groupSubtitle", {
          count: String(names.length + 1),
          names: names.join(", "),
        });
      } else if (dmChannel !== undefined) {
        const member = membersStore.getState().members.get(dmChannel.recipient.id);
        subtitle = statusLabel(member?.status ?? dmChannel.recipient.status ?? "offline");
      }
      const headerName = dmChannel !== undefined ? dmDisplayName(dmChannel) : ms.channelName;
      updateChatHeaderForDm(st.chatHeaderRefs!, {
        username: headerName,
        status: subtitle,
        avatar: ((): HTMLElement | null => {
          if (dmChannel === undefined) return null;
          const key = dmHeaderAvatarKey(dmChannel, headerName);
          if (headerAvatar === null || headerAvatar.key !== key) {
            headerAvatar = { key, el: buildDmHeaderAvatar(dmChannel, headerName) };
          }
          return headerAvatar.el;
        })(),
        isGroup: dmChannel?.isGroup === true,
      });
      // Both are clickable: a 1:1 name opens the profile panel and a group
      // name renames the group.
      st.chatHeaderRefs!.nameGroupEl.style.cursor = "pointer";
    };
    refreshDmHeader();
    // Keep the subtitle live across presence and roster changes — otherwise
    // it is set once from a snapshot and never updated until the channel is
    // re-mounted, same as the topic subscription below does for text
    // channels. destroyChannel already tears these down.
    if (ms.dmRecipientId !== null) {
      st.composerGatingUnsubs.push(
        membersStore.subscribeSelector(
          (s) => s.members.get(ms.dmRecipientId!)?.status,
          refreshDmHeader,
        ),
      );
    }
    st.composerGatingUnsubs.push(
      dmStore.subscribeSelector(
        (s) => s.channels.find((c) => c.channelId === ms.channelId),
        refreshDmHeader,
      ),
    );
  } else if (st.chatHeaderRefs !== null) {
    updateChatHeaderForDm(st.chatHeaderRefs, null);
    const typeRefs = st.chatHeaderRefs;
    const typeOf = (): ChannelType | undefined =>
      channelsStore.getState().channels.get(ms.channelId)?.type ?? ms.channelType;
    const syncHeaderType = (): void => {
      setChatHeaderChannelType(typeRefs, typeOf());
      setChatHeaderThreads(typeRefs, typeOf() === "text" && threadsEnabled());
      const type = typeOf();
      setChatHeaderMedia(
        typeRefs,
        (type === "text" || type === "announcement") && channelMediaEnabled(),
      );
    };
    syncHeaderType();
    st.composerGatingUnsubs.push(
      channelsStore.subscribeSelector((s) => s.channels.get(ms.channelId)?.type, syncHeaderType),
    );
    if (st.chatHeaderName !== null) {
      setText(st.chatHeaderName, ms.channelName);
      // Keep the header name live across channel_update events (a rename),
      // same as the topic subscription right below — otherwise it is set
      // once from the mount-time snapshot and disagrees with the sidebar
      // row (which does re-render off the live store) until the channel is
      // remounted.
      const nameEl = st.chatHeaderName;
      st.composerGatingUnsubs.push(
        channelsStore.subscribeSelector(
          (s) => s.channels.get(ms.channelId)?.name ?? ms.channelName,
          (name) => setText(nameEl, name),
        ),
      );
    }
    // Show the channel topic and keep it live across channel_update events.
    const topicRefs = st.chatHeaderRefs;
    setChatHeaderTopic(
      st.chatHeaderRefs,
      channelsStore.getState().channels.get(ms.channelId)?.topic ?? "",
    );
    st.composerGatingUnsubs.push(
      channelsStore.subscribeSelector(
        (s) => s.channels.get(ms.channelId)?.topic ?? "",
        (topic) => setChatHeaderTopic(topicRefs, topic),
      ),
    );
  } else if (st.chatHeaderName !== null) {
    setText(st.chatHeaderName, ms.channelName);
  }
}
