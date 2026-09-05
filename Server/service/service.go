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
	// Push stores Web Push subscriptions (B5-4); the composition root
	// installs the VAPID key and the staleness TTL on it. A pointer field
	// so Services stays comparable (admin/services_bundle_test.go compares
	// two *Services with `!=`).
	Push *PushService
}

// New creates all domain services wired together.
func New(st Store, limiter *auth.RateLimiter) *Services {
	permChecker := permissions.NewChecker(st)
	permSvc := NewPermissionService(st, permChecker)
	erasure := NewErasureService(st)
	moderation := NewModerationService(st, permSvc)
	moderation.erasure = erasure
	return &Services{
		Erasure:     erasure,
		Retention:   NewRetentionService(st),
		Messages:    NewMessageService(st, permSvc, limiter),
		Channels:    NewChannelService(st, permSvc),
		Permissions: permSvc,
		Users:       NewUserService(st),
		DMs:         NewDMService(st),
		Invites:     NewInviteService(st),
		Blocks:      NewBlockService(st),
		Moderation:  moderation,
		Roles:       NewRoleService(st, permSvc),
		Emoji:       NewEmojiService(st, permSvc),
		Settings:    NewSettingsService(st),
		Uploads:     NewUploadService(st, permSvc),
		Voice:       NewVoiceService(st),
		Tokens:      NewTokenService(st),
		Sessions:    NewSessionService(st),
		Setup:       NewSetupService(st),
		Push:        NewPushService(st),
	}
}
