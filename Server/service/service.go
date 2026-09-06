// Package service provides the domain service layer for OwnCord.
// Services encapsulate business logic (validation, permission checks, DB operations)
// that was previously scattered across REST and WebSocket handlers.
// Both REST and WS handlers become thin adapters that call service methods.
package service

import (
	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// Services bundles all domain services for dependency injection.
// Handlers receive this struct instead of raw *db.DB references.
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
	Tokens      *TokenService
	Sessions    *SessionService
	Setup       *SetupService
	// Erasure runs account erasure for the self-service route and the admin
	// route alike (B4-9); the composition root installs the upload storage
	// on it and the maintenance loop resumes its unfinished jobs.
	Erasure *ErasureService
	// Retention is the message-retention policy and sweep (B4-11); the
	// composition root installs the upload storage and the marker store.
	Retention *RetentionService
	// Auth is set by the composition root once the hub exists; the admin
	// panel's owner-only recovery issuance (B4-6) shares it.
	Auth *AuthService
	// Reports is the local report intake and moderator queue (B5-8).
	Reports *ReportService
	// Push stores Web Push subscriptions (B5-4); the composition root
	// installs the VAPID key and the staleness TTL on it. A pointer field
	// so Services stays comparable (admin/services_bundle_test.go compares
	// two *Services with `!=`).
	Push *PushService
	// MessageRequests is B5-6's first-contact gate and trusted-sender
	// bookkeeping; Messages holds a pointer to it too
	// (MessageService.SetMessageRequests), which is where the gate actually
	// runs (service/message_crud.go's OpenDM accumulation).
	MessageRequests *MessageRequestService
	// NSFW owns the per-user, per-channel acknowledgement row (B5-7); the
	// four content read paths (REST, search, socket, attachments) resolve it
	// through permissions.CanReadContent.
	NSFW *NSFWService
	// PushDispatch is Web Push dispatch (B5-11, behind HP-5), nil unless
	// the composition root constructed it — which it does only when both
	// push.enabled and push.dispatch_enabled are true. Exists on Services
	// so the metrics route can read its counters; MessageService gets it
	// separately, through SetPushNotifier.
	PushDispatch *PushDispatcher
}

// New creates all domain services wired together.
func New(st Store, limiter *auth.RateLimiter) *Services {
	permChecker := permissions.NewChecker(st)
	permSvc := NewPermissionService(st, permChecker)
	erasure := NewErasureService(st)
	moderation := NewModerationService(st, permSvc)
	moderation.erasure = erasure
	blocks := NewBlockService(st)
	messages := NewMessageService(st, permSvc, limiter)
	// The report-linked removal entry point (ActOnReport, kind="removal")
	// needs MessageService's own authorization and effect — never a second
	// copy of DeleteMessage's checks (B5-9).
	moderation.messages = messages
	messageRequests := NewMessageRequestService(st, blocks)
	messages.SetMessageRequests(messageRequests)
	uploads := NewUploadService(st, permSvc)
	return &Services{
		Erasure:         erasure,
		Retention:       NewRetentionService(st),
		Messages:        messages,
		Channels:        NewChannelService(st, permSvc),
		Permissions:     permSvc,
		Users:           NewUserService(st),
		DMs:             NewDMService(st),
		Invites:         NewInviteService(st),
		Blocks:          blocks,
		Moderation:      moderation,
		Roles:           NewRoleService(st, permSvc),
		Emoji:           NewEmojiService(st, permSvc),
		Settings:        NewSettingsService(st),
		Uploads:         uploads,
		Voice:           NewVoiceService(st),
		Tokens:          NewTokenService(st),
		Sessions:        NewSessionService(st),
		Setup:           NewSetupService(st),
		Reports:         NewReportService(st, permSvc, messages, uploads, moderation, limiter),
		Push:            NewPushService(st),
		MessageRequests: messageRequests,
		NSFW:            NewNSFWService(st, permSvc),
	}
}
