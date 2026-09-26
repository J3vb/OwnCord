package service

import (
	"context"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// SessionService answers one question for every transport: who does this
// bearer token authenticate, and is that still true?
//
// It is deliberately separate from AuthService, which owns the interactive
// flows (login, 2FA enrolment, account deletion) and therefore holds
// process-singleton state — the rate limiter's lockouts, the partial-auth and
// pending-TOTP stores, the TOTP key, the broadcaster that tells connected
// clients an account is gone. Resolution needs none of that: it reads rows.
// Keeping them apart is what lets the WebSocket hub hold this one, which it
// could not do with AuthService — the hub IS AuthService's broadcaster, so
// depending on it would close a construction cycle.
type SessionService struct {
	st Store
}

// NewSessionService creates a SessionService.
func NewSessionService(st Store) *SessionService {
	return &SessionService{st: st}
}

// ─── Bearer-token resolution (B3-8 auth family, session sub-family) ─────────
//
// Three transports authenticate the same bearer tokens: the REST middleware,
// the admin panel's middleware, and the WebSocket handshake. Each used to walk
// the session/user/role rows itself, and the rule they all have to get right
// is the same one: a DATABASE FAILURE IS NOT A BAD CREDENTIAL.
//
// It matters because the two answers are opposite. A bad credential is
// terminal — the client clears its stored token and stops retrying. An outage
// is transient — the client must back off and try again. A transport that
// collapses the two logs its users out during a blip and makes them sign in
// again once it passes. Every refusal below is therefore a distinct sentinel,
// and an unexpected error is ErrInternal, never one of them.
var (
	// ErrSessionInvalid: no session row carries this token hash.
	ErrSessionInvalid = errors.New("invalid session")
	// ErrSessionExpired: the row exists but its expiry has passed.
	ErrSessionExpired = errors.New("session expired")
	// ErrPrincipalGone: the session is good but its user row is not there.
	ErrPrincipalGone = errors.New("user not found")
	// ErrPrincipalBanned: the user is banned, or ban-expired but not yet
	// cleared. Separate from the three above because it is the one refusal
	// the user can be told the reason for.
	ErrPrincipalBanned = errors.New("user is banned")
)

// ResolveSocketPrincipal resolves a WebSocket handshake's token hash to the
// user it authenticates, applying the session-expiry and ban gates.
//
// It is session-only: unlike the REST and admin perimeters it does not fall
// back to API tokens, because a long-lived headless credential has no business
// holding an interactive socket open.
//
// The four refusals are distinct sentinels so the transport can answer a bad
// credential terminally and an outage (ErrInternal) transiently — see the
// block comment above.
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
	if user == nil {
		return nil, ErrPrincipalGone
	}
	if auth.IsEffectivelyBanned(user) {
		// Name the account in the wrap: the handshake logs this refusal
		// verbatim with no user of its own in scope, and a banned client
		// stuck in a reconnect loop is only diagnosable if the log says
		// which account it is.
		return nil, fmt.Errorf("user %d: %w", user.ID, ErrPrincipalBanned)
	}
	return user, nil
}

// SessionVerdict is what the hub's periodic sweep needs to know about one
// connected client's session.
type SessionVerdict int

const (
	// SessionRevoked: the session was deleted or has expired. Disconnect
	// without an explanation — there is nobody authenticated to explain to.
	//
	// Deliberately the zero value: a hash absent from a sweep's verdict map
	// reads as revoked, so an authenticator that answers for only some of
	// the sessions it was asked about disconnects the rest instead of
	// silently keeping them. The pre-seam sweep kicked on a missing batch
	// row; the zero value is what preserves that fail-closed posture for
	// every implementation of the seam, not just the total one below.
	SessionRevoked SessionVerdict = iota
	// SessionLive: keep the connection.
	SessionLive
	// SessionBanned: the session is still valid but its user is banned.
	// Disconnect after telling them why.
	SessionBanned
)

// SweepSessions classifies every connected client's session in one batched
// lookup, so a periodic sweep costs one query rather than one per client.
//
// A failed lookup is an error and NOT a map of revocations: it says nothing
// about any individual session, and treating it as "all revoked" would turn a
// transient database error into a server-wide disconnect. The caller skips the
// tick instead.
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

// TouchSession records that a login session was used, throttled by the caller
// — the REST middleware only calls this once per interval per session so hot
// API traffic does not queue a write per request.
func (s *SessionService) TouchSession(ctx context.Context, tokenHash string) error {
	return s.st.TouchSession(ctx, tokenHash)
}

// TouchAPIToken records that an API token was used. The REST middleware calls
// it off the hot path so bot and CI traffic pays no latency for it.
func (s *SessionService) TouchAPIToken(ctx context.Context, tokenHash string) error {
	return s.st.TouchAPIToken(ctx, tokenHash)
}

// DiscardSession deletes a session row by token hash. The REST middleware
// calls it in the background after answering 401 to an expired session, so the
// dead row does not sit there until the maintenance sweep.
func (s *SessionService) DiscardSession(ctx context.Context, tokenHash string) error {
	return s.st.DeleteSession(ctx, tokenHash)
}

// RecordSocketConnect writes the ws_connect audit row for a completed
// handshake. Detached from the request context: the row must survive the
// connection it records dying immediately afterwards, which is exactly the
// case an operator reading the trail most wants to see.
func (s *SessionService) RecordSocketConnect(ctx context.Context, userID int64, remoteAddr string) {
	db.WriteAudit(context.WithoutCancel(ctx), s.st, userID, "ws_connect", "user", userID,
		"WebSocket connected from "+remoteAddr)
}

// ResolveBearer resolves an HTTP bearer token hash to its principal: a login
// session first, then an API token, so a headless client's token authenticates
// the same routes its owning user can reach.
//
// It passes auth.ResolveTokenHash's sentinels through unchanged
// (auth.ErrTokenExpired, ErrUserNotFound, ErrRoleNotFound, ErrTokenNotFound)
// rather than restating them: that vocabulary belongs to the auth package, and
// both HTTP perimeters already branch on exactly it. Anything else is a
// wrapped database error and both perimeters answer it 503, not 401 — the same
// rule the socket path states as ErrInternal, for the same reason.
//
// The Session is nil for an API-token principal; consumers must guard it.
func (s *SessionService) ResolveBearer(ctx context.Context, tokenHash string) (*db.User, *db.Role, *db.Session, error) {
	return auth.ResolveTokenHash(ctx, s.st, tokenHash)
}
