package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ChannelPassword is the part of a channel row that says whether it has a
// password, embedded in Channel so it appears on every channel payload. It
// holds that one fact only: the hash is read through ChannelPasswordState and
// never lives on a channel value.
type ChannelPassword struct {
	JoinLocked bool `json:"password_protected"`
}

// ChannelPasswordChange is a password write carried by ChannelUpdate. Clear
// removes the password; otherwise Hash is the bcrypt hash to store. Either
// way the channel's password_version goes up by one, so every earlier grant
// stops counting.
type ChannelPasswordChange struct {
	Hash  string
	Clear bool
}

// ChannelPasswordState reads a channel's password hash and version for the
// join check. found is false when the channel does not exist; hash is empty
// when the channel has no password. This and the grant methods below are the
// only readers of channels.password_hash.
func (d *DB) ChannelPasswordState(ctx context.Context, channelID int64) (hash string, version int64, found bool, err error) {
	row, err := d.q.GetChannelPasswordState(ctx, channelID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, false, nil
	}
	if err != nil {
		return "", 0, false, fmt.Errorf("ChannelPasswordState: %w", err)
	}
	if row.PasswordHash != nil {
		hash = *row.PasswordHash
	}
	return hash, row.PasswordVersion, true, nil
}

// HasChannelPasswordGrant reports whether userID already entered the
// channel's current password.
func (d *DB) HasChannelPasswordGrant(ctx context.Context, channelID, userID int64) (bool, error) {
	n, err := d.q.HasChannelPasswordGrant(ctx, dbgen.HasChannelPasswordGrantParams{ChannelID: channelID, UserID: userID})
	if err != nil {
		return false, fmt.Errorf("HasChannelPasswordGrant: %w", err)
	}
	return n > 0, nil
}

// GrantChannelPassword records that userID entered the password whose version
// the caller checked it against. It writes only while the channel still has
// that version, so a password changed in between leaves no grant: false means
// nothing was written.
func (d *DB) GrantChannelPassword(ctx context.Context, channelID, userID, version int64) (bool, error) {
	n, err := d.q.GrantChannelPassword(ctx, dbgen.GrantChannelPasswordParams{
		UserID: userID, ChannelID: channelID, PasswordVersion: version,
	})
	if err != nil {
		return false, fmt.Errorf("GrantChannelPassword: %w", err)
	}
	return n > 0, nil
}
