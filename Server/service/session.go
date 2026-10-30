package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// SessionService answers, for every transport, who a bearer token authenticates
// and whether that is still true. It is separate from AuthService (interactive
// flows with process-singleton state: lockouts, partial-auth and pending-TOTP
// stores, the TOTP key, the broadcaster) because resolution only reads rows, and
// because the WebSocket hub holds this one: the hub IS AuthService's
// broadcaster, so depending on it would close a construction cycle.
type SessionService struct {
	st Store
	// keys stores a session's device identity key; a slice interface so the Store
	// surface does not grow (datastore_ratchet_test.go). Nil when st lacks it.
	keys SessionKeyStore
	// batch, when set, takes TouchSession's write off the writer's hot path; nil
	// writes at once (tests, the admin panel's instance).
	batch *ConnWrites
}

// NewSessionService creates a SessionService.
func NewSessionService(st Store) *SessionService {
	keys, _ := st.(SessionKeyStore)
	return &SessionService{st: st, keys: keys}
}

// SessionKeyStore is the one write RecordSessionIdentityKey needs.
type SessionKeyStore interface {
	SetSessionIdentityKey(ctx context.Context, tokenHash, key string) error
}

// RecordSessionIdentityKey stores the device identity public key a WebSocket auth
// frame carried (voice E2EE, key per device) on its session; the caller already
// ran ValidateIdentityKey. A failure is ErrInternal-wrapped and the hub just
// logs it: the key also rides the live connection, so a missed write never
// blocks sign-in.
func (s *SessionService) RecordSessionIdentityKey(ctx context.Context, tokenHash, key string) error {
	if s.keys == nil {
		return fmt.Errorf("%w: store cannot record session identity keys", ErrInternal)
	}
	if err := s.keys.SetSessionIdentityKey(ctx, tokenHash, key); err != nil {
		return fmt.Errorf("%w: failed to record session identity key: %w", ErrInternal, err)
	}
	return nil
}

// Bearer-token resolution: the REST middleware, the admin middleware and the
// WebSocket handshake all authenticate the same tokens, and the rule they must
// share is that a DATABASE FAILURE IS NOT A BAD CREDENTIAL. A bad credential is
// terminal (the client clears its token); an outage is transient (back off and
// retry), and collapsing them logs users out during a blip. So every refusal
// below is a distinct sentinel and an unexpected error is ErrInternal.
var (
	// ErrSessionInvalid: no session row carries this token hash.
	ErrSessionInvalid = errors.New("invalid session")
	// ErrSessionExpired: the row exists but its expiry has passed.
	ErrSessionExpired = errors.New("session expired")
	// ErrPrincipalGone: the session is good but its user row is not there.
	ErrPrincipalGone = errors.New("user not found")
	// ErrPrincipalBanned: the user is banned, or ban-expired but not yet cleared.
	// Separate because it is the one refusal the user can be told the reason for.
	ErrPrincipalBanned = errors.New("user is banned")
)

// ResolveSocketPrincipal resolves a WebSocket handshake's token hash to its user,
// applying session-expiry and ban gates. Session-only: unlike REST and admin it
// does not fall back to API tokens, since a long-lived headless credential has no
// business holding an interactive socket open. The distinct sentinels let the
// transport answer a bad credential terminally and an outage (ErrInternal)
// transiently.
func (s *SessionService) ResolveSocketPrincipal(ctx context.Context, tokenHash string) (*db.User, error) {
	sess, err := s.st.GetSessionByTokenHash(ctx, tokenHash)
	if err != nil {
		return nil, fmt.Errorf("%w: session lookup failed: %w", ErrInternal, err)
	}
	if sess == nil {
		return nil, ErrSessionInvalid
	}
	if auth.IsSessionExpired(sess.ExpiresAt) {
		return nil, ErrSessionExpired
	}

	user, err := s.st.GetUserByID(ctx, sess.UserID)
	if err != nil {
		return nil, fmt.Errorf("%w: user lookup failed: %w", ErrInternal, err)
	}
	if user == nil || user.IsSystemAccount() {
		// The hidden import account owns no session; one that names it is gone.
		return nil, ErrPrincipalGone
	}
	if auth.IsEffectivelyBanned(user) {
		// Name the account in the wrap: the handshake logs this verbatim with no user in
		// scope, and a banned client in a reconnect loop is only diagnosable that way.
		return nil, fmt.Errorf("user %d: %w", user.ID, ErrPrincipalBanned)
	}
	return user, nil
}

// SessionVerdict is what the hub's sweep needs to know about one session.
type SessionVerdict int

const (
	// SessionRevoked: deleted or expired; disconnect without explanation. Deliberately
	// the zero value: a hash absent from a sweep's verdict map reads as revoked, so
	// an authenticator answering for only some sessions disconnects the rest instead
	// of silently keeping them (the fail-closed posture of the pre-seam sweep).
	SessionRevoked SessionVerdict = iota
	SessionLive
	// SessionBanned: valid session, banned user; disconnect after telling them why.
	SessionBanned
)

// SweepSessions classifies every connected client's session in one batched
// lookup (one query per sweep, not per client). A failed lookup is an error, NOT
// a map of revocations: treating it as "all revoked" would turn a transient
// database error into a server-wide disconnect, so the caller skips the tick.
func (s *SessionService) SweepSessions(ctx context.Context, tokenHashes []string) (map[string]SessionVerdict, error) {
	rows, err := s.st.GetSessionsWithBanStatusBatch(ctx, tokenHashes)
	if err != nil {
		return nil, fmt.Errorf("%w: batch session lookup failed: %w", ErrInternal, err)
	}
	verdicts := make(map[string]SessionVerdict, len(tokenHashes))
	for _, hash := range tokenHashes {
		row := rows[hash]
		switch {
		case row == nil || auth.IsSessionExpired(row.ExpiresAt):
			verdicts[hash] = SessionRevoked
		case auth.IsEffectivelyBanned(&db.User{Banned: row.Banned, BanExpires: row.BanExpires}):
			verdicts[hash] = SessionBanned
		default:
			verdicts[hash] = SessionLive
		}
	}
	return verdicts, nil
}

// TouchSession records that a login session was used and slides its expiry,
// throttled by the caller (REST middleware and hub, at most once per interval per
// session). With a batch it only queues; the write lands within TouchFlushInterval,
// which the 30-day sliding window absorbs. Revocation never waits on it: a
// revoked row is gone and the touch's WHERE never revives one.
func (s *SessionService) TouchSession(ctx context.Context, tokenHash string) error {
	if s.batch != nil {
		s.batch.queueTouch(tokenHash)
		return nil
	}
	return s.st.TouchSessions(ctx, []string{tokenHash})
}

// SetConnWrites installs the batch TouchSession queues into; call once at
// startup, before the service is shared.
func (s *SessionService) SetConnWrites(w *ConnWrites) { s.batch = w }

// TouchAPIToken records that an API token was used, called off the hot path so
// bot and CI traffic pays no latency. With a batch it queues (landing within
// TouchFlushInterval), so a busy token costs one write a minute; else it writes
// at once.
func (s *SessionService) TouchAPIToken(ctx context.Context, tokenHash string) error {
	if s.batch != nil {
		s.batch.queueAPITouch(tokenHash)
		return nil
	}
	return s.st.TouchAPIToken(ctx, tokenHash)
}

// DiscardSession deletes a session row by token hash; the REST middleware calls it
// after a 401 for an expired session so the dead row does not wait for the
// maintenance sweep. With a batch it queues (landing within StampFlushInterval).
func (s *SessionService) DiscardSession(ctx context.Context, tokenHash string) error {
	if s.batch != nil {
		s.batch.queueDiscard(tokenHash)
		return nil
	}
	return s.st.DeleteSession(ctx, tokenHash)
}

// RecordSocketConnect writes the ws_connect audit row for a completed handshake,
// on a detached context: the row must survive the connection dying right after,
// the case an operator most wants to see.
func (s *SessionService) RecordSocketConnect(ctx context.Context, userID int64, remoteAddr string) {
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "ws_connect", "user", userID,
		"WebSocket connected from "+remoteAddr)
}

// ResolveBearer resolves an HTTP bearer token hash to its principal: a login
// session first, then an API token. It passes auth.ResolveTokenHash's sentinels
// (ErrTokenExpired, ErrUserNotFound, ErrRoleNotFound, ErrTokenNotFound) through
// unchanged, since both HTTP perimeters branch on that vocabulary; anything else
// is a wrapped database error answered 503, not 401. Session is nil for an
// API-token principal; consumers must guard it.
func (s *SessionService) ResolveBearer(ctx context.Context, tokenHash string) (*db.User, *db.Role, *db.Session, error) {
	return auth.ResolveTokenHash(ctx, s.st, tokenHash)
}
