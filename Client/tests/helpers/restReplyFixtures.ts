// One valid body for every reply registered in RestReplyShapes, so a test that
// mocks a REST call answers with what the server sends and passes the shape
// check. The type makes a newly registered reply fail to compile until its
// fixture is added here, and tests/unit/restReplyShapes.test.ts checks each one
// against the generated table.

import type { RestReplyShapes } from "../../src/lib/net/restReplies";

const user = { id: 1, username: "ann" };
const dmUser = { id: 2, username: "bob", avatar: "", status: "online" };
const message = {
  id: 10,
  channel_id: 1,
  user,
  content: "hi",
  reply_to: null,
  attachments: [],
  reactions: [],
  pinned: false,
  edited_at: null,
  deleted: false,
  timestamp: "2026-11-06T10:00:00Z",
};
const dmChannel = {
  channel_id: 5,
  recipient: dmUser,
  last_message_id: null,
  last_message: "",
  last_message_at: "",
  unread_count: 0,
};
const member = { id: 1, username: "ann", status: "online" as const };
const upload = { id: "f1", filename: "a.png", size: 3, mime: "image/png", url: "/f/f1" };
const channel = { id: 3, name: "general", type: "text" as const, category: null, position: 0 };
const category = { id: 2, name: "Voice", position: 0 };
const invite = { id: 1, code: "abc", max_uses: null, expires_at: null };
const adminUser = {
  id: 1,
  username: "ann",
  role_id: 2,
  role_name: "Member",
  status: "online" as const,
  created_at: "2026-11-06T10:00:00Z",
  banned: false,
};
const reportDetail = {
  id: "r1",
  reporter_id: 1,
  subject_id: 2,
  target_type: "message",
  reason: "spam",
  detail: "",
  state: "open",
  assignee_id: 0,
  outcome: "",
  created_at: "2026-11-06T10:00:00Z",
  evidence: [],
  notes: [],
  events: [],
  actions: [],
};
const appealRow = {
  id: "a1",
  action_id: 4,
  appellant_id: 1,
  state: "open" as const,
  assignee_id: 0,
  created_at: "2026-11-06T10:00:00Z",
  decided_at: null,
};

export const REST_REPLY_FIXTURES: { readonly [K in keyof RestReplyShapes]: RestReplyShapes[K] } = {
  NoBody: undefined,
  HealthResponse: { status: "ok", uptime: 5, online_users: 1 },
  ServerInfoResponse: { name: "Home", protocol_epoch: 1, browser_client_enabled: false },
  AuthResponse: { token: "tok", requires_2fa: false },
  RegisterResponse: { token: "tok", user },
  MemberResponse: member,
  UploadResponse: upload,
  PartialSuccessOrNone: { warning: "w", sessions_revoked: 1 },
  TotpEnrolment: { qr_uri: "otpauth://totp/x", backup_codes: ["a", "b"] },
  RecoveryCodes: { backup_codes: ["a", "b"] },
  RecoveryKitIssue: { kit_secret: "s", created_at: "2026-11-06T10:00:00Z" },
  RecoveryKitStatus: { enrolled: false, used_at: null },
  UserNote: { user_id: 2, note: "" },
  DmPrivacy: { allow_member_dms: true, message_requests: true },
  OwnModerationActionList: [],
  PublicIdResponse: { id: "p1" },
  PushVapidResponse: { public_key: "BKey", key_id: "abcd" },
  PushSubscribeResponse: { id: 7 },
  OwnReportSummaryList: [],
  QueueRowList: [],
  ModerationReportDetail: reportDetail,
  ReportActResultOrNone: { voice: "applied" },
  TimeoutResult: { id: 4, voice: "applied" },
  NicknameResult: { user_id: 2, display_name: null },
  AppealRowList: [],
  ModerationAppealDetail: {
    ...appealRow,
    body: "",
    decided_by: 0,
    decision_note: "",
    action: { id: 4, kind: "warning", actor_id: 2, reason: "", created_at: "2026-11-06T10:00:00Z" },
  },
  MyAppealList: [],
  SessionsListResponse: { sessions: [] },
  OwnApiTokensListResponse: { tokens: [] },
  RevokeAllSessionsResponse: { sessions_revoked: 1, current_session_revoked: true },
  DmChannelsResponse: { dm_channels: [dmChannel] },
  CreateDmResponse: { channel_id: 5, recipient: dmUser, created: true },
  GroupDmResponse: dmChannel,
  GroupDmOrNone: dmChannel,
  BlockedUsersResponse: { blocked_user_ids: [] },
  DmRequestListResponse: { requests: [] },
  DmRequestDecisionResult: { id: 1, state: "accepted", decided_at: null },
  MessagesResponse: { messages: [message], has_more: false },
  MessagesAroundResponse: { messages: [message], has_more_before: false, has_more_after: false },
  PurgeResponse: { channel_id: 1, ids: [], count: 0 },
  ReactionUsersResponse: { users: [] },
  ThreadListResponse: { threads: [], has_more: false, next_before: "" },
  ChannelMediaPage: { items: [], next_cursor: "" },
  ChannelMediaMonthsResponse: { months: [] },
  UserStorage: { used_bytes: 0, quota_bytes: 0 },
  UserUploadsPage: { items: [] },
  SearchResponse: { results: [] },
  GifSearchResponse: { results: [] },
  GifFavoritesResponse: { favorites: [] },
  InviteResponse: invite,
  InviteResponseList: [invite],
  EmojiResponse: { id: 1, shortcode: "wave", url: "/e/1" },
  EmojiResponseList: [],
  StickerResponseList: [],
  ChannelResponse: channel,
  ChannelCategory: category,
  ChannelCategoryList: [category],
  BanMemberResponse: {},
  AdminUserList: [adminUser],
};

/** A fresh deep copy of the valid body for `reply`, safe for a test to change. */
export function validReply<K extends keyof RestReplyShapes>(reply: K): RestReplyShapes[K] {
  return structuredClone(REST_REPLY_FIXTURES[reply]);
}
