// Discriminated unions of every server to client and client to server message.

import type { WsEnvelope } from "./wireCommon";
import type {
  AppealStatusPayload,
  AuthErrorPayload,
  AuthOkPayload,
  ChannelActivityPayload,
  ChannelCategoriesPayload,
  ChannelCreatePayload,
  ChannelDeletePayload,
  ChannelUpdatePayload,
  ChatBulkDeletedPayload,
  ChatDeletedPayload,
  ChatEditedPayload,
  ChatForwardOkPayload,
  ChatMessagePayload,
  ChatPinnedPayload,
  ChatSendOkPayload,
  GameActivityPolicyPayload,
  MemberTimeoutsPayload,
  MentionCountPayload,
  ModActionPayload,
  ModQueuePayload,
  NsfwAckPayload,
  PollCreateOkPayload,
  PollEndOkPayload,
  PollUpdatePayload,
  PollVoteOkPayload,
  PresencePayload,
  ReactionUpdatePayload,
  ReadyPayload,
  ThreadCreatePayload,
  ThreadDeletedPayload,
  ThreadFollowPayload,
  ThreadPayload,
  ThreadUpdatePayload,
  TypingPayload,
  VoiceConfigPayload,
  VoiceDisconnectedPayload,
  VoiceLeavePayload,
  VoiceMovedPayload,
  VoiceStatePayload,
  VoiceTokenPayload,
} from "./wireServer";
import type {
  ActivityUpdatePayload,
  AuthPayload,
  ChannelFocusPayload,
  ChatDeletePayload,
  ChatEditPayload,
  ChatForwardPayload,
  ChatSendPayload,
  ForumPostCreateOkPayload,
  ForumPostCreatePayload,
  ListeningUpdatePayload,
  MarkReadPayload,
  MarkUnreadPayload,
  PollCreatePayload,
  PollEndPayload,
  PollVotePayload,
  PresenceUpdatePayload,
  ReactionAddPayload,
  ReactionRemovePayload,
  ReadStatePayload,
  TypingStartPayload,
  VoiceCameraPayload,
  VoiceDeafenPayload,
  VoiceJoinPayload,
  VoiceLeaveClientPayload,
  VoiceModDeafenPayload,
  VoiceModKickPayload,
  VoiceModMovePayload,
  VoiceModMutePayload,
  VoiceMutePayload,
  VoiceScreensharePayload,
} from "./wireClient";
import type {
  CallSignalPayload,
  CallSignalRequestPayload,
  DmChannelClosePayload,
  DmChannelOpenPayload,
  DmRequestPayload,
  EmojiUpdatePayload,
  ErrorPayload,
  MemberBanPayload,
  MemberJoinPayload,
  MemberUpdatePayload,
  PresenceBatchPayload,
  RolesUpdatePayload,
  ServerRestartPayload,
  StickerUpdatePayload,
  UploadPolicyPayload,
  UserUpdatePayload,
  VoiceE2EEAnnouncePayload,
  VoiceE2EEOfferPayload,
  VoiceWatchingPayload,
} from "./wireVoiceDm";

// -----------------------------------------------------------------------------
// Discriminated Union: Server → Client Messages
// -----------------------------------------------------------------------------

export type ServerMessage =
  | (WsEnvelope<AuthOkPayload> & { readonly type: "auth_ok" })
  | (WsEnvelope<AuthErrorPayload> & { readonly type: "auth_error" })
  | (WsEnvelope<ReadyPayload> & { readonly type: "ready" })
  | (WsEnvelope<ChatMessagePayload> & { readonly type: "chat_message" })
  | (WsEnvelope<ChatSendOkPayload> & { readonly type: "chat_send_ok" })
  | (WsEnvelope<ChatForwardOkPayload> & { readonly type: "chat_forward_ok" })
  | (WsEnvelope<ThreadPayload> & { readonly type: "thread_create_ok" })
  | (WsEnvelope<ForumPostCreateOkPayload> & { readonly type: "forum_post_create_ok" })
  | (WsEnvelope<{ readonly thread_id: number }> & { readonly type: "thread_update_ok" })
  | (WsEnvelope<ThreadPayload> & { readonly type: "thread_changed" })
  | (WsEnvelope<ThreadDeletedPayload> & { readonly type: "thread_deleted" })
  | (WsEnvelope<ThreadFollowPayload> & { readonly type: "thread_follow_ok" })
  | (WsEnvelope<ThreadFollowPayload> & { readonly type: "thread_follow_update" })
  | (WsEnvelope<ChatEditedPayload> & { readonly type: "chat_edited" })
  | (WsEnvelope<ChatDeletedPayload> & { readonly type: "chat_deleted" })
  | (WsEnvelope<ChatBulkDeletedPayload> & { readonly type: "chat_bulk_deleted" })
  | (WsEnvelope<ChatPinnedPayload> & { readonly type: "chat_pinned" })
  | (WsEnvelope<ReactionUpdatePayload> & { readonly type: "reaction_update" })
  | (WsEnvelope<PollUpdatePayload> & { readonly type: "poll_update" })
  | (WsEnvelope<PollCreateOkPayload> & { readonly type: "poll_create_ok" })
  | (WsEnvelope<PollVoteOkPayload> & { readonly type: "poll_vote_ok" })
  | (WsEnvelope<PollEndOkPayload> & { readonly type: "poll_end_ok" })
  | (WsEnvelope<TypingPayload> & { readonly type: "typing" })
  | (WsEnvelope<PresencePayload> & { readonly type: "presence" })
  | (WsEnvelope<PresenceBatchPayload> & { readonly type: "presence_batch" })
  | (WsEnvelope<ChannelCreatePayload> & { readonly type: "channel_create" })
  | (WsEnvelope<ChannelUpdatePayload> & { readonly type: "channel_update" })
  | (WsEnvelope<ChannelCategoriesPayload> & { readonly type: "channel_categories" })
  | (WsEnvelope<ChannelDeletePayload> & { readonly type: "channel_delete" })
  | (WsEnvelope<NsfwAckPayload> & { readonly type: "nsfw_ack" })
  | (WsEnvelope<VoiceStatePayload> & { readonly type: "voice_state" })
  | (WsEnvelope<VoiceLeavePayload> & { readonly type: "voice_leave" })
  | (WsEnvelope<VoiceConfigPayload> & { readonly type: "voice_config" })
  | (WsEnvelope<VoiceTokenPayload> & { readonly type: "voice_token" })
  | (WsEnvelope<VoiceMovedPayload> & { readonly type: "voice_moved" })
  | (WsEnvelope<VoiceDisconnectedPayload> & { readonly type: "voice_disconnected" })
  | (WsEnvelope<VoiceE2EEAnnouncePayload> & { readonly type: "voice_e2ee_announce" })
  | (WsEnvelope<VoiceE2EEOfferPayload> & { readonly type: "voice_e2ee_offer" })
  | (WsEnvelope<VoiceWatchingPayload> & { readonly type: "voice_watching" })
  | (WsEnvelope<MemberJoinPayload> & { readonly type: "member_join" })
  | (WsEnvelope<MemberUpdatePayload> & { readonly type: "member_update" })
  | (WsEnvelope<UserUpdatePayload> & { readonly type: "user_update" })
  | (WsEnvelope<MemberBanPayload> & { readonly type: "member_ban" })
  | (WsEnvelope<ModActionPayload> & { readonly type: "mod_action" })
  | (WsEnvelope<AppealStatusPayload> & { readonly type: "appeal_status" })
  | (WsEnvelope<MentionCountPayload> & { readonly type: "mention_count" })
  | (WsEnvelope<ReadStatePayload> & { readonly type: "read_state" })
  | (WsEnvelope<ChannelActivityPayload> & { readonly type: "channel_activity" })
  | (WsEnvelope<ModQueuePayload> & { readonly type: "mod_queue" })
  | (WsEnvelope<MemberTimeoutsPayload> & { readonly type: "member_timeouts" })
  | (WsEnvelope<RolesUpdatePayload> & { readonly type: "roles_update" })
  | (WsEnvelope<EmojiUpdatePayload> & { readonly type: "emoji_update" })
  | (WsEnvelope<StickerUpdatePayload> & { readonly type: "sticker_update" })
  | (WsEnvelope<UploadPolicyPayload> & { readonly type: "upload_policy" })
  | (WsEnvelope<GameActivityPolicyPayload> & { readonly type: "game_activity_policy" })
  | (WsEnvelope<DmChannelOpenPayload> & { readonly type: "dm_channel_open" })
  | (WsEnvelope<DmChannelClosePayload> & { readonly type: "dm_channel_close" })
  | (WsEnvelope<DmRequestPayload> & { readonly type: "dm_request" })
  | (WsEnvelope<CallSignalPayload> & { readonly type: "call_incoming" })
  | (WsEnvelope<CallSignalPayload> & { readonly type: "call_declined" })
  | (WsEnvelope<ServerRestartPayload> & { readonly type: "server_restart" })
  | (WsEnvelope<ErrorPayload> & { readonly type: "error" });

// -----------------------------------------------------------------------------
// Discriminated Union: Client → Server Messages
// -----------------------------------------------------------------------------

export type ClientMessage =
  | (WsEnvelope<AuthPayload> & { readonly type: "auth" })
  | (WsEnvelope<ChatSendPayload> & { readonly type: "chat_send" })
  | (WsEnvelope<ChatForwardPayload> & { readonly type: "chat_forward" })
  | (WsEnvelope<PollCreatePayload> & { readonly type: "poll_create" })
  | (WsEnvelope<PollVotePayload> & { readonly type: "poll_vote" })
  | (WsEnvelope<PollEndPayload> & { readonly type: "poll_end" })
  | (WsEnvelope<ThreadCreatePayload> & { readonly type: "thread_create" })
  | (WsEnvelope<ForumPostCreatePayload> & { readonly type: "forum_post_create" })
  | (WsEnvelope<ThreadUpdatePayload> & { readonly type: "thread_update" })
  | (WsEnvelope<{ readonly thread_id: number }> & { readonly type: "thread_delete" })
  | (WsEnvelope<{ readonly thread_id: number | null }> & { readonly type: "thread_focus" })
  | (WsEnvelope<{ readonly thread_id: number; readonly follow: boolean }> & {
      readonly type: "thread_follow";
    })
  | (WsEnvelope<ChatEditPayload> & { readonly type: "chat_edit" })
  | (WsEnvelope<ChatDeletePayload> & { readonly type: "chat_delete" })
  | (WsEnvelope<ReactionAddPayload> & { readonly type: "reaction_add" })
  | (WsEnvelope<ReactionRemovePayload> & { readonly type: "reaction_remove" })
  | (WsEnvelope<TypingStartPayload> & { readonly type: "typing_start" })
  | (WsEnvelope<ChannelFocusPayload> & { readonly type: "channel_focus" })
  | (WsEnvelope<MarkReadPayload> & { readonly type: "mark_read" })
  | (WsEnvelope<MarkUnreadPayload> & { readonly type: "mark_unread" })
  | (WsEnvelope<PresenceUpdatePayload> & { readonly type: "presence_update" })
  | (WsEnvelope<ActivityUpdatePayload> & { readonly type: "activity_update" })
  | (WsEnvelope<ListeningUpdatePayload> & { readonly type: "listening_update" })
  | (WsEnvelope<VoiceJoinPayload> & { readonly type: "voice_join" })
  | (WsEnvelope<VoiceLeaveClientPayload> & { readonly type: "voice_leave" })
  | (WsEnvelope<VoiceMutePayload> & { readonly type: "voice_mute" })
  | (WsEnvelope<VoiceDeafenPayload> & { readonly type: "voice_deafen" })
  | (WsEnvelope<VoiceCameraPayload> & { readonly type: "voice_camera" })
  | (WsEnvelope<VoiceScreensharePayload> & { readonly type: "voice_screenshare" })
  | (WsEnvelope<VoiceModMutePayload> & { readonly type: "voice_mod_mute" })
  | (WsEnvelope<VoiceModDeafenPayload> & { readonly type: "voice_mod_deafen" })
  | (WsEnvelope<VoiceModMovePayload> & { readonly type: "voice_mod_move" })
  | (WsEnvelope<VoiceModKickPayload> & { readonly type: "voice_mod_kick" })
  | (WsEnvelope<Record<string, never>> & { readonly type: "voice_token_refresh" })
  | (WsEnvelope<{
      public_key: string;
      signature?: string;
      /** This device's identity public key (the one that signed `signature`). */
      identity_public_key?: string;
      video_decode?: readonly string[];
    }> & {
      readonly type: "voice_e2ee_announce";
    })
  | (WsEnvelope<{ target_user_id: number; encrypted_key: string; iv: string }> & {
      readonly type: "voice_e2ee_offer";
    })
  | (WsEnvelope<{ user_ids: readonly number[] }> & { readonly type: "voice_watch" })
  | (WsEnvelope<CallSignalRequestPayload> & { readonly type: "call_ring" })
  | (WsEnvelope<CallSignalRequestPayload> & { readonly type: "call_decline" });
