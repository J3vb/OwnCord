package auth

import (
	"context"
	"errors"

	"github.com/J3vb/OwnCord/Server/db"
)

// tokenStore is the DB surface bearer-token resolution needs. *db.DB satisfies
// it directly; tests use a fake. Kept as a tiny interface (like db.Auditor) so
// the security-critical resolution logic is unit-testable without a real DB.
type tokenStore interface {
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (*db.Session, error)
	GetActiveAPIToken(ctx context.Context, tokenHash string) (*db.APIToken, error)
	GetUserByID(ctx context.Context, id int64) (*db.User, error)
	GetRoleByID(ctx context.Context, id int64) (*db.Role, error)
}

// Sentinel outcomes, so each caller can reproduce its existing 401/403 responses
// exactly. A DB outage is NOT one of these — it surfaces as a wrapped error.
var (
	ErrTokenNotFound = errors.New("auth: no matching session or api token")
	ErrTokenExpired  = errors.New("auth: session expired")
	ErrUserNotFound  = errors.New("auth: user not found")
	ErrRoleNotFound  = errors.New("auth: role not found")
)

// ResolveTokenHash resolves a hashed bearer token to its principal (user + role).
//
// It matches a login session FIRST — so every existing session code path is
// preserved byte-for-byte — and only falls through to an API token when no
// session row matches. The returned *db.Session is nil for an API-token
// principal (downstream consumers already guard a nil session).
//
// A DB error is returned WRAPPED (never a sentinel) so callers can distinguish
// an outage from a bad token and never fall through to API-token lookup on an
// outage. On ErrTokenExpired the matched (expired) session is returned so the
// caller can schedule its cleanup by hash, exactly as the api middleware does today.
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
	if user == nil {
		return nil, nil, nil, ErrUserNotFound
	}

	// A dangling role_id returns (nil, nil): the nil check is load-bearing so a
	// nil role never reaches the context and every downstream permission check.
	role, err := store.GetRoleByID(ctx, user.RoleID)
	if err != nil {
		return nil, nil, nil, err
	}
	if role == nil {
		return nil, nil, nil, ErrRoleNotFound
	}
	return user, role, sess, nil
}
