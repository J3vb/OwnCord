package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

// ErrNoOwnerAccount is Bind's refusal when no username was given and no owner
// exists yet (bootstrap); distinct from "that username does not exist" because the
// operator's next step differs: create the owner, not check the spelling.
var ErrNoOwnerAccount = errors.New("no owner account exists yet")

// TokenService owns API tokens: minting, listing and revoking the long-lived
// bearer credentials outside the session table. The admin panel's HTTP routes and
// `server token ...` (the bootstrap CLI, which works with no credential) share it.
// Their real differences (only the CLI revokes by label; audit rows are
// attributed differently) are explicit parts of the contract.
type TokenService struct {
	st Store
}

// NewTokenService creates a TokenService.
func NewTokenService(st Store) *TokenService {
	return &TokenService{st: st}
}

// maxTokenLifetime is the mint's validity ceiling: ten years, a policy bound, not
// an overflow guard. A caller converting an untrusted number to a Duration must
// bound the number first: `time.Duration(n) * time.Hour` overflows int64 into a
// PAST instant, minting a token born expired. The admin route does that on its
// int; the CLI is bounded by time.ParseDuration's range.
const maxTokenLifetime = 10 * 365 * 24 * time.Hour

// Bind resolves the user a new token will act as; an empty username means the
// owner (the bootstrap default). A missing user is ErrNotFound and a missing owner
// ErrNoOwnerAccount, separate because the operator's remedy differs.
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

// ActorSelf attributes a mint's audit row to the token's bound user.
// `server token create` runs with no credential, so there is no operator to
// record and the bound account is the most informative actor. A named value, not
// 0, which is the audit vocabulary's "the system"; a mint is not a system action.
const ActorSelf int64 = -1

// MintedToken is what Create returns. Raw is shown once and unrecoverable: only
// its hash is stored.
type MintedToken struct {
	ID    int64
	Raw   string
	Label string
	User  *db.User
}

// validateTokenInput trims the label and enforces the label and lifetime rules.
func validateTokenInput(label string, lifetime time.Duration) (string, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		return "", fmt.Errorf("label is required%.0w", ErrBadRequest)
	}
	// A negative lifetime is refused rather than folded into "never": the caller
	// asked for a bounded credential (a computed window gone negative, a typo'd
	// "-1h") and would get a permanent one with a success message.
	if lifetime < 0 {
		return "", fmt.Errorf("token lifetime must not be negative (0 means never expires)%.0w", ErrBadRequest)
	}
	if lifetime > maxTokenLifetime {
		return "", fmt.Errorf("token lifetime must not exceed %d hours%.0w",
			int64(maxTokenLifetime/time.Hour), ErrBadRequest)
	}

	return label, nil
}

// Create mints a token bound to the user Bind resolved and audits it to actorID;
// pass ActorSelf to attribute it to the bound user (no authenticated operator).
// lifetime <= 0 never expires; beyond maxTokenLifetime is refused, not clamped,
// since a century is a bug worth surfacing. A blank label is refused here: the
// label identifies a token in `list` and revoke-by-label, so an unlabelled one
// cannot be found again.
func (s *TokenService) Create(ctx context.Context, actorID int64, username, label string, lifetime time.Duration) (*MintedToken, error) {
	label, err := validateTokenInput(label, lifetime)
	if err != nil {
		return nil, err
	}

	user, err := s.Bind(ctx, username)
	if err != nil {
		return nil, err
	}
	return s.mint(ctx, actorID, user, label, lifetime)
}

// mint creates the token for an already-resolved user; label and lifetime are
// validated by the caller.
func (s *TokenService) mint(ctx context.Context, actorID int64, user *db.User, label string, lifetime time.Duration) (*MintedToken, error) {
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

// List returns every API token's metadata, never a raw token (none is stored).
func (s *TokenService) List(ctx context.Context) ([]db.APITokenListItem, error) {
	tokens, err := s.st.ListAPITokens(ctx)
	if err != nil {
		return nil, fmt.Errorf("%w: failed to list tokens: %w", ErrInternal, err)
	}
	return tokens, nil
}

// CreateOwn is Create for a MANAGE_TOKENS holder who is not the owner: the token
// is bound to the actor, an empty username meaning the actor (not the owner as
// for Create). The actor's own name (any case) is accepted; any other username is
// ErrForbidden and mints nothing, without saying whether that account exists.
func (s *TokenService) CreateOwn(ctx context.Context, actor *db.User, username, label string, lifetime time.Duration) (*MintedToken, error) {
	if actor == nil {
		return nil, fmt.Errorf("%w: no actor", ErrForbidden)
	}
	if username != "" && !strings.EqualFold(username, actor.Username) {
		return nil, fmt.Errorf("%w: you can only create tokens for your own account", ErrForbidden)
	}
	label, err := validateTokenInput(label, lifetime)
	if err != nil {
		return nil, err
	}
	return s.mint(ctx, actor.ID, actor, label, lifetime)
}

// ListOwn is List restricted to the tokens bound to userID.
func (s *TokenService) ListOwn(ctx context.Context, userID int64) ([]db.APITokenListItem, error) {
	all, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	own := make([]db.APITokenListItem, 0, len(all))
	for _, it := range all {
		if it.UserID == userID {
			own = append(own, it)
		}
	}
	return own, nil
}

// RevokeOwn is Revoke restricted to the actor's tokens. Someone else's token is
// ErrNotFound, same as a missing id, so a holder cannot probe token ids.
func (s *TokenService) RevokeOwn(ctx context.Context, actorID, id int64) error {
	own, err := s.ListOwn(ctx, actorID)
	if err != nil {
		return err
	}
	if !slices.ContainsFunc(own, func(it db.APITokenListItem) bool { return it.ID == id }) {
		return fmt.Errorf("no active token with that id%.0w", ErrNotFound)
	}
	return s.Revoke(ctx, actorID, id)
}

// ListFor lists the tokens the actor may see: all for the owner, else their own.
func (s *TokenService) ListFor(ctx context.Context, actorID int64, isOwner bool) ([]db.APITokenListItem, error) {
	if isOwner {
		return s.List(ctx)
	}
	return s.ListOwn(ctx, actorID)
}

// CreateFor mints on behalf of the actor: bound to whoever the owner names
// (Create), otherwise only to the actor (CreateOwn).
func (s *TokenService) CreateFor(ctx context.Context, actor *db.User, isOwner bool, username, label string, lifetime time.Duration) (*MintedToken, error) {
	if isOwner {
		if actor == nil {
			return nil, fmt.Errorf("%w: no actor", ErrForbidden)
		}
		return s.Create(ctx, actor.ID, username, label, lifetime)
	}
	return s.CreateOwn(ctx, actor, username, label, lifetime)
}

// RevokeFor revokes any token for the owner, else only the actor's own
// (otherwise ErrNotFound).
func (s *TokenService) RevokeFor(ctx context.Context, actorID, id int64, isOwner bool) error {
	if isOwner {
		return s.Revoke(ctx, actorID, id)
	}
	return s.RevokeOwn(ctx, actorID, id)
}

// Revoke revokes one token by id; ErrNotFound when no ACTIVE token has that id, so
// a repeated revoke is not a second success.
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

// RevokeByLabel revokes every active token carrying a label and reports how many.
// It is the CLI's form: an operator recovering a compromised credential knows the
// label, not the id. Revoking all matches is deliberate since labels are not
// unique and a surviving duplicate would be the one that matters. The audit row's
// target id is 0 because the action names a label, not a row.
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
