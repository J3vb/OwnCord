package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// RetentionChange describes exactly one proposed edit. Nil Days removes a
// channel override, while zero Days explicitly retains that channel forever.
type RetentionChange struct {
	Scope     string `json:"scope"`
	ChannelID int64  `json:"channel_id,omitempty"`
	Days      *int   `json:"days"`
}

// RetentionPolicySnapshot is read within one SQLite snapshot.
type RetentionPolicySnapshot struct {
	ServerDays int                `json:"server_days"`
	Channels   []ChannelRetention `json:"channels"`
	Revision   string             `json:"revision"`
}

// RetentionEffect includes every non-DM channel, including indefinite ones.
// Protected categories are disjoint: indefinite takes precedence over pinned.
type RetentionEffect struct {
	RetentionWindow
	Cutoff              string `json:"cutoff,omitempty"`
	WouldDelete         int64  `json:"would_delete"`
	ProtectedPinned     int64  `json:"protected_pinned"`
	ProtectedIndefinite int64  `json:"protected_indefinite"`
}

type RetentionChangeEffect struct {
	Revision       string            `json:"revision"`
	Channels       []RetentionEffect `json:"channels"`
	DirectMessages int64             `json:"protected_direct_messages"`
}

func retentionPolicyTx(ctx context.Context, tx *sql.Tx) (*RetentionPolicySnapshot, error) {
	p := &RetentionPolicySnapshot{Channels: []ChannelRetention{}}
	if err := tx.QueryRowContext(ctx, `SELECT revision FROM retention_revision WHERE id = 1`).Scan(&p.Revision); err != nil {
		return nil, err
	}
	var raw string
	err := tx.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = ?`, RetentionDaysKey).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	days, _ := strconv.Atoi(strings.TrimSpace(raw))
	if days >= 0 && days <= RetentionMaxDays {
		p.ServerDays = days
	}
	rows, err := tx.QueryContext(ctx, `SELECT channel_id, days, updated_by, updated_at FROM channel_retention ORDER BY channel_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var c ChannelRetention
		if err := rows.Scan(&c.ChannelID, &c.Days, &c.UpdatedBy, &c.UpdatedAt); err != nil {
			return nil, err
		}
		p.Channels = append(p.Channels, c)
	}
	return p, rows.Err()
}

func (d *DB) RetentionPolicySnapshot(ctx context.Context) (*RetentionPolicySnapshot, error) {
	tx, err := d.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	return retentionPolicyTx(ctx, tx)
}

// PreviewRetentionChange never writes policy or messages. Its policy and
// message counts all belong to the same read transaction and observation time.
func (d *DB) PreviewRetentionChange(ctx context.Context, change RetentionChange, revision string, observed time.Time) (*RetentionChangeEffect, error) {
	tx, err := d.reader.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback() //nolint:errcheck
	p, err := retentionPolicyTx(ctx, tx)
	if err != nil {
		return nil, err
	}
	if p.Revision != revision {
		return nil, ErrConflict
	}
	if err := validateRetentionChangeTx(ctx, tx, change); err != nil {
		return nil, err
	}
	windows, err := proposedRetentionWindows(ctx, tx, p, change)
	if err != nil {
		return nil, err
	}
	out := &RetentionChangeEffect{Revision: p.Revision, Channels: []RetentionEffect{}}
	for _, w := range windows {
		effect, err := retentionEffectTx(ctx, tx, w, observed)
		if err != nil {
			return nil, err
		}
		out.Channels = append(out.Channels, effect)
	}
	err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.type = 'dm' OR c.is_group <> 0`).Scan(&out.DirectMessages)
	return out, err
}

func proposedRetentionWindows(ctx context.Context, tx *sql.Tx, p *RetentionPolicySnapshot, change RetentionChange) ([]RetentionWindow, error) {
	overrides := make(map[int64]int, len(p.Channels))
	for _, c := range p.Channels {
		overrides[c.ChannelID] = c.Days
	}
	switch {
	case change.Scope == "server":
		p.ServerDays = *change.Days
	case change.Days == nil:
		delete(overrides, change.ChannelID)
	default:
		overrides[change.ChannelID] = *change.Days
	}
	rows, err := tx.QueryContext(ctx, `SELECT id, name FROM channels WHERE type <> 'dm' AND is_group = 0 ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close() //nolint:errcheck
	var windows []RetentionWindow
	for rows.Next() {
		w := RetentionWindow{Days: p.ServerDays, Source: "server"}
		if err := rows.Scan(&w.ChannelID, &w.ChannelName); err != nil {
			return nil, err
		}
		if days, ok := overrides[w.ChannelID]; ok {
			w.Days, w.Source = days, "channel"
			if days < 0 || days > RetentionMaxDays {
				w.Days = 0 // same fail-safe as RetentionWindows
			}
		}
		windows = append(windows, w)
	}
	return windows, rows.Err()
}

func retentionEffectTx(ctx context.Context, tx *sql.Tx, w RetentionWindow, observed time.Time) (RetentionEffect, error) {
	e := RetentionEffect{RetentionWindow: w}
	if w.Days == 0 {
		err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE channel_id = ?`, w.ChannelID).Scan(&e.ProtectedIndefinite)
		return e, err
	}
	cutoff := observed.UTC().Add(-time.Duration(w.Days) * 24 * time.Hour)
	e.Cutoff = cutoff.Format(time.RFC3339)
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE `+retentionCandidates,
		w.ChannelID, cutoff.Format(sqliteTimeLayout)).Scan(&e.WouldDelete); err != nil {
		return e, err
	}
	err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM messages WHERE channel_id = ? AND pinned <> 0`, w.ChannelID).Scan(&e.ProtectedPinned)
	return e, err
}

func validateRetentionChangeTx(ctx context.Context, tx *sql.Tx, change RetentionChange) error {
	if change.Scope == "server" {
		return nil
	}
	var kind string
	var group bool
	err := tx.QueryRowContext(ctx, `SELECT type, is_group FROM channels WHERE id = ?`, change.ChannelID).Scan(&kind, &group)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if kind == "dm" || group {
		return ErrRetentionProtectedChannel
	}
	return nil
}

var ErrRetentionProtectedChannel = errors.New("retention does not apply to direct messages")

// ApplyRetentionChange checks and changes the revision on the sole writer
// connection in one transaction. Every other writer triggers a new revision,
// including legacy settings writes and deletes that cascade a channel override.
func (d *DB) ApplyRetentionChange(ctx context.Context, actorID int64, change RetentionChange, revision string) (string, error) {
	tx, err := d.writer.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback() //nolint:errcheck
	p, err := retentionPolicyTx(ctx, tx)
	if err != nil {
		return "", err
	}
	if p.Revision != revision {
		return "", ErrConflict
	}
	if err := validateRetentionChangeTx(ctx, tx, change); err != nil {
		return "", err
	}
	detail, err := writeRetentionChangeTx(ctx, tx, actorID, change, p)
	if err != nil {
		return "", err
	}
	return detail, tx.Commit()
}

func writeRetentionChangeTx(ctx context.Context, tx *sql.Tx, actorID int64, change RetentionChange, p *RetentionPolicySnapshot) (string, error) {
	if change.Scope == "server" {
		_, err := tx.ExecContext(ctx, `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, RetentionDaysKey, strconv.Itoa(*change.Days))
		return fmt.Sprintf("retention_days %d -> %d", p.ServerDays, *change.Days), err
	}
	previous := "server policy"
	for _, c := range p.Channels {
		if c.ChannelID == change.ChannelID {
			previous = fmt.Sprintf("%d days", c.Days)
		}
	}
	if change.Days == nil {
		if previous == "server policy" {
			return "", ErrNotFound
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM channel_retention WHERE channel_id = ?`, change.ChannelID)
		return fmt.Sprintf("retention %s -> server policy", previous), err
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO channel_retention (channel_id, days, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
		ON CONFLICT(channel_id) DO UPDATE SET days = excluded.days, updated_by = excluded.updated_by, updated_at = excluded.updated_at`, change.ChannelID, *change.Days, actorID)
	return fmt.Sprintf("retention %s -> %d days", previous, *change.Days), err
}
