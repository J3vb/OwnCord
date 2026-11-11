// The REST replies whose shape the client checks before it uses them. Each key
// is the name a call gives its reply (`request("ChannelCategoryList", ...)`), and
// each value is the type that call returns, so the type a caller sees is the
// type that was checked. `npm run gen:wire` reads this list and writes the shape
// of every entry into restShapes.ts.
//
// A name ending in `OrNone` is a reply the server may also answer with an empty
// 204; `NoBody` is a reply whose body nothing reads, so it is never checked.

import type {
  AdminUser,
  AuthResponse,
  ChannelCategory,
  ChannelMediaMonthsResponse,
  ChannelMediaPage,
  ChannelResponse,
  CreateDmResponse,
  DmChannelsResponse,
  DmRequestListResponse,
  EmojiResponse,
  GifFavoritesResponse,
  GifSearchResponse,
  GroupDmResponse,
  HealthResponse,
  InviteResponse,
  MemberResponse,
  MessagesAroundResponse,
  MessagesResponse,
  PartialSuccessResponse,
  PurgeResponse,
  ReactionUsersResponse,
  RegisterResponse,
  SearchResponse,
  ServerInfoResponse,
  StickerResponse,
  ThreadListResponse,
  UploadResponse,
  UserStorage,
  NicknameResult,
  PublicIdResponse,
  RecoveryCodesResponse,
  ReportActResult,
  TimeoutResult,
  TotpEnrolmentResponse,
  UserUploadsPage,
  BlockedUsersResponse,
} from "../types";
import type {
  BanMemberResponse,
  DmPrivacy,
  DmRequestDecisionResult,
  MyAppeal,
  OwnApiTokensListResponse,
  OwnModerationAction,
  OwnReportSummary,
  ModerationAppealDetail,
  ModerationAppealRow,
  ModerationQueueRow,
  ModerationReportDetail,
  RecoveryKitIssue,
  RecoveryKitStatus,
  RevokeAllSessionsResponse,
  SessionsListResponse,
  UserNote,
} from "../apiShared";

export interface RestReplyShapes {
  NoBody: void;
  HealthResponse: HealthResponse;
  ServerInfoResponse: ServerInfoResponse;
  AuthResponse: AuthResponse;
  RegisterResponse: RegisterResponse;
  MemberResponse: MemberResponse;
  UploadResponse: UploadResponse;
  PartialSuccessOrNone: PartialSuccessResponse | undefined;
  TotpEnrolment: TotpEnrolmentResponse;
  RecoveryCodes: RecoveryCodesResponse;
  RecoveryKitIssue: RecoveryKitIssue;
  RecoveryKitStatus: RecoveryKitStatus;
  UserNote: UserNote;
  DmPrivacy: DmPrivacy;
  OwnModerationActionList: OwnModerationAction[];
  PublicIdResponse: PublicIdResponse;
  OwnReportSummaryList: OwnReportSummary[];
  QueueRowList: ModerationQueueRow[];
  ModerationReportDetail: ModerationReportDetail;
  ReportActResultOrNone: ReportActResult | undefined;
  TimeoutResult: TimeoutResult;
  NicknameResult: NicknameResult;
  AppealRowList: ModerationAppealRow[];
  ModerationAppealDetail: ModerationAppealDetail;
  MyAppealList: MyAppeal[];
  SessionsListResponse: SessionsListResponse;
  OwnApiTokensListResponse: OwnApiTokensListResponse;
  RevokeAllSessionsResponse: RevokeAllSessionsResponse;
  DmChannelsResponse: DmChannelsResponse;
  CreateDmResponse: CreateDmResponse;
  GroupDmResponse: GroupDmResponse;
  GroupDmOrNone: GroupDmResponse | undefined;
  BlockedUsersResponse: BlockedUsersResponse;
  DmRequestListResponse: DmRequestListResponse;
  DmRequestDecisionResult: DmRequestDecisionResult;
  MessagesResponse: MessagesResponse;
  MessagesAroundResponse: MessagesAroundResponse;
  PurgeResponse: PurgeResponse;
  ReactionUsersResponse: ReactionUsersResponse;
  ThreadListResponse: ThreadListResponse;
  ChannelMediaPage: ChannelMediaPage;
  ChannelMediaMonthsResponse: ChannelMediaMonthsResponse;
  UserStorage: UserStorage;
  UserUploadsPage: UserUploadsPage;
  SearchResponse: SearchResponse;
  GifSearchResponse: GifSearchResponse;
  GifFavoritesResponse: GifFavoritesResponse;
  InviteResponse: InviteResponse;
  InviteResponseList: InviteResponse[];
  EmojiResponse: EmojiResponse;
  EmojiResponseList: EmojiResponse[];
  StickerResponseList: StickerResponse[];
  ChannelResponse: ChannelResponse;
  ChannelCategory: ChannelCategory;
  ChannelCategoryList: readonly ChannelCategory[];
  BanMemberResponse: BanMemberResponse;
  AdminUserList: AdminUser[];
}
