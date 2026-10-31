package db

import (
	"context"
	"fmt"
	"strings"
)

// insertAllMentionRows writes a message's user mention rows and its role
// mention rows inside tx. An edit passes replaceRoles to drop the old role rows
// first (the user rows are replaced by the caller, which keeps a reply ping).
func insertAllMentionRows(ctx context.Context, tx mentionExecer, messageID int64, userIDs []int64, replyPingUserID int64, roleIDs []int64, replaceRoles bool) error {
	if replaceRoles {
		if _, err := tx.ExecContext(ctx, `DELETE FROM message_role_mentions WHERE message_id = ?`, messageID); err != nil {
			return fmt.Errorf("insertAllMentionRows delete roles: %w", err)
		}
	}
	if err := insertMentionRows(ctx, tx, messageID, userIDs, replyPingUserID); err != nil {
		return err
	}
	return insertRoleMentionRows(ctx, tx, messageID, roleIDs)
}

// insertRoleMentionRows writes the role mention rows for one message inside
// tx. The service has already applied the shared 20-mention cap across user
// and role tokens; the storage cap here is the same backstop insertMentionRows
// keeps for users. A role deleted since the service read it is skipped rather
// than failing the send on the foreign key.
func insertRoleMentionRows(ctx context.Context, tx mentionExecer, messageID int64, roleIDs []int64) error {
	if len(roleIDs) > maxMentionsPerMessage {
		roleIDs = roleIDs[:maxMentionsPerMessage]
	}
	for _, rid := range roleIDs {
		if _, err := tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO message_role_mentions (message_id, role_id)
			 SELECT ?, id FROM roles WHERE id = ?`,
			messageID, rid,
		); err != nil {
			return fmt.Errorf("insertRoleMentionRows: %w", err)
		}
	}
	return nil
}

// GetRoleMentionsByMessageIDs returns the mentioned role ids per message id.
// Messages that pinged no role are absent from the map.
func (d *DB) GetRoleMentionsByMessageIDs(ctx context.Context, msgIDs []int64) (map[int64][]int64, error) {
	result := make(map[int64][]int64)
	if len(msgIDs) == 0 {
		return result, nil
	}
	rows, err := d.queryCached(ctx,
		`SELECT message_id, role_id FROM message_role_mentions
		 WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY message_id, role_id`,
		idsJSON(msgIDs),
	)
	if err != nil {
		return nil, fmt.Errorf("GetRoleMentionsByMessageIDs: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var msgID, roleID int64
		if scanErr := rows.Scan(&msgID, &roleID); scanErr != nil {
			return nil, fmt.Errorf("GetRoleMentionsByMessageIDs scan: %w", scanErr)
		}
		result[msgID] = append(result[msgID], roleID)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetRoleMentionsByMessageIDs rows: %w", rows.Err())
	}
	return result, nil
}

// inPlaceholders returns the "?,?,?" list and bound args for an IN clause.
func inPlaceholders(ids []int64) (string, []any) {
	ph := make([]string, len(ids))
	args := make([]any, len(ids))
	for i, id := range ids {
		ph[i] = "?"
		args[i] = id
	}
	return strings.Join(ph, ","), args
}

// GetReachableUserIDs filters ids to the users that exist and are not banned,
// the same "is this user reachable" test an @username token passes
// (notBannedClause). Order follows ascending id; unknown ids are absent.
func (d *DB) GetReachableUserIDs(ctx context.Context, ids []int64) ([]int64, error) {
	if len(ids) == 0 {
		return []int64{}, nil
	}
	placeholders, args := inPlaceholders(ids)
	rows, err := d.reader.QueryContext(ctx,
		fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
			`SELECT id FROM users WHERE %s AND %s AND id IN (%s) ORDER BY id`, notBannedClause, notSystemClause, placeholders),
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("GetReachableUserIDs: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	out := make([]int64, 0, len(ids))
	for rows.Next() {
		var id int64
		if scanErr := rows.Scan(&id); scanErr != nil {
			return nil, fmt.Errorf("GetReachableUserIDs scan: %w", scanErr)
		}
		out = append(out, id)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("GetReachableUserIDs rows: %w", rows.Err())
	}
	return out, nil
}

// ListUserIDsByRoles returns every user holding at least one of roleIDs, each
// once, ascending. It is the one holders read a role mention costs.
func (d *DB) ListUserIDsByRoles(ctx context.Context, roleIDs []int64) ([]int64, error) {
	if len(roleIDs) == 0 {
		return []int64{}, nil
	}
	placeholders, args := inPlaceholders(roleIDs)
	rows, err := d.reader.QueryContext(ctx,
		fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
			`SELECT DISTINCT user_id FROM user_roles WHERE role_id IN (%s) ORDER BY user_id`, placeholders),
		args...,
	)
	if err != nil {
		return nil, fmt.Errorf("ListUserIDsByRoles: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	out := make([]int64, 0)
	for rows.Next() {
		var id int64
		if scanErr := rows.Scan(&id); scanErr != nil {
			return nil, fmt.Errorf("ListUserIDsByRoles scan: %w", scanErr)
		}
		out = append(out, id)
	}
	if rows.Err() != nil {
		return nil, fmt.Errorf("ListUserIDsByRoles rows: %w", rows.Err())
	}
	return out, nil
}

// attachMentions fills Mentions and MentionRoles on history rows, one batch
// read each; a message that pinged nobody carries empty lists, never nil.
func (d *DB) attachMentions(ctx context.Context, msgs []MessageAPIResponse, msgIDs []int64) error {
	users, err := d.GetMentionsByMessageIDs(ctx, msgIDs)
	if err != nil {
		return err
	}
	roles, err := d.GetRoleMentionsByMessageIDs(ctx, msgIDs)
	if err != nil {
		return err
	}
	for i := range msgs {
		msgs[i].Mentions, msgs[i].MentionRoles = []int64{}, []int64{}
		if ids, ok := users[msgs[i].ID]; ok {
			msgs[i].Mentions = ids
		}
		if ids, ok := roles[msgs[i].ID]; ok {
			msgs[i].MentionRoles = ids
		}
	}
	return nil
}
