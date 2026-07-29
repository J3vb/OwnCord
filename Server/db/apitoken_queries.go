package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/owncord/server/db/dbgen"
)

// ─── API Token Operations ───────────────────────────────────────────────────
//
// API tokens are long-lived, revocable bearer credentials for headless clients
// (the MCP introspection tool, bots, CI). They live in their own table so the
// per-user session cap, bulk logout, and password/TOTP session wipes never
// touch them. Like sessions, only the SHA-256 hash is stored.

// CreateAPIToken inserts a new API token and returns its ID. tokenHash must
// already be hashed (never store the raw token). Pass expiresAt = nil for a
// token that never expires.
func (d *DB) CreateAPIToken(ctx context.Context, userID int64, tokenHash, label string, expiresAt *time.Time) (int64, error) {
	var expiresStr *string
	if expiresAt != nil {
		s := expiresAt.UTC().Format("2006-01-02T15:04:05Z")
		expiresStr = &s
	}
	res, err := d.q.CreateAPIToken(ctx, dbgen.CreateAPITokenParams{
		UserID:    userID,
		TokenHash: tokenHash,
		Label:     label,
		ExpiresAt: expiresStr,
	})
	if err != nil {
		return 0, fmt.Errorf("CreateAPIToken: %w", err)
	}
	return res.LastInsertId()
}

// GetActiveAPIToken returns the non-revoked, non-expired token matching
// tokenHash, or nil if none matches (unknown, revoked, or expired). The query
// itself filters revoked/expired rows, so a returned token is always usable.
func (d *DB) GetActiveAPIToken(ctx context.Context, tokenHash string) (*APIToken, error) {
	t, err := d.q.GetActiveAPIToken(ctx, tokenHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetActiveAPIToken: %w", err)
	}
	return apiTokenFromGen(t), nil
}

// ListAPITokens returns all API tokens (newest first, capped), without hashes.
func (d *DB) ListAPITokens(ctx context.Context) ([]APITokenListItem, error) {
	rows, err := d.q.ListAPITokens(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListAPITokens: %w", err)
	}
	out := make([]APITokenListItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, APITokenListItem{
			ID:        r.ID,
			UserID:    r.UserID,
			Username:  r.Username,
			Label:     r.Label,
			CreatedAt: r.CreatedAt,
			LastUsed:  r.LastUsedAt,
			ExpiresAt: r.ExpiresAt,
			RevokedAt: r.RevokedAt,
		})
	}
	return out, nil
}

// RevokeAPIToken marks the token with the given ID revoked and returns the
// number of rows affected (0 if unknown or already revoked).
func (d *DB) RevokeAPIToken(ctx context.Context, id int64) (int64, error) {
	res, err := d.q.RevokeAPIToken(ctx, id)
	if err != nil {
		return 0, fmt.Errorf("RevokeAPIToken: %w", err)
	}
	return res.RowsAffected()
}

// RevokeAPITokenByLabel marks the token(s) with the given label revoked and
// returns the number of rows affected.
func (d *DB) RevokeAPITokenByLabel(ctx context.Context, label string) (int64, error) {
	res, err := d.q.RevokeAPITokenByLabel(ctx, label)
	if err != nil {
		return 0, fmt.Errorf("RevokeAPITokenByLabel: %w", err)
	}
	return res.RowsAffected()
}

// TouchAPIToken updates last_used_at for the token with the given hash.
// Best-effort: callers run this off the hot auth path.
func (d *DB) TouchAPIToken(ctx context.Context, tokenHash string) error {
	if err := d.q.TouchAPIToken(ctx, tokenHash); err != nil {
		return fmt.Errorf("TouchAPIToken: %w", err)
	}
	return nil
}

// GetOwnerUser returns the highest-privilege user (the role with the greatest
// position) — the default identity for a CLI-minted API token. Returns nil when
// there are no users yet.
func (d *DB) GetOwnerUser(ctx context.Context) (*User, error) {
	u, err := d.q.GetOwnerUser(ctx)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetOwnerUser: %w", err)
	}
	return userFromGen(u), nil
}
