// Package service is the domain service layer: validation, permission checks and
// DB operations shared by the REST and WebSocket handlers, which stay thin
// adapters over it.
package service

import (
	"context"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
	"github.com/J3vb/OwnCord/Server/telemetry"
)

// traceCall starts a span for a service entry point and returns a done func that
// records the call's duration against ServiceCallDurationSec and ends the span;
// both are no-ops in the default build. The metric label is the span name's method
// segment ("BlockService.BlockUser" -> "BlockUser").
func traceCall(ctx context.Context, pkg, name string, attrs ...telemetry.Attr) (context.Context, func()) {
	ctx, span := telemetry.GlobalTracer(pkg).Start(ctx, name, attrs...)
	start := time.Now()
	_, method, _ := strings.Cut(name, ".")
	return ctx, func() {
		telemetry.TimeSince(ctx, telemetry.NewAppMetrics().ServiceCallDurationSec, start,
			telemetry.String("method", method))
		span.End()
	}
}

// Services bundles all domain services; handlers receive it instead of raw
// *db.DB references.
type Services struct {
	Messages    *MessageService
	Channels    *ChannelService
	Permissions *PermissionService
	Users       *UserService
	DMs         *DMService
	Invites     *InviteService
	Blocks      *BlockService
	Moderation  *ModerationService
	Roles       *RoleService
	Emoji       *EmojiService
	Settings    *SettingsService
	Uploads     *UploadService
	Voice       *VoiceService
	// Stickers is the custom sticker set, gated like Emoji; nil when the store cannot
	// hold stickers.
	Stickers *StickerService
	// ChannelPrivacy is the channel-level private flag.
	ChannelPrivacy *ChannelPrivacyService
	Tokens         *TokenService
	Sessions       *SessionService
	Setup          *SetupService
	// Erasure runs account erasure for the self-service and admin routes; the
	// composition root installs upload storage and the maintenance loop resumes its
	// jobs.
	Erasure *ErasureService
	// Retention is the message-retention policy and sweep; the composition root
	// installs upload storage and the marker store.
	Retention *RetentionService
	// Auth is set by the composition root once the hub exists; the admin panel's
	// owner-only recovery issuance shares it.
	Auth *AuthService
	// Reports is the local report intake and moderator queue.
	Reports *ReportService
	// Appeals is the rate-limited appeal against a moderation action.
	Appeals *AppealService
	// Push stores Web Push subscriptions; the composition root installs the VAPID key
	// and the staleness TTL. A pointer so Services stays comparable
	// (admin/services_bundle_test.go compares two *Services with `!=`).
	Push *PushService
	// MessageRequests is the first-contact gate; Messages holds a pointer to it too
	// (SetMessageRequests), which is where the gate runs (OpenDM accumulation in
	// message_crud.go).
	MessageRequests *MessageRequestService
	// NSFW owns the per-user, per-channel acknowledgement row that the four content
	// read paths (REST, search, socket, attachments) resolve through
	// permissions.CanReadContent.
	NSFW *NSFWService
	// GIFFavorites is the per-user saved-GIF list.
	GIFFavorites *GIFFavoriteService
	// UserNotes is the private per-user profile note; nil when the Store lacks
	// UserNoteStore (a test double), and the profile routes then omit the note routes.
	UserNotes *UserNoteService
	// Privacy is the per-user DM privacy setting; nil when the Store lacks
	// PrivacyStore (a test double), and the profile routes then omit the privacy
	// routes.
	Privacy *PrivacyService
	// PushDispatch is Web Push dispatch, built only when both push.enabled and
	// push.dispatch_enabled are true. It is on Services so the metrics route can read
	// its counters; MessageService gets it through SetPushNotifier.
	PushDispatch *PushDispatcher
	// Attention is the admin attention panel's state, nil until the composition root
	// builds it over the hub's counters.
	Attention *AttentionService
	// StatusExpiry clears custom statuses at their expiry. The composition root
	// installs its notifier and runs it; ChannelService wakes it on a status with an
	// expiry.
	StatusExpiry *CustomStatusExpirer
	// PollExpiry ends polls at their expiry and tells the notifier; the composition
	// root installs the notifier and runs it. Nil when the Store does not serve polls
	// (a test double). MessageService wakes it when a poll is created.
	PollExpiry *PollExpirer
	// CallLog writes the call log rows of DM calls from voice presence. The hub
	// installs its sink; the composition root starts it.
	CallLog *CallLogService
	// Threads owns thread create, update, delete and listing; the archiver and the
	// hub share it.
	Threads *ThreadService
	// ThreadArchiver archives idle threads; the composition root installs its
	// notifier and runs it.
	ThreadArchiver *ThreadArchiver
	// Welcome greets each new member in the admin-chosen channel; nil when the Store
	// cannot insert the row (a test double). The composition root installs its
	// notifier and shares it with AuthService.
	Welcome *WelcomeService
}

// New creates all domain services wired together.
func New(st Store, limiter *auth.RateLimiter) *Services {
	permChecker := permissions.NewChecker(st)
	permSvc := NewPermissionService(st, permChecker)
	erasure := NewErasureService(st)
	moderation := NewModerationService(st, permSvc)
	moderation.erasure = erasure
	moderation.limiter = limiter
	users := NewUserService(st)
	welcome := NewWelcomeService(st)
	users.welcome = welcome
	moderation.users = users
	blocks := NewBlockService(st)
	messages := NewMessageService(st, permSvc, limiter)
	// The report-linked removal entry point needs MessageService's own authorization
	// and effect, never a second copy of DeleteMessage's checks.
	moderation.messages = messages
	// Erasure must flush any queued mention-badge increment before its own reversal,
	// or a message sent inside the worker's coalesce window is reversed without its
	// increment ever having landed.
	erasure.flushMentions = messages.FlushAllPendingMentionCounts
	messageRequests := NewMessageRequestService(st, blocks)
	messages.SetMessageRequests(messageRequests)
	uploads := NewUploadService(st, permSvc)
	messages.SetUploads(uploads)
	if bs, ok := st.(BannerFileStore); ok {
		uploads.banners = bs
	}
	channels := NewChannelService(st, permSvc)
	statusExpiry := NewCustomStatusExpirer(st)
	channels.SetExpiryWake(statusExpiry.Wake)
	var pollExpiry *PollExpirer
	if ps, ok := st.(pollExpiryStore); ok {
		pollExpiry = NewPollExpirer(ps, messages)
		messages.SetPollWake(pollExpiry.Wake)
	}
	dms := NewDMService(st, permSvc)
	voice := NewVoiceService(st)
	callLog := NewCallLogService(st, dms)
	voice.SetCallLog(callLog)
	var userNotes *UserNoteService
	if ns, ok := st.(UserNoteStore); ok {
		userNotes = NewUserNoteService(ns)
	}
	var privacy *PrivacyService
	if ps, ok := st.(PrivacyStore); ok {
		privacy = NewPrivacyService(ps)
	}
	emoji := NewEmojiService(st, permSvc)
	var stickers *StickerService
	if ss, ok := st.(StickerStore); ok {
		stickers = NewStickerService(ss, emoji)
	}
	return &Services{
		Welcome:         welcome,
		Stickers:        stickers,
		UserNotes:       userNotes,
		Privacy:         privacy,
		CallLog:         callLog,
		Erasure:         erasure,
		Retention:       NewRetentionService(st),
		Messages:        messages,
		Channels:        channels,
		StatusExpiry:    statusExpiry,
		PollExpiry:      pollExpiry,
		Threads:         NewThreadService(st, permSvc, limiter),
		ThreadArchiver:  NewThreadArchiver(st),
		Permissions:     permSvc,
		Users:           users,
		DMs:             dms,
		Invites:         NewInviteService(st),
		Blocks:          blocks,
		Moderation:      moderation,
		Roles:           NewRoleService(st, permSvc),
		Emoji:           emoji,
		Settings:        NewSettingsService(st),
		Uploads:         uploads,
		Voice:           voice,
		ChannelPrivacy:  NewChannelPrivacyService(st),
		Tokens:          NewTokenService(st),
		Sessions:        NewSessionService(st),
		Setup:           NewSetupService(st, limiter),
		Reports:         NewReportService(st, permSvc, messages, uploads, moderation, limiter),
		Appeals:         NewAppealService(st, permSvc, moderation, limiter),
		Push:            NewPushService(st),
		MessageRequests: messageRequests,
		NSFW:            NewNSFWService(st, permSvc),
		GIFFavorites:    NewGIFFavoriteService(st),
	}
}
