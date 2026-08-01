package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/owncord/server/db/dbgen"
)

// ─── DM Models ──────────────────────────────────────────────────────────────

// MaxGroupDMParticipants is the total participant ceiling for a group DM,
// creator included. Discord's is 10; matching it keeps the fan-out per message
// bounded and keeps a "group DM" from becoming an unmoderated guild.
const MaxGroupDMParticipants = 10

// DMChannelInfo holds a DM channel summary for the channel list.
type DMChannelInfo struct {
	ChannelID int64 `json:"channel_id"`
	// Recipient is the OTHER participant of a two-person DM. It is retained
	// for backward compatibility with clients that predate group DMs and is
	// only meaningful when IsGroup is false; for a group it carries the
	// lowest-id other participant so such a client still renders something.
	Recipient DMUser `json:"recipient"`
	// Recipients is every participant except the viewer. This is the field
	// group-aware clients read; for a 1:1 DM it holds exactly Recipient.
	Recipients []DMUser `json:"recipients"`
	// Name is the optional group name (channels.name). Always "" for a 1:1 DM
	// — a two-person DM is named by who is in it, not by a title.
	Name string `json:"name"`
	// IsGroup is channels.is_group: decided once when the DM is created and
	// never recomputed from the live participant count, so a group that people
	// have left stays a group (see migration 028).
	IsGroup       bool   `json:"is_group"`
	LastMessageID *int64 `json:"last_message_id"`
	LastMessage   string `json:"last_message"`
	LastMessageAt string `json:"last_message_at"`
	UnreadCount   int    `json:"unread_count"`
	// MentionCount is read_states.mention_count for this DM. It is not part of
	// the GetUserDMChannels query — buildReady fills it from the unread map so
	// a DM mention badge survives a reconnect.
	MentionCount int `json:"mention_count"`
}

// DMUser is the public-facing shape for a DM participant.
type DMUser struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
	Status   string `json:"status"`
	// DisplayName is the participant's chosen nickname, "" when unset. Clients
	// fall back to Username, exactly as they do everywhere else.
	DisplayName string `json:"display_name"`
}

// NewDMChannelInfo assembles the payload shape for one DM from its channel id,
// optional group name, group flag and full participant list (the viewer
// included), as seen by viewerID.
//
// It is the single place that answers "which of these is the recipient", so
// the REST list, the ready payload and the dm_channel_open event cannot
// disagree about a channel — a disagreement that would show up as a DM whose
// name changes depending on which event drew it.
func NewDMChannelInfo(channelID int64, name string, isGroup bool, participants []DMUser, viewerID int64) DMChannelInfo {
	others := make([]DMUser, 0, len(participants))
	for i := range participants {
		if participants[i].ID == viewerID {
			continue
		}
		others = append(others, participants[i])
	}
	info := DMChannelInfo{
		ChannelID:  channelID,
		Recipients: others,
		Name:       name,
		IsGroup:    isGroup,
	}
	if len(others) > 0 {
		info.Recipient = others[0]
	}
	return info
}

// ─── GetOrCreateDMChannel ───────────────────────────────────────────────────

// GetOrCreateDMChannel finds or creates a DM channel between two users.
// Returns the channel, whether it was newly created, and any error.
// The entire lookup+create is wrapped in a single IMMEDIATE transaction to
// prevent a TOCTOU race where two concurrent requests both see ErrNoRows and
// each create a separate DM channel for the same user pair.
func (d *DB) GetOrCreateDMChannel(ctx context.Context, user1ID, user2ID int64) (*Channel, bool, error) {
	tx, err := d.writer.BeginTx(ctx, &sql.TxOptions{
		Isolation: sql.LevelSerializable,
	})
	if err != nil {
		return nil, false, fmt.Errorf("GetOrCreateDMChannel begin tx: %w", err)
	}

	// Check for an existing DM channel inside the transaction.
	//
	// The is_group clause is what keeps group DMs out of this lookup. Without
	// it a group that happens to contain both users matches the join, and
	// "message Bob" would silently drop the message into a five-person group.
	// It is the stored flag rather than a live participant count because a
	// group people have left can have exactly two members and must still not
	// answer "the DM between these two".
	var existingID int64
	err = tx.QueryRow(
		`SELECT dp1.channel_id FROM dm_participants dp1
		 JOIN dm_participants dp2 ON dp1.channel_id = dp2.channel_id
		 JOIN channels c ON c.id = dp1.channel_id
		 WHERE dp1.user_id = ? AND dp2.user_id = ? AND c.type = 'dm' AND c.is_group = 0
		 LIMIT 1`,
		user1ID, user2ID,
	).Scan(&existingID)

	if err == nil {
		// Existing channel found — ensure the calling user has it open (re-open
		// is idempotent). Without this, a user who previously closed the DM would
		// not see it in their sidebar after the other party re-initiates.
		_, _ = tx.Exec(
			`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`,
			user1ID, existingID,
		)
		if commitErr := tx.Commit(); commitErr != nil {
			return nil, false, fmt.Errorf("GetOrCreateDMChannel commit existing: %w", commitErr)
		}
		ch, getErr := d.GetChannel(ctx, existingID)
		if getErr != nil {
			return nil, false, fmt.Errorf("GetOrCreateDMChannel fetch existing: %w", getErr)
		}
		if ch == nil {
			return nil, false, fmt.Errorf("GetOrCreateDMChannel: channel %d vanished", existingID)
		}
		return ch, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return nil, false, fmt.Errorf("GetOrCreateDMChannel lookup: %w", err)
	}

	// No existing DM — create one inside the same transaction.

	// Insert channel with type 'dm' and empty name.
	res, err := tx.Exec(
		`INSERT INTO channels (name, type) VALUES ('', 'dm')`,
	)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, fmt.Errorf("GetOrCreateDMChannel insert channel: %w", err)
	}
	channelID, err := res.LastInsertId()
	if err != nil {
		_ = tx.Rollback()
		return nil, false, fmt.Errorf("GetOrCreateDMChannel last insert id: %w", err)
	}

	// Insert both participants.
	_, err = tx.Exec(
		`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?), (?, ?)`,
		channelID, user1ID, channelID, user2ID,
	)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, fmt.Errorf("GetOrCreateDMChannel insert participants: %w", err)
	}

	// Open the DM for both users.
	_, err = tx.Exec(
		`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?), (?, ?)`,
		user1ID, channelID, user2ID, channelID,
	)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, fmt.Errorf("GetOrCreateDMChannel open dm: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, false, fmt.Errorf("GetOrCreateDMChannel commit: %w", err)
	}

	ch, err := d.GetChannel(ctx, channelID)
	if err != nil {
		return nil, false, fmt.Errorf("GetOrCreateDMChannel fetch new: %w", err)
	}
	return ch, true, nil
}

// ─── GetUserDMChannels ──────────────────────────────────────────────────────

// GetUserDMChannels returns all open DM channels for a user with the full
// participant list, last message preview, and unread count. Ordered by most
// recent activity.
//
// It is two queries, not one: dm_participants holds N users per channel, so a
// single joined query returns one row per (channel, participant) pair and the
// caller has to de-duplicate anyway. Fetching the participants for every open
// DM in one extra pass keeps the cost at O(1) queries rather than the O(n) a
// per-channel participant lookup would cost.
//
// Note: the JOIN on dm_open_state already restricts results to DM channels
// (dm_open_state only contains rows for DM channels), and the explicit
// "c.type = 'dm'" predicate provides a defensive second check.
func (d *DB) GetUserDMChannels(ctx context.Context, userID int64) ([]DMChannelInfo, error) {
	rows, err := d.q.GetUserDMChannels(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("GetUserDMChannels: %w", err)
	}

	parts, err := d.q.GetDMParticipantsForUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("GetUserDMChannels participants: %w", err)
	}
	byChannel := make(map[int64][]DMUser, len(rows))
	for i := range parts {
		if parts[i].ID == userID {
			continue
		}
		byChannel[parts[i].ChannelID] = append(byChannel[parts[i].ChannelID], DMUser{
			ID:          parts[i].ID,
			Username:    parts[i].Username,
			Avatar:      parts[i].Avatar,
			Status:      StatusForViewer(parts[i].Status, parts[i].ID, userID),
			DisplayName: parts[i].DisplayName,
		})
	}

	result := make([]DMChannelInfo, 0, len(rows))
	for i := range rows {
		recipients := byChannel[rows[i].ChannelID]
		if recipients == nil {
			recipients = []DMUser{}
		}
		info := DMChannelInfo{
			ChannelID:     rows[i].ChannelID,
			Recipients:    recipients,
			Name:          rows[i].Name,
			IsGroup:       rows[i].IsGroup != 0,
			LastMessageID: rows[i].LastMessageID,
			LastMessage:   rows[i].LastMessage,
			LastMessageAt: rows[i].LastMessageAt,
			UnreadCount:   int(rows[i].UnreadCount),
		}
		if len(recipients) > 0 {
			info.Recipient = recipients[0]
		}
		result = append(result, info)
	}
	return result, nil
}

// ─── Group DM mutation ──────────────────────────────────────────────────────

// CreateGroupDMChannel creates a new group DM channel with the given
// participants (creator included in participantIDs) and opens it for all of
// them. It always creates: unlike a 1:1 DM there is no canonical "the DM
// between these people", because the same set of people may reasonably want
// two separate groups.
//
// The whole insert runs in one transaction so a crash cannot leave a channel
// with no participants — which would be an unreachable, undeletable row.
func (d *DB) CreateGroupDMChannel(ctx context.Context, name string, participantIDs []int64) (*Channel, error) {
	if len(participantIDs) < 3 {
		return nil, fmt.Errorf("CreateGroupDMChannel: need at least 3 participants, got %d", len(participantIDs))
	}
	tx, err := d.writer.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }() //nolint:errcheck // no-op after a successful Commit

	res, err := tx.ExecContext(ctx, `INSERT INTO channels (name, type, is_group) VALUES (?, 'dm', 1)`, name)
	if err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel insert channel: %w", err)
	}
	channelID, err := res.LastInsertId()
	if err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel last insert id: %w", err)
	}

	for _, pid := range participantIDs {
		if _, err = tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO dm_participants (channel_id, user_id) VALUES (?, ?)`,
			channelID, pid,
		); err != nil {
			return nil, fmt.Errorf("CreateGroupDMChannel insert participant: %w", err)
		}
		if _, err = tx.ExecContext(ctx,
			`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`,
			pid, channelID,
		); err != nil {
			return nil, fmt.Errorf("CreateGroupDMChannel open dm: %w", err)
		}
	}

	if err = tx.Commit(); err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel commit: %w", err)
	}

	ch, err := d.GetChannel(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("CreateGroupDMChannel fetch new: %w", err)
	}
	return ch, nil
}

// LeaveGroupDM removes userID from a group DM's participant list and from
// their open list, and reports whether that emptied the channel.
//
// When the last participant leaves, the channel row is deleted: a DM channel
// with no participants is reachable by nobody and would sit in the database
// forever, and its messages/attachments cascade off the channels row. Leaving
// is therefore destructive for the last leaver only — everyone else's leave is
// just a removal.
func (d *DB) LeaveGroupDM(ctx context.Context, userID, channelID int64) (deleted bool, err error) {
	tx, err := d.writer.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return false, fmt.Errorf("LeaveGroupDM begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }() //nolint:errcheck // no-op after a successful Commit

	if _, err = tx.ExecContext(ctx,
		`DELETE FROM dm_participants WHERE channel_id = ? AND user_id = ?`, channelID, userID,
	); err != nil {
		return false, fmt.Errorf("LeaveGroupDM remove participant: %w", err)
	}
	if _, err = tx.ExecContext(ctx,
		`DELETE FROM dm_open_state WHERE channel_id = ? AND user_id = ?`, channelID, userID,
	); err != nil {
		return false, fmt.Errorf("LeaveGroupDM close dm: %w", err)
	}

	var remaining int
	if err = tx.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM dm_participants WHERE channel_id = ?`, channelID,
	).Scan(&remaining); err != nil {
		return false, fmt.Errorf("LeaveGroupDM count: %w", err)
	}
	if remaining == 0 {
		if _, err = tx.ExecContext(ctx, `DELETE FROM channels WHERE id = ?`, channelID); err != nil {
			return false, fmt.Errorf("LeaveGroupDM delete channel: %w", err)
		}
		deleted = true
	}

	if err = tx.Commit(); err != nil {
		return false, fmt.Errorf("LeaveGroupDM commit: %w", err)
	}
	return deleted, nil
}

// CountDMParticipants returns how many users are in a DM channel.
func (d *DB) CountDMParticipants(ctx context.Context, channelID int64) (int, error) {
	n, err := d.q.CountDMParticipants(ctx, channelID)
	if err != nil {
		return 0, fmt.Errorf("CountDMParticipants: %w", err)
	}
	return int(n), nil
}

// IsGroupDM reports whether a DM channel was created as a group. False for a
// non-existent channel and for anything that is not a DM, which is what every
// caller wants: "treat it as a 1:1" is the conservative answer.
func (d *DB) IsGroupDM(ctx context.Context, channelID int64) (bool, error) {
	flag, err := d.q.IsGroupDM(ctx, channelID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("IsGroupDM: %w", err)
	}
	return flag != 0, nil
}

// SetDMChannelName sets the optional group name on a DM channel. The type
// predicate lives in the SQL so a stray channel id cannot rename a guild
// channel through the DM route.
func (d *DB) SetDMChannelName(ctx context.Context, channelID int64, name string) error {
	if err := d.q.SetDMChannelName(ctx, dbgen.SetDMChannelNameParams{
		Name: name,
		ID:   channelID,
	}); err != nil {
		return fmt.Errorf("SetDMChannelName: %w", err)
	}
	return nil
}

// GetDMParticipants returns every participant of a DM channel, viewer-adjusted
// (an invisible participant reads as offline to anyone but themselves).
func (d *DB) GetDMParticipants(ctx context.Context, channelID, viewerID int64) ([]DMUser, error) {
	rows, err := d.q.GetDMParticipants(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("GetDMParticipants: %w", err)
	}
	out := make([]DMUser, 0, len(rows))
	for i := range rows {
		out = append(out, DMUser{
			ID:          rows[i].ID,
			Username:    rows[i].Username,
			Avatar:      rows[i].Avatar,
			Status:      StatusForViewer(rows[i].Status, rows[i].ID, viewerID),
			DisplayName: rows[i].DisplayName,
		})
	}
	return out, nil
}

// ─── OpenDM / CloseDM ──────────────────────────────────────────────────────

// OpenDM adds a DM channel to a user's open list (idempotent).
func (d *DB) OpenDM(ctx context.Context, userID, channelID int64) error {
	if err := d.q.OpenDM(ctx, dbgen.OpenDMParams{
		UserID:    userID,
		ChannelID: channelID,
	}); err != nil {
		return fmt.Errorf("OpenDM: %w", err)
	}
	return nil
}

// CloseDM removes a DM channel from a user's open list.
func (d *DB) CloseDM(ctx context.Context, userID, channelID int64) error {
	if err := d.q.CloseDM(ctx, dbgen.CloseDMParams{
		UserID:    userID,
		ChannelID: channelID,
	}); err != nil {
		return fmt.Errorf("CloseDM: %w", err)
	}
	return nil
}

// ─── Participant helpers ────────────────────────────────────────────────────

// IsDMParticipant checks if a user is a participant in a DM channel.
func (d *DB) IsDMParticipant(ctx context.Context, userID, channelID int64) (bool, error) {
	_, err := d.q.IsDMParticipant(ctx, dbgen.IsDMParticipantParams{
		UserID:    userID,
		ChannelID: channelID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("IsDMParticipant: %w", err)
	}
	return true, nil
}

// GetUserDMChannelIDs returns the channel IDs of all DMs the user has open.
// It reads only the dm_open_state primary key, so callers that just need the
// ID set (access computation, search scoping) skip the recipient/preview/
// unread work GetUserDMChannels pays for.
func (d *DB) GetUserDMChannelIDs(ctx context.Context, userID int64) ([]int64, error) {
	ids, err := d.q.GetUserDMChannelIDs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("GetUserDMChannelIDs: %w", err)
	}
	return ids, nil
}

// GetDMParticipantIDs returns all participant user IDs for a DM channel.
func (d *DB) GetDMParticipantIDs(ctx context.Context, channelID int64) ([]int64, error) {
	ids, err := d.q.GetDMParticipantIDs(ctx, channelID)
	if err != nil {
		return nil, fmt.Errorf("GetDMParticipantIDs: %w", err)
	}
	return ids, nil
}

// GetDMRecipient returns the other participant in a DM channel.
func (d *DB) GetDMRecipient(ctx context.Context, channelID, requestingUserID int64) (*User, error) {
	var recipientID int64
	err := d.reader.QueryRowContext(ctx,
		`SELECT user_id FROM dm_participants
		 WHERE channel_id = ? AND user_id != ?
		 LIMIT 1`,
		channelID, requestingUserID,
	).Scan(&recipientID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetDMRecipient lookup: %w", err)
	}
	return d.GetUserByID(ctx, recipientID)
}
