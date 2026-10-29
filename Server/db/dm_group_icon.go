package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// Group DM icon. The icon is an unlinked attachment that
// channels.dm_icon names. It is served to the group's members while it is the
// live icon, and is reclaimed by the orphan sweep once replaced or cleared.

// fileURLPrefix is where an attachment is served from.
const fileURLPrefix = "/api/v1/files/"

// GroupIconURL is the URL a group icon is served from, or "" for no icon.
func GroupIconURL(iconID string) string {
	if iconID == "" {
		return ""
	}
	return fileURLPrefix + iconID
}

// BannerURL is the URL a profile banner image is served from, nil for none.
// It is the same /api/v1/files/<id> shape as an avatar upload.
func BannerURL(bannerID *string) *string {
	if bannerID == nil || *bannerID == "" {
		return nil
	}
	u := fileURLPrefix + *bannerID
	return &u
}

// GetGroupDMMeta returns the owner (0 for none) and the icon attachment id
// ("" for none) of a group DM. Both are zero values when the channel is not a
// group.
func (d *DB) GetGroupDMMeta(ctx context.Context, channelID int64) (ownerID int64, iconID string, err error) {
	row, err := d.q.GetGroupDMMeta(ctx, channelID)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, "", nil
	}
	if err != nil {
		return 0, "", fmt.Errorf("GetGroupDMMeta: %w", err)
	}
	return row.OwnerID, row.IconID, nil
}

// IsGroupDMIconForUser reports whether fileID is the live icon of a group DM
// userID is a member of. A non-member, a former member and an icon that has
// been replaced or cleared all answer false.
func (d *DB) IsGroupDMIconForUser(ctx context.Context, fileID string, userID int64) (bool, error) {
	ok, err := d.q.IsGroupDMIconForUser(ctx, dbgen.IsGroupDMIconForUserParams{DmIcon: &fileID, UserID: userID})
	if err != nil {
		return false, fmt.Errorf("IsGroupDMIconForUser: %w", err)
	}
	return ok != 0, nil
}

// SetGroupDMIcon sets (iconID non-nil) or clears (nil) a group DM's icon on
// behalf of actorID, who must be a member (ErrNotFound otherwise), and writes
// one group_icon row (author = actor, icon_removed = whether it cleared).
// Clearing a group that has no icon changes nothing and writes no row; the
// returned change then has no Rows. Setting always writes a row, even to the
// same attachment, because an upload is a new file. The actor's membership is
// checked inside the transaction, so a member removed between an upload and
// this write fails with ErrNotFound and nothing is written.
func (d *DB) SetGroupDMIcon(ctx context.Context, channelID, actorID int64, iconID *string, content string) (*GroupChange, error) {
	var out GroupChange
	err := d.inGroupTx(ctx, "SetGroupDMIcon", func(tx *sql.Tx, q *dbgen.Queries) error {
		if err := requireGroupMember(ctx, tx, channelID, actorID); err != nil {
			return err
		}
		var current sql.NullString
		if err := tx.QueryRowContext(ctx, `SELECT dm_icon FROM channels WHERE id = ?`, channelID).Scan(&current); err != nil {
			return fmt.Errorf("read icon: %w", err)
		}
		var err error
		out.MemberIDs, err = groupMemberIDs(ctx, tx, channelID)
		if err != nil {
			return err
		}
		if iconID == nil && !current.Valid {
			return nil
		}
		if _, err = tx.ExecContext(ctx, `UPDATE channels SET dm_icon = ? WHERE id = ?`, iconID, channelID); err != nil {
			return fmt.Errorf("set icon: %w", err)
		}
		row, err := insertGroupEventRow(ctx, q, groupEventSpec{
			channelID: channelID, authorID: actorID, kind: MessageKindGroupIcon,
			content: content, iconRemoved: iconID == nil,
		})
		if err != nil {
			return err
		}
		advanceAuthorReadState(ctx, q, actorID, channelID, row.MessageID)
		out.Rows = []GroupEventRow{*row}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}
