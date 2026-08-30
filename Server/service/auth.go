package service

import "github.com/J3vb/OwnCord/Server/db"

// AuthBroadcaster is how the auth slice tells connected WebSocket clients that
// an account is gone. Satisfied by *ws.Hub, which already implements
// BroadcastMemberBan for the admin ban path that self-deletion mirrors. A nil
// broadcaster sends nothing and other clients converge on their next
// reconnect.
type AuthBroadcaster interface {
	BroadcastMemberBan(userID int64)
}

// Principal is the authenticated caller api.AuthMiddleware resolved for a
// request. Session is nil for an API-token principal.
type Principal struct {
	User    *db.User
	Session *db.Session
}

// RegisterInput is a validated registration: the transport has already
// trimmed, sanitized and format-checked Username, checked Password strength
// and trimmed InviteCode. Device and IP describe the request that will own
// the issued session.
type RegisterInput struct {
	Username   string
	Password   string
	InviteCode string
	Device     string
	IP         string
}

// LoginInput is one login attempt. Username is trimmed; Password is not —
// passwords may carry leading or trailing whitespace on purpose.
type LoginInput struct {
	Username string
	Password string
	Device   string
	IP       string
}

// AuthResult is a successful register, login or second-factor step. Either a
// session was issued (Token and User) or a two-factor challenge was started
// (PartialToken with Requires2FA) — never both.
type AuthResult struct {
	Token        string
	PartialToken string
	Requires2FA  bool
	User         *db.User
}

// TOTPChangeResult reports a committed 2FA enable or disable. Warning is
// non-empty when the state change committed but revoking the caller's other
// sessions failed: a partial success the transport must answer with 200 and
// the warning, never a 5xx, because the change is already durable.
type TOTPChangeResult struct {
	SessionsRevoked int64
	Warning         string
}
