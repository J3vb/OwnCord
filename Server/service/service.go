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
}

// New creates all domain services wired together.
func New(st Store, limiter *auth.RateLimiter) *Services {
	permChecker := permissions.NewChecker(st)
	permSvc := NewPermissionService(st, permChecker)
	return &Services{
		Messages:    NewMessageService(st, permSvc, limiter),
		Channels:    NewChannelService(st, permSvc),
		Permissions: permSvc,
		Users:       NewUserService(st),
		DMs:         NewDMService(st),
		Invites:     NewInviteService(st),
		Blocks:      NewBlockService(st),
		Moderation:  NewModerationService(st, permSvc),
		Roles:       NewRoleService(st, permSvc),
		Emoji:       NewEmojiService(st, permSvc),
		Settings:    NewSettingsService(st),
		Uploads:     NewUploadService(st, permSvc),
	}
}
