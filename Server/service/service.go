// Package service provides the domain service layer for OwnCord.
// Services encapsulate business logic (validation, permission checks, DB operations)
// that was previously scattered across REST and WebSocket handlers.
// Both REST and WS handlers become thin adapters that call service methods.
package service

import (
	"github.com/owncord/server/auth"
	"github.com/owncord/server/permissions"
	"github.com/owncord/server/store"
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
}

// New creates all domain services wired together.
func New(st store.Store, limiter *auth.RateLimiter) *Services {
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
	}
}
