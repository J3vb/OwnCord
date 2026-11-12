package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
	"github.com/J3vb/OwnCord/Server/dbtime"
)

// API tokens are long-lived, revocable bearer credentials for headless clients
// (MCP tool, bots, CI), in their own table so the session cap and
// password/TOTP session wipes never touch them; sign-out-everywhere and account
// recovery revoke them with the sessions. Like sessions, only the SHA-256 hash is stored.

// CreateAPIToken inserts a token and returns its ID; tokenHash must be hashed, nil
// expiresAt never expires.
func (d *DB) CreateAPIToken(ctx context.Context, userID int64, tokenHash, label string, expiresAt *time.Time) (int64, error) {
	var expiresStr *string
	if expiresAt != nil {
		s := expiresAt.UTC().Format(dbtime.ISOLayout)
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

// GetActiveAPIToken returns the usable token matching tokenHash, or nil.
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

// ListAPITokens returns all tokens (unrevoked first, then newest, capped), without hashes.
func (d *DB) ListAPITokens(ctx context.Context) ([]APITokenListItem, error) {
	rows, err := d.q.ListAPITokens(ctx)
	if err != nil {
		return nil, fmt.Errorf("ListAPITokens: %w", err)
	}
	out := make([]APITokenListItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, apiTokenListItem(r.ID, r.UserID, r.Username, r.Label, r.CreatedAt, r.LastUsedAt, r.ExpiresAt, r.RevokedAt))
	}
	return out, nil
}

// ListAPITokensByUser is ListAPITokens for one account's tokens only.
func (d *DB) ListAPITokensByUser(ctx context.Context, userID int64) ([]APITokenListItem, error) {
	rows, err := d.q.ListAPITokensByUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("ListAPITokensByUser: %w", err)
	}
	out := make([]APITokenListItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, apiTokenListItem(r.ID, r.UserID, r.Username, r.Label, r.CreatedAt, r.LastUsedAt, r.ExpiresAt, r.RevokedAt))
	}
	return out, nil
}

func apiTokenListItem(id, userID int64, username, label, createdAt string, lastUsed, expiresAt, revokedAt *string) APITokenListItem {
	return APITokenListItem{
		ID:        id,
		UserID:    userID,
		Username:  username,
		Label:     label,
		CreatedAt: createdAt,
		LastUsed:  lastUsed,
		ExpiresAt: expiresAt,
		RevokedAt: revokedAt,
	}
}

// RevokeAPIToken revokes the token and returns rows affected.
func (d *DB) RevokeAPIToken(ctx context.Context, id int64) (int64, error) {
	res, err := d.q.RevokeAPIToken(ctx, id)
	if err != nil {
		return 0, fmt.Errorf("RevokeAPIToken: %w", err)
	}
	return res.RowsAffected()
}

// RevokeAPITokenByLabel marks the token(s) with the given label revoked and returns the number of
// rows affected.
func (d *DB) RevokeAPITokenByLabel(ctx context.Context, label string) (int64, error) {
	res, err := d.q.RevokeAPITokenByLabel(ctx, label)
	if err != nil {
		return 0, fmt.Errorf("RevokeAPITokenByLabel: %w", err)
	}
	return res.RowsAffected()
}

// ListUserActiveAPITokens returns the account's working tokens, newest first, without hashes.
func (d *DB) ListUserActiveAPITokens(ctx context.Context, userID int64) ([]APITokenListItem, error) {
	rows, err := d.q.ListUserActiveAPITokens(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("ListUserActiveAPITokens: %w", err)
	}
	out := make([]APITokenListItem, 0, len(rows))
	for _, r := range rows {
		out = append(out, APITokenListItem{
			ID:        r.ID,
			UserID:    userID,
			Label:     r.Label,
			CreatedAt: r.CreatedAt,
			LastUsed:  r.LastUsedAt,
			ExpiresAt: r.ExpiresAt,
		})
	}
	return out, nil
}

// RevokeOwnAPIToken revokes the token only if it belongs to userID and is live; rows affected.
func (d *DB) RevokeOwnAPIToken(ctx context.Context, userID, id int64) (int64, error) {
	res, err := d.q.RevokeOwnAPIToken(ctx, dbgen.RevokeOwnAPITokenParams{ID: id, UserID: userID})
	if err != nil {
		return 0, fmt.Errorf("RevokeOwnAPIToken: %w", err)
	}
	return res.RowsAffected()
}

// RevokeUserAPITokens revokes every live token of the account and returns how many were revoked.
func (d *DB) RevokeUserAPITokens(ctx context.Context, userID int64) (int64, error) {
	res, err := d.q.RevokeUserAPITokens(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("RevokeUserAPITokens: %w", err)
	}
	return res.RowsAffected()
}

// TouchAPIToken updates last_used_at; best-effort, run off the hot auth path.
func (d *DB) TouchAPIToken(ctx context.Context, tokenHash string) error {
	if err := d.q.TouchAPIToken(ctx, tokenHash); err != nil {
		return fmt.Errorf("TouchAPIToken: %w", err)
	}
	return nil
}

// GetOwnerUser returns the highest-position user (default identity for a CLI token), or nil.
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
