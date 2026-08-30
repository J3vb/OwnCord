package api

import (
	"context"

	"github.com/J3vb/OwnCord/Server/service"
)

// AuthService is the consumer-owned interface behind the auth routes: every
// call auth_handler.go and totp_handler.go make below the transport layer, and
// nothing more (layout-refactor supplement, "interface beside the consumer").
// service.AuthService implements it. A handler decodes and validates the
// request, calls one method, and encodes either the result or the returned
// service.Err* value; every lockout, password compare, sentinel mapping,
// audit write and broadcast lives behind these nine methods.
//
// Nine methods stand in for the ten *db.DB methods, two db functions and two
// db sentinels the two handlers called directly at 71d867cb
// (docs/architecture/server-boundaries.md, "Auth slice").
type AuthService interface {
	// RegistrationPolicy reports whether registration is permitted right now.
	// It is the one gate that runs before the body is read: two
	// characterization rows pin a closed server's 403 ahead of any
	// credential, malformed body included.
	RegistrationPolicy(ctx context.Context) error
	// Register consumes the invite, creates the account and issues a session.
	// in is already validated (see service.RegisterInput).
	Register(ctx context.Context, in service.RegisterInput) (*service.AuthResult, error)
	// Login runs the lockout gates and the constant-time password check, then
	// issues a session or, for an enrolled account, starts a two-factor
	// challenge.
	Login(ctx context.Context, in service.LoginInput) (*service.AuthResult, error)
	// VerifyTOTP completes a challenge Login started and issues the session,
	// bound to the login request's device and IP rather than this one's.
	VerifyTOTP(ctx context.Context, partialToken, code string) (*service.AuthResult, error)
	// Logout revokes p.Session server-side and clears the custom status.
	Logout(ctx context.Context, p service.Principal) error
	// DeleteAccount confirms the password, anonymises and bans the account and
	// broadcasts member_ban. ip is only logged and audited.
	DeleteAccount(ctx context.Context, p service.Principal, password, ip string) error
	// EnableTOTP confirms the password and stages a pending secret; qrURI is
	// the enrolment payload for the authenticator app.
	EnableTOTP(ctx context.Context, p service.Principal, password string) (qrURI string, err error)
	// ConfirmTOTP verifies code against the pending secret, persists it and
	// revokes the caller's other sessions.
	ConfirmTOTP(ctx context.Context, p service.Principal, password, code string) (*service.TOTPChangeResult, error)
	// DisableTOTP confirms the password, refuses while the server requires
	// 2FA, clears the secret and revokes the caller's other sessions.
	DisableTOTP(ctx context.Context, p service.Principal, password string) (*service.TOTPChangeResult, error)
}

// The production implementation satisfies the interface it was extracted for.
var _ AuthService = (*service.AuthService)(nil)
