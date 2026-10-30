package auth

import (
	"context"
	"errors"

	"github.com/J3vb/OwnCord/Server/db"
)

// tokenStore is the DB surface bearer-token resolution needs; *db.DB satisfies
// it and tests use a fake.
type tokenStore interface {
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (*db.Session, error)
	GetActiveAPIToken(ctx context.Context, tokenHash string) (*db.APIToken, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetMemberRoles(ctx context.Context, userID int64) (*db.MemberRoles, error)
}

// Sentinel outcomes let each caller reproduce its 401/403 responses. A DB
// outage is not one of these: it surfaces as a wrapped error.
var (
	ErrTokenNotFound = errors.New("auth: no matching session or api token")
	ErrTokenExpired  = errors.New("auth: session expired")
	ErrUserNotFound  = errors.New("auth: user not found")
	ErrRoleNotFound  = errors.New("auth: role not found")
)

// ResolveTokenHash resolves a hashed bearer token to its principal (user + role).
//
// A login session is matched first; an API token is tried only when no session
// row matches. The returned *db.Session is nil for an API-token principal. A DB
// error is returned wrapped (never a sentinel) so callers can tell an outage
// from a bad token, and an outage never falls through to API-token lookup. On
// ErrTokenExpired the expired session is returned so the caller can schedule
// its cleanup by hash.
func ResolveTokenHash(ctx context.Context, store tokenStore, hash string) (*db.User, *db.Role, *db.Session, error) {
	sess, err := store.GetSessionByTokenHash(ctx, hash)
	if err != nil {
		return nil, nil, nil, err // DB outage — do not fall through to API tokens
	}

	var userID int64
	switch {
	case sess != nil:
		if IsSessionExpired(sess.ExpiresAt) {
			return nil, nil, sess, ErrTokenExpired
		}
		userID = sess.UserID
	default:
		tok, err := store.GetActiveAPIToken(ctx, hash)
		if err != nil {
			return nil, nil, nil, err
		}
		if tok == nil {
			return nil, nil, nil, ErrTokenNotFound
		}
		userID = tok.UserID
	}

	user, err := store.GetUserByID(ctx, userID)
	if err != nil {
		return nil, nil, nil, err
	}
	if user == nil || user.IsSystemAccount() {
		// The hidden import account owns no session or token; a row that
		// somehow names it resolves to no principal.
		return nil, nil, nil, ErrUserNotFound
	}

	// A member holding no role returns (nil, nil); the nil check keeps a nil
	// role out of the context and every downstream permission check. The role
	// carries the top role's identity (rank, ownership) with the OR of every
	// held role's permissions, which the server-level checks read.
	held, err := store.GetMemberRoles(ctx, user.ID)
	if err != nil {
		return nil, nil, nil, err
	}
	if held == nil {
		return nil, nil, nil, ErrRoleNotFound
	}
	return user, held.Effective(), sess, nil
}
