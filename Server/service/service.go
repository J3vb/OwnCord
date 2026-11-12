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

// traceCall starts a span for a service entry point and returns a done func that records the duration against
// ServiceCallDurationSec and ends the span; both are no-ops in the default build. The metric label is the
// span name's method segment.
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

// Services bundles all domain services; handlers receive it instead of raw *db.DB references.
type Services struct {
	Messages       *MessageService
	Channels       *ChannelService
	Permissions    *PermissionService
	Users          *UserService
	DMs            *DMService
	Invites        *InviteService
	Blocks         *BlockService
	Moderation     *ModerationService
	Roles          *RoleService
	Emoji          *EmojiService
	Settings       *SettingsService
	Uploads        *UploadService
	Voice          *VoiceService
	Stickers       *StickerService
	ChannelPrivacy *ChannelPrivacyService
	Tokens         *TokenService
	Sessions       *SessionService
	Setup          *SetupService
	// Erasure runs account erasure for the self-service and admin routes; the composition root installs upload
	// storage.
	Erasure *ErasureService
	// Retention is the message-retention policy and sweep; the composition root installs upload storage and the
	// marker store.
	Retention *RetentionService
	// Auth is set by the composition root once the hub exists; shared with the admin panel's owner-only recovery
	// issuance.
	Auth    *AuthService
	Reports *ReportService
	Appeals *AppealService
	// Push stores Web Push subscriptions. A pointer so Services stays comparable
	// (admin/services_bundle_test.go compares with `!=`).
	Push            *PushService
	MessageRequests *MessageRequestService
	// NSFW owns the per-user, per-channel acknowledgement row that every content read path resolves through
	// permissions.CanReadContent.
	NSFW         *NSFWService
	GIFFavorites *GIFFavoriteService
	UserNotes    *UserNoteService
	Privacy      *PrivacyService
	// PushDispatch is Web Push dispatch, built only when push.enabled and push.dispatch_enabled are both true;
	// on Services so the metrics route can read its counters.
	PushDispatch *PushDispatcher
	Attention    *AttentionService
	StatusExpiry *CustomStatusExpirer
	// PollExpiry ends polls at their expiry; nil when the Store does not serve polls (a test double).
	// MessageService wakes it when a poll is created.
	PollExpiry     *PollExpirer
	CallLog        *CallLogService
	Threads        *ThreadService
	ThreadArchiver *ThreadArchiver
	Welcome        *WelcomeService
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
	// The report-linked removal needs MessageService's own authorization and effect, never a second copy of
	// DeleteMessage's checks.
	moderation.messages = messages
	// Erasure must flush queued mention increments before its own reversal, or a message sent inside the
	// coalesce window is reversed without its increment having landed.
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
	threads := NewThreadService(st, permSvc, limiter)
	threadArchiver := NewThreadArchiver(st)
	threads.SetArchiveWake(threadArchiver.Wake)
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
		Threads:         threads,
		ThreadArchiver:  threadArchiver,
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
