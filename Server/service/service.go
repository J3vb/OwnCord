// Package service provides the domain service layer for OwnCord.
// Services encapsulate business logic (validation, permission checks, DB operations)
// that was previously scattered across REST and WebSocket handlers.
// Both REST and WS handlers become thin adapters that call service methods.
package service

import (
	"github.com/owncord/server/auth"
	"github.com/owncord/server/db"
	"github.com/owncord/server/permissions"
)

// Services bundles all domain services for dependency injection.
// Handlers receive this struct instead of raw *db.DB references.
type Services struct {
	Messages    *MessageService
	Channels    *ChannelService
	Permissions *PermissionService
}

// New creates all domain services wired together.
func New(database *db.DB, limiter *auth.RateLimiter) *Services {
	permChecker := permissions.NewChecker(database)
	permSvc := NewPermissionService(database, permChecker)
	return &Services{
		Messages:    NewMessageService(database, permSvc, limiter),
		Channels:    NewChannelService(database, permSvc),
		Permissions: permSvc,
	}
}
