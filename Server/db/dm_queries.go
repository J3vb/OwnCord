package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// MaxGroupDMParticipants is the participant ceiling for a group DM, creator included.
const MaxGroupDMParticipants = 10

// DMChannelInfo holds a DM channel summary for the channel list.
type DMChannelInfo struct {
	ChannelID int64 `json:"channel_id"`
	// Recipient is the other participant of a two-person DM, for clients that predate
	// group DMs; for a group it is the lowest-id other participant.
	Recipient  DMUser   `json:"recipient"`
	Recipients []DMUser `json:"recipients"`
	Name       string   `json:"name"`
	// IsGroup is channels.is_group, decided at creation and never recomputed from the
	// participant count.
	IsGroup       bool   `json:"is_group"`
	OwnerID       int64  `json:"owner_id,omitempty"`
	Icon          string `json:"icon"`
	LastMessageID *int64 `json:"last_message_id"`
	LastMessage   string `json:"last_message"`
	LastMessageAt string `json:"last_message_at"`
	UnreadCount   int    `json:"unread_count"`
	MentionCount  int    `json:"mention_count"`
	// LastReadMessageID is the viewer's read pointer, 0 when never read. Only
	// GetUserDMChannels fills it; other frames leave it nil so the field is omitted.
	LastReadMessageID *int64 `json:"last_read_message_id,omitempty"`
}

// DMUser is the public-facing shape for a DM participant.
type DMUser struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	Avatar      string `json:"avatar"`
	Status      string `json:"status"`
	DisplayName string `json:"display_name"`
	Mobile      bool   `json:"mobile,omitempty"`
}

// NewDMChannelInfo assembles the payload for one DM as seen by viewerID from the full
// participant list. ownerID is 0 for a 1:1 DM; iconID "" for none. It is the single
// place deciding which participant is the recipient, so REST, ready and
// dm_channel_open agree.
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

// FindDMChannelIDBetween returns the id of the 1:1 DM the two users share, or
// ok=false; it never creates one. Group DMs never match: blocks do not gate them, so
// block-keyed side effects (voice eviction) must not reach a group call.
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

// GetUserDMChannels returns all open DM channels for a user with participants,
// last message preview and unread count, most recent activity first. It is two
// queries because one join would return a row per (channel, participant). The
// JOIN on dm_open_state already restricts to DMs; "c.type = 'dm'" is a
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

// DMHistory is the history part of one participant's DM sidebar row.
type DMHistory struct {
	LastMessageID *int64
	LastMessage   string
	LastMessageAt string
	UnreadCount   int
	MentionCount  int
}

// GetDMHistoryForParticipants returns the history fields of channelID's sidebar row
// for each of userIDs that participates, keyed by user; counts match
// GetUserDMChannels.
func (d *DB) GetDMHistoryForParticipants(ctx context.Context, channelID int64, userIDs []int64) (map[int64]DMHistory, error) {
	out := make(map[int64]DMHistory, len(userIDs))
	if len(userIDs) == 0 {
		return out, nil
	}
	rows, err := d.q.GetDMHistoryForParticipants(ctx, dbgen.GetDMHistoryForParticipantsParams{
		ChannelID: channelID,
		UserIds:   userIDs,
	})
	if err != nil {
		return nil, fmt.Errorf("GetDMHistoryForParticipants: %w", err)
	}
	for i := range rows {
		out[rows[i].UserID] = DMHistory{
			LastMessageID: rows[i].LastMessageID,
			LastMessage:   rows[i].LastMessage,
			LastMessageAt: rows[i].LastMessageAt,
			UnreadCount:   int(rows[i].UnreadCount),
			MentionCount:  int(rows[i].MentionCount),
		}
	}
	return out, nil
}

func (d *DB) CountDMParticipants(ctx context.Context, channelID int64) (int, error) {
	n, err := d.q.CountDMParticipants(ctx, channelID)
	if err != nil {
		return 0, fmt.Errorf("CountDMParticipants: %w", err)
	}
	return int(n), nil
}

// IsGroupDM reports whether a DM channel was created as a group; false for a missing
// channel or non-DM.
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

// GetDMParticipants returns every participant, viewer-adjusted (an invisible one reads
// offline to others).
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

// OpenDM adds a DM channel to a user's open list (idempotent); false when it was already open.
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

// OpenDMIfParticipant is OpenDM that writes nothing unless userID is a current participant.
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

// GetUserDMChannelIDs returns the open DM channel ids from the dm_open_state primary key alone.
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

// DMDeliveryTarget is one participant as a send by a given sender sees it.
type DMDeliveryTarget struct {
	UserID int64
	Open   bool
	// TrustsSender is whether the participant has a trusted_senders row for the sender
	// (never populated for a group DM).
	TrustsSender bool
	// TrustedBySender is the reverse: the sender has a trusted_senders row for the participant.
	TrustedBySender bool
}

// GetDMDeliveryTargets returns in one read a DM channel's group flag and every
// participant with open state and whether they trust senderID; isGroup is false for a
// non-DM or a channel with no participants.
func (d *DB) GetDMDeliveryTargets(ctx context.Context, channelID, senderID int64) (isGroup bool, targets []DMDeliveryTarget, err error) {
	rows, err := d.q.GetDMDeliveryTargets(ctx, dbgen.GetDMDeliveryTargetsParams{SenderID: senderID, ChannelID: channelID})
	if err != nil {
		return false, nil, fmt.Errorf("GetDMDeliveryTargets: %w", err)
	}
	targets = make([]DMDeliveryTarget, 0, len(rows))
	for _, r := range rows {
		isGroup = r.IsGroup != 0
		targets = append(targets, DMDeliveryTarget{UserID: r.UserID, Open: r.IsOpen != 0, TrustsSender: r.TrustsSender != 0, TrustedBySender: r.TrustedBySender != 0})
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
