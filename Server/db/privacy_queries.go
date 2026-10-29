package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// UserPrivacy is one user's direct message privacy choices (migration 070).
// It is private to its owner and is never part of a member, profile
// or DM payload.
type UserPrivacy struct {
	AllowMemberDMs  bool
	MessageRequests bool
}

// DefaultUserPrivacy is what a user with no stored row has: both settings on.
func DefaultUserPrivacy() UserPrivacy {
	return UserPrivacy{AllowMemberDMs: true, MessageRequests: true}
}

// GetUserPrivacy returns the user's privacy settings, or the defaults when the
// user has never saved any.
func (d *DB) GetUserPrivacy(ctx context.Context, userID int64) (UserPrivacy, error) {
	row, err := d.q.GetUserPrivacy(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return DefaultUserPrivacy(), nil
	}
	if err != nil {
		return UserPrivacy{}, fmt.Errorf("GetUserPrivacy: %w", err)
	}
	return UserPrivacy{AllowMemberDMs: row.AllowMemberDms != 0, MessageRequests: row.MessageRequests != 0}, nil
}

// SetUserPrivacy replaces the user's whole privacy row in one statement, so
// concurrent writers leave one complete body and never a mix.
func (d *DB) SetUserPrivacy(ctx context.Context, userID int64, p UserPrivacy) error {
	err := d.q.UpsertUserPrivacy(ctx, dbgen.UpsertUserPrivacyParams{
		UserID:          userID,
		AllowMemberDms:  b2i64(p.AllowMemberDMs),
		MessageRequests: b2i64(p.MessageRequests),
	})
	if err != nil {
		return fmt.Errorf("SetUserPrivacy: %w", err)
	}
	return nil
}

// DMRefusesSender reports whether recipientID has turned off direct messages
// from members and holds no trust row for senderID. A recipient with no saved
// privacy row never refuses. Trust in any source (accepted, sent_first,
// grandfathered) keeps a conversation reachable.
func (d *DB) DMRefusesSender(ctx context.Context, recipientID, senderID int64) (bool, error) {
	n, err := d.q.DMRefusesSender(ctx, dbgen.DMRefusesSenderParams{SenderID: senderID, RecipientID: recipientID})
	if err != nil {
		return false, fmt.Errorf("DMRefusesSender: %w", err)
	}
	return n > 0, nil
}

// DMCaller is a user present in the voice call of a 1:1 DM, with that DM.
type DMCaller struct {
	ChannelID int64
	UserID    int64
}

// UntrustedDMCallers returns, for each 1:1 DM userID is in, the other
// participant when they are in that DM's voice call while userID has direct
// messages from members off and holds no trust row for them. Group DMs never
// match. It reads nothing but the stored state, so it answers "who may no
// longer stay" right after userID turned the setting off.
func (d *DB) UntrustedDMCallers(ctx context.Context, userID int64) ([]DMCaller, error) {
	rows, err := d.QueryContext(ctx, `
SELECT c.id, other.user_id
FROM user_privacy up
JOIN dm_participants me ON me.user_id = up.user_id
JOIN channels c ON c.id = me.channel_id AND c.type = 'dm' AND c.is_group = 0
JOIN dm_participants other ON other.channel_id = c.id AND other.user_id <> me.user_id
JOIN voice_states vs ON vs.channel_id = c.id AND vs.user_id = other.user_id
LEFT JOIN trusted_senders ts ON ts.recipient_id = me.user_id AND ts.sender_id = other.user_id
WHERE up.user_id = ? AND up.allow_member_dms = 0 AND ts.recipient_id IS NULL
ORDER BY c.id`, userID)
	if err != nil {
		return nil, fmt.Errorf("UntrustedDMCallers: %w", err)
	}
	defer func() { _ = rows.Close() }() //nolint:errcheck // read-only cursor
	var out []DMCaller
	for rows.Next() {
		var c DMCaller
		if err = rows.Scan(&c.ChannelID, &c.UserID); err != nil {
			return nil, fmt.Errorf("UntrustedDMCallers scan: %w", err)
		}
		out = append(out, c)
	}
	if err = rows.Err(); err != nil {
		return nil, fmt.Errorf("UntrustedDMCallers rows: %w", err)
	}
	return out, nil
}
