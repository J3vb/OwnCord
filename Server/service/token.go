package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// ErrNoOwnerAccount is Bind's refusal when no username was given and the
// server has no owner yet — the bootstrap case, distinct from "that username
// does not exist", because the operator's next step is different: create the
// owner account, not check the spelling.
var ErrNoOwnerAccount = errors.New("no owner account exists yet")

// TokenService owns API tokens: minting, listing and revoking the long-lived
// bearer credentials that live outside the session table.
//
// Two callers used to implement this twice — the admin panel's HTTP routes and
// `server token …` (the bootstrap CLI, which must work with no credential at
// all). Duplicated, the two drifted: only the CLI could revoke by label, and
// the two attributed their audit rows differently. Both differences are real
// and are preserved here as explicit parts of the contract rather than as
// accidents of which copy a change happened to land in.
type TokenService struct {
	st Store
}

// NewTokenService creates a TokenService.
func NewTokenService(st Store) *TokenService {
	return &TokenService{st: st}
}

// maxTokenLifetime is the ceiling on a mint's validity: ten years, far past
// any legitimate use. It is a policy bound, not an overflow guard — a caller
// that converts an untrusted number into a Duration has to bound the number
// first, because `time.Duration(n) * time.Hour` overflows int64 nanoseconds
// into a PAST instant before this ever sees it, minting a token born expired.
// The admin route does exactly that on its int; the CLI is bounded already by
// time.ParseDuration's own ~292-year range.
const maxTokenLifetime = 10 * 365 * 24 * time.Hour

// Bind resolves the user a new token will act as. An empty username means the
// owner account, which is the bootstrap default both callers share.
//
// A missing user is ErrNotFound; a missing owner is ErrNoOwnerAccount. They are
// separate because the operator's remedy differs, and the CLI has always said
// so — keeping one sentinel would have flattened its two messages into one.
func (s *TokenService) Bind(ctx context.Context, username string) (*db.User, error) {
	var (
		user *db.User
		err  error
	)
	if username != "" {
		user, err = s.st.GetUserByUsername(ctx, username)
	} else {
		user, err = s.st.GetOwnerUser(ctx)
	}
	if err != nil {
		return nil, fmt.Errorf("%w: failed to look up user: %w", ErrInternal, err)
	}
	if user == nil {
		if username != "" {
			return nil, fmt.Errorf("user not found%.0w", ErrNotFound)
		}
		return nil, ErrNoOwnerAccount
	}
	return user, nil
}

// ActorSelf attributes a mint's audit row to the token's own bound user
// instead of to an operator. `server token create` is the bootstrap path — it
// runs with no credential at all, so there is no operator identity to record,
// and the account the token will act as is the most informative thing
// available. It is a named value rather than a bare 0 because 0 is a real
// actor id in the audit table's vocabulary ("the system"), and a mint is not
// a system action.
const ActorSelf int64 = -1

// MintedToken is what Create hands back. Raw is shown exactly once and is not
// recoverable afterwards — nothing stores it, only its hash.
type MintedToken struct {
	ID    int64
	Raw   string
	Label string
	User  *db.User
}

// Create mints a token bound to the user Bind resolved, and writes the audit
// row attributed to actorID.
//
// actorID is who the audit row names; pass ActorSelf to attribute it to the
// bound user, which is what a caller with no authenticated operator does.
//
// lifetime <= 0 means the token never expires, which is both callers' default;
// anything longer than maxTokenLifetime is refused rather than silently
// clamped, because a caller asking for a century has a bug worth surfacing.
// A blank label is refused here rather than at each caller: the label is how a
// token is identified in `list` and in revoke-by-label, so an unlabelled token
// is one nobody can find again.
func (s *TokenService) Create(ctx context.Context, actorID int64, username, label string, lifetime time.Duration) (*MintedToken, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		return nil, fmt.Errorf("label is required%.0w", ErrBadRequest)
	}
	// A negative lifetime is refused rather than folded into "never": the
	// caller asked for a bounded credential (a computed window that went
	// negative, a typo'd "-1h") and would otherwise get a permanent one with
	// a success message (OC-0340). The admin route already refused this at
	// its edge; the rule now lives here for both callers.
	if lifetime < 0 {
		return nil, fmt.Errorf("token lifetime must not be negative (0 means never expires)%.0w", ErrBadRequest)
	}
	if lifetime > maxTokenLifetime {
		return nil, fmt.Errorf("token lifetime must not exceed %d hours%.0w",
			int64(maxTokenLifetime/time.Hour), ErrBadRequest)
	}

	user, err := s.Bind(ctx, username)
	if err != nil {
		return nil, err
	}
	if actorID == ActorSelf {
		actorID = user.ID
	}

	raw, err := auth.GenerateToken()
	if err != nil {
		return nil, fmt.Errorf("%w: failed to generate token: %w", ErrInternal, err)
	}
	var expiresAt *time.Time
	if lifetime > 0 {
		t := time.Now().Add(lifetime)
		expiresAt = &t
	}
	id, err := s.st.CreateAPIToken(ctx, user.ID, auth.HashToken(raw), label, expiresAt)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to create token: %w", ErrInternal, err)
	}

	slog.Info("api token created", "actor_id", actorID, "token_id", id, "label", label, "bound_user", user.Username)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "api_token_create", "api_token", id, label)

	return &MintedToken{ID: id, Raw: raw, Label: label, User: user}, nil
}

// List returns every API token's metadata. It never returns a raw token —
// none is stored to return.
func (s *TokenService) List(ctx context.Context) ([]db.APITokenListItem, error) {
	tokens, err := s.st.ListAPITokens(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list tokens: %w", ErrInternal, err)
	}
	return tokens, nil
}

// Revoke revokes one token by id, reporting ErrNotFound when no ACTIVE token
// carries that id — an already-revoked token is not found again, so a repeated
// revoke is not reported as a second success.
func (s *TokenService) Revoke(ctx context.Context, actorID, id int64) error {
	affected, err := s.st.RevokeAPIToken(ctx, id)
	if err != nil {
		return fmt.Errorf("%w: failed to revoke token: %w", ErrInternal, err)
	}
	if affected == 0 {
		return fmt.Errorf("no active token with that id%.0w", ErrNotFound)
	}
	slog.Warn("api token revoked", "actor_id", actorID, "token_id", id)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "api_token_revoke", "api_token", id, "")
	return nil
}

// RevokeByLabel revokes every active token carrying a label, reporting how
// many went. It is the CLI's form — an operator recovering a compromised
// credential knows the label they typed, not the id the database assigned —
// and revoking all matches is deliberate: labels are not unique, and leaving
// a duplicate active would be the one that matters.
//
// The audit row carries target id 0 because the action names a label, not a
// row; the label is in the detail.
func (s *TokenService) RevokeByLabel(ctx context.Context, actorID int64, label string) (int64, error) {
	affected, err := s.st.RevokeAPITokenByLabel(ctx, label)
	if err != nil {
		return 0, fmt.Errorf("%w: failed to revoke token: %w", ErrInternal, err)
	}
	if affected == 0 {
		return 0, fmt.Errorf("no active token matched that label%.0w", ErrNotFound)
	}
	slog.Warn("api tokens revoked by label", "actor_id", actorID, "label", label, "revoked", affected)
	db.WriteAudit(context.WithoutCancel(ctx), s.st, actorID, "api_token_revoke", "api_token", 0, label)
	return affected, nil
}
