package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// MaxGroupDMParticipants is the participant ceiling for a group DM, creator
// included. It bounds per-message fan-out and keeps a group DM from becoming
// an unmoderated guild.
const MaxGroupDMParticipants = 10

// DMChannelInfo holds a DM channel summary for the channel list.
type DMChannelInfo struct {
	ChannelID int64 `json:"channel_id"`
	// Recipient is the other participant of a two-person DM, kept for clients that
	// predate group DMs. It is meaningful only when IsGroup is false; for a group
	// it carries the lowest-id other participant.
	Recipient DMUser `json:"recipient"`
	// Recipients is every participant except the viewer, which group-aware clients
	// read; for a 1:1 DM it holds exactly Recipient.
	Recipients []DMUser `json:"recipients"`
	// Name is the optional group name (channels.name), always "" for a 1:1 DM.
	Name string `json:"name"`
	// IsGroup is channels.is_group, decided at creation and never recomputed from
	// the live participant count, so a group people left stays a group.
	IsGroup bool `json:"is_group"`
	// OwnerID is the group's owner (channels.dm_owner_id), a current member. Set
	// for groups only and omitted for a 1:1 DM.
	OwnerID int64 `json:"owner_id,omitempty"`
	// Icon is the group's icon as a file URL (/api/v1/files/{id}), "" when none
	// and for a 1:1 DM. Always present on the wire.
	Icon          string `json:"icon"`
	LastMessageID *int64 `json:"last_message_id"`
	LastMessage   string `json:"last_message"`
	LastMessageAt string `json:"last_message_at"`
	UnreadCount   int    `json:"unread_count"`
	// MentionCount is read_states.mention_count for this DM, carried by
	// GetUserDMChannels so GET /dms and the ready payload report the same badge.
	MentionCount int `json:"mention_count"`
	// LastReadMessageID is the viewer's read pointer (read_states.last_message_id),
	// 0 when they never read the DM. Only GetUserDMChannels fills it; frames built
	// without that query leave it nil so the field is omitted instead of claiming 0.
	LastReadMessageID *int64 `json:"last_read_message_id,omitempty"`
}

// DMUser is the public-facing shape for a DM participant.
type DMUser struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
	Status   string `json:"status"`
	// DisplayName is the participant's nickname, "" when unset.
	DisplayName string `json:"display_name"`
	// Mobile is the live "on the Android app" flag, filled by the ws ready
	// presentation only and omitted when false.
	Mobile bool `json:"mobile,omitempty"`
}

// NewDMChannelInfo assembles the payload shape for one DM from its channel id,
// optional group name, group flag and full participant list (viewer included),
// as seen by viewerID. ownerID is 0 for a 1:1 DM or an unknown owner; iconID is
// "" for none. It is the single place that decides which participant is the
// recipient, so the REST list, the ready payload and dm_channel_open cannot
// disagree.
func NewDMChannelInfo(channelID int64, name string, isGroup bool, ownerID int64, iconID string, participants []DMUser, viewerID int64) DMChannelInfo {
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
	if isGroup {
		info.OwnerID = ownerID
		info.Icon = GroupIconURL(iconID)
	}
	if len(others) > 0 {
		info.Recipient = others[0]
	}
	return info
}

// GetOrCreateDMChannel finds or creates a DM channel between two users,
// opening it for both unconditionally, and returns the channel and whether it
// was created. It is for callers with no first-contact gate (cmd/seed);
// service/dm.go's CreateDM uses GetOrCreateDMChannelGated.
func (d *DB) GetOrCreateDMChannel(ctx context.Context, user1ID, user2ID int64) (*Channel, bool, error) {
	ch, created, _, _, err := d.getOrCreateDMChannel(ctx, user1ID, user2ID, false)
	return ch, created, err
}

// GetOrCreateDMChannelGated is the gated variant for a caller-initiated 1:1
// DM (service/dm.go's CreateDM): on the create branch it decides whether to
// open the recipient's side (does the recipient already trust callerID?) and
// writes dm_open_state inside the same transaction as the trust check. A
// separate CloseDM afterwards could leave the recipient open on a cancellation
// or close a DM the recipient had meanwhile accepted. recipientOpened is
// meaningful only when created is true.
func (d *DB) GetOrCreateDMChannelGated(ctx context.Context, callerID, recipientID int64) (ch *Channel, created bool, recipientOpened bool, accepted *MessageRequest, err error) {
	return d.getOrCreateDMChannel(ctx, callerID, recipientID, true)
}

// getOrCreateDMChannel is the shared implementation. user1ID is the caller,
// whose side always ends up open; gateRecipient makes user2ID's side depend on
// trust instead of opening unconditionally. Lookup and create share one
// SERIALIZABLE transaction so two concurrent requests cannot each create a
// channel for the same pair, and so the trust check and dm_open_state write
// stay atomic.
func (d *DB) getOrCreateDMChannel(ctx context.Context, user1ID, user2ID int64, gateRecipient bool) (*Channel, bool, bool, *MessageRequest, error) {
	tx, err := d.writer.BeginTx(ctx, &sql.TxOptions{
		Isolation: sql.LevelSerializable,
	})
	if err != nil {
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel begin tx: %w", err)
	}

	// Look for an existing DM inside the transaction. The is_group clause keeps
	// group DMs out of the lookup, or "message Bob" could land in a group that
	// contains both users. It is the stored flag, not a live participant count,
	// because a group people left can have two members and must still not answer
	// "the DM between these two".
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
		// Existing channel: ensure the caller has it open (idempotent), so a user who
		// closed the DM sees it again when the other party re-initiates. The
		// recipient's side is untouched; recipientOpened is reported true for callers
		// that check it unconditionally.
		_, _ = tx.Exec(
			`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`,
			user1ID, existingID,
		)
		// A recipient opening the DM themselves while the other user's request is
		// undecided is an acceptance: same trust, open state and transition as
		// AcceptMessageRequest, in this transaction.
		var accepted *MessageRequest
		if gateRecipient {
			var acceptErr error
			if accepted, acceptErr = acceptUndecidedRequestOnOpen(ctx, d.q.WithTx(tx), user1ID, user2ID); acceptErr != nil {
				_ = tx.Rollback()
				return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel accept request: %w", acceptErr)
			}
		}
		if commitErr := tx.Commit(); commitErr != nil {
			return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel commit existing: %w", commitErr)
		}
		ch, getErr := d.GetChannel(ctx, existingID)
		if getErr != nil {
			return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel fetch existing: %w", getErr)
		}
		if ch == nil {
			return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel: channel %d vanished", existingID)
		}
		return ch, false, true, accepted, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		_ = tx.Rollback()
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel lookup: %w", err)
	}

	res, err := tx.Exec(
		`INSERT INTO channels (name, type) VALUES ('', 'dm')`,
	)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel insert channel: %w", err)
	}
	channelID, err := res.LastInsertId()
	if err != nil {
		_ = tx.Rollback()
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel last insert id: %w", err)
	}

	_, err = tx.Exec(
		`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?), (?, ?)`,
		channelID, user1ID, channelID, user2ID,
	)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel insert participants: %w", err)
	}

	// Test seam (package db only): simulates a failure in the window where the
	// recipient would otherwise land open, to prove the transaction rolls back.
	if hook := d.afterDMParticipantsInsertHook; hook != nil {
		if hookErr := hook(); hookErr != nil {
			_ = tx.Rollback()
			return nil, false, false, nil, hookErr
		}
	}

	// Decide the recipient's visibility and write dm_open_state in this same
	// transaction (see getOrCreateDMChannel).
	recipientOpened, err := decideAndOpenRecipientDM(tx, user1ID, user2ID, channelID, gateRecipient)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel commit: %w", err)
	}

	ch, err := d.GetChannel(ctx, channelID)
	if err != nil {
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel fetch new: %w", err)
	}
	return ch, true, recipientOpened, nil, nil
}

// acceptUndecidedRequestOnOpen accepts the pending, ignored or deleted request
// senderID holds against recipientID (the caller opening the DM): TrustSender,
// then the transition to accepted. The recipient's dm_open_state row is
// already written. It returns nil when there is no such request; q must be
// bound to the caller's transaction.
func acceptUndecidedRequestOnOpen(ctx context.Context, q *dbgen.Queries, recipientID, senderID int64) (*MessageRequest, error) {
	row, err := q.GetMessageRequestByPair(ctx, dbgen.GetMessageRequestByPairParams{SenderID: senderID, RecipientID: recipientID})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get request: %w", err)
	}
	// Deleted is server-side identical to ignored: the recipient dismissed the
	// request undecided, and opening the conversation is the decision. Accepted
	// and blocked rows stay.
	switch row.State {
	case "pending", "ignored", "deleted":
	default:
		return nil, nil
	}
	if err := q.TrustSender(ctx, dbgen.TrustSenderParams{RecipientID: recipientID, SenderID: senderID, Source: "accepted"}); err != nil {
		return nil, fmt.Errorf("trust: %w", err)
	}
	if _, err := q.AcceptUndecidedMessageRequest(ctx, dbgen.AcceptUndecidedMessageRequestParams{ID: row.ID, RecipientID: recipientID}); err != nil {
		return nil, fmt.Errorf("transition: %w", err)
	}
	updated, err := q.GetMessageRequestForRecipient(ctx, dbgen.GetMessageRequestForRecipientParams{ID: row.ID, RecipientID: recipientID})
	if err != nil {
		return nil, fmt.Errorf("reread: %w", err)
	}
	return fromDBGenMessageRequest(updated), nil
}

// decideAndOpenRecipientDM decides (when gateRecipient) whether user2ID
// already trusts user1ID and writes dm_open_state for channelID against tx, so
// it commits or rolls back with the caller's transaction. It is split out of
// getOrCreateDMChannel only to keep that function short and owns no
// transaction lifecycle.
func decideAndOpenRecipientDM(tx *sql.Tx, user1ID, user2ID, channelID int64, gateRecipient bool) (recipientOpened bool, err error) {
	recipientOpened = true
	if gateRecipient {
		var trustCount int
		if err := tx.QueryRow(
			`SELECT COUNT(*) FROM trusted_senders WHERE recipient_id = ? AND sender_id = ?`,
			user2ID, user1ID,
		).Scan(&trustCount); err != nil {
			return false, fmt.Errorf("trust check: %w", err)
		}
		recipientOpened = trustCount > 0
	}

	if recipientOpened {
		_, err = tx.Exec(
			`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?), (?, ?)`,
			user1ID, channelID, user2ID, channelID,
		)
	} else {
		_, err = tx.Exec(
			`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`,
			user1ID, channelID,
		)
	}
	if err != nil {
		return recipientOpened, fmt.Errorf("open dm: %w", err)
	}
	return recipientOpened, nil
}

// FindDMChannelIDBetween returns the id of the 1:1 DM the two users share, or
// ok=false. It never creates anything, and group DMs never match: blocks do
// not gate them, so block-keyed side effects (voice eviction) must not reach a
// group call.
func (d *DB) FindDMChannelIDBetween(ctx context.Context, user1ID, user2ID int64) (int64, bool, error) {
	id, err := d.q.FindDMChannelIDBetween(ctx, dbgen.FindDMChannelIDBetweenParams{
		UserID:   user1ID,
		UserID_2: user2ID,
	})
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("FindDMChannelIDBetween: %w", err)
	}
	return id, true, nil
}

// GetUserDMChannels returns all open DM channels for a user with the full
// participant list, last message preview and unread count, most recent
// activity first.
//
// It is two queries because dm_participants holds N users per channel, so one
// join would return a row per (channel, participant); fetching participants
// for every open DM in one extra pass keeps it O(1) queries. The JOIN on
// dm_open_state already restricts to DM channels; "c.type = 'dm'" is a
// defensive second check.
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
		lastRead := rows[i].LastReadMessageID
		info := DMChannelInfo{
			ChannelID:         rows[i].ChannelID,
			Recipients:        recipients,
			Name:              rows[i].Name,
			IsGroup:           rows[i].IsGroup != 0,
			OwnerID:           rows[i].OwnerID,
			Icon:              GroupIconURL(rows[i].IconID),
			LastMessageID:     rows[i].LastMessageID,
			LastMessage:       rows[i].LastMessage,
			LastMessageAt:     rows[i].LastMessageAt,
			UnreadCount:       int(rows[i].UnreadCount),
			MentionCount:      int(rows[i].MentionCount),
			LastReadMessageID: &lastRead,
		}
		if len(recipients) > 0 {
			info.Recipient = recipients[0]
		}
		result = append(result, info)
	}
	return result, nil
}
func (d *DB) CountDMParticipants(ctx context.Context, channelID int64) (int, error) {
	n, err := d.q.CountDMParticipants(ctx, channelID)
	if err != nil {
		return 0, fmt.Errorf("CountDMParticipants: %w", err)
	}
	return int(n), nil
}

// IsGroupDM reports whether a DM channel was created as a group. False for a
// missing channel or a non-DM, the conservative "treat it as 1:1" answer.
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

// OpenDM adds a DM channel to a user's open list (idempotent). The bool is
// false when it was already open (INSERT OR IGNORE's affected-row count), so
// a caller can tell a genuine open from a no-op.
func (d *DB) OpenDM(ctx context.Context, userID, channelID int64) (bool, error) {
	rows, err := d.q.OpenDM(ctx, dbgen.OpenDMParams{
		UserID:    userID,
		ChannelID: channelID,
	})
	if err != nil {
		return false, fmt.Errorf("OpenDM: %w", err)
	}
	return rows > 0, nil
}

// OpenDMIfParticipant is OpenDM that writes nothing unless userID is a current
// participant of channelID, checked in the same statement.
func (d *DB) OpenDMIfParticipant(ctx context.Context, userID, channelID int64) (bool, error) {
	rows, err := d.q.OpenDMIfParticipant(ctx, dbgen.OpenDMIfParticipantParams{
		UserID:    userID,
		ChannelID: channelID,
	})
	if err != nil {
		return false, fmt.Errorf("OpenDMIfParticipant: %w", err)
	}
	return rows > 0, nil
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

// GetUserDMChannelIDs returns the channel IDs of all DMs the user has open,
// reading only the dm_open_state primary key so access computation and search
// scoping skip GetUserDMChannels' recipient, preview and unread work.
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

// DMDeliveryTarget is one participant of a DM channel as a send by a given
// sender sees it (GetDMDeliveryTargets).
type DMDeliveryTarget struct {
	UserID int64
	// Open is whether the participant's dm_open_state row already exists.
	Open bool
	// TrustsSender is whether the participant has a trusted_senders row for
	// the sender (message requests; never populated for a group DM).
	TrustsSender bool
}

// GetDMDeliveryTargets returns, in one read, a DM channel's group flag and
// every participant with their open state and whether they trust senderID.
// isGroup is false when the channel has no participants or is not a DM.
func (d *DB) GetDMDeliveryTargets(ctx context.Context, channelID, senderID int64) (isGroup bool, targets []DMDeliveryTarget, err error) {
	rows, err := d.q.GetDMDeliveryTargets(ctx, dbgen.GetDMDeliveryTargetsParams{SenderID: senderID, ChannelID: channelID})
	if err != nil {
		return false, nil, fmt.Errorf("GetDMDeliveryTargets: %w", err)
	}
	targets = make([]DMDeliveryTarget, 0, len(rows))
	for _, r := range rows {
		isGroup = r.IsGroup != 0
		targets = append(targets, DMDeliveryTarget{UserID: r.UserID, Open: r.IsOpen != 0, TrustsSender: r.TrustsSender != 0})
	}
	return isGroup, targets, nil
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
