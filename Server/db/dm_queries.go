package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
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
	// MentionCount is read_states.mention_count for this DM, carried by the
	// GetUserDMChannels query so every path that builds a DM summary (GET
	// /dms and the ready payload) reports the same badge.
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

// GetOrCreateDMChannel finds or creates a DM channel between two users,
// opening it for both unconditionally. Returns the channel, whether it was
// newly created, and any error. Used where there is no first-contact gate to
// apply (cmd/seed's demo data) — service/dm.go's CreateDM goes through
// GetOrCreateDMChannelGated instead.
func (d *DB) GetOrCreateDMChannel(ctx context.Context, user1ID, user2ID int64) (*Channel, bool, error) {
	ch, created, _, _, err := d.getOrCreateDMChannel(ctx, user1ID, user2ID, false)
	return ch, created, err
}

// GetOrCreateDMChannelGated is GetOrCreateDMChannel's gated variant for a
// caller-initiated one-to-one DM (service/dm.go's CreateDM): on the create
// branch it decides whether to open the recipient's side (does the
// recipient already trust callerID?) and writes dm_open_state accordingly —
// INSIDE the same transaction as the trust check, with no separate
// CloseDM step afterward. Codex review round 2, P1: the old shape (create
// both sides open, then CloseDM the recipient's side in a later call) left
// a window where a cancellation or a failed CloseDM left the recipient open,
// and where a CloseDM built from a stale "not trusted" read could close a DM
// the recipient had meanwhile accepted (the trust write racing the read).
// recipientOpened is only meaningful when created is true — an existing
// channel's recipient side is whatever it already was, untouched here.
func (d *DB) GetOrCreateDMChannelGated(ctx context.Context, callerID, recipientID int64) (ch *Channel, created bool, recipientOpened bool, accepted *MessageRequest, err error) {
	return d.getOrCreateDMChannel(ctx, callerID, recipientID, true)
}

// getOrCreateDMChannel is the shared implementation. user1ID is always the
// caller (the one whose side always ends up open); gateRecipient controls
// whether user2ID's side is conditioned on trust (true) or opened
// unconditionally like user1ID's (false). The entire lookup+create is
// wrapped in a single SERIALIZABLE transaction to prevent a TOCTOU race
// where two concurrent requests both see ErrNoRows and each create a
// separate DM channel for the same user pair — and, when gated, to keep the
// trust check and the dm_open_state write atomic.
func (d *DB) getOrCreateDMChannel(ctx context.Context, user1ID, user2ID int64, gateRecipient bool) (*Channel, bool, bool, *MessageRequest, error) {
	tx, err := d.writer.BeginTx(ctx, &sql.TxOptions{
		Isolation: sql.LevelSerializable,
	})
	if err != nil {
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel begin tx: %w", err)
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
		// not see it in their sidebar after the other party re-initiates. The
		// recipient's own side is untouched — recipientOpened is meaningless
		// here (created is false) so it is reported true for backward
		// compatibility with callers checking it unconditionally.
		_, _ = tx.Exec(
			`INSERT OR IGNORE INTO dm_open_state (user_id, channel_id) VALUES (?, ?)`,
			user1ID, existingID,
		)
		// A recipient opening the DM themselves while the other user's request
		// is still undecided is an acceptance: same trust, open state and state
		// transition AcceptMessageRequest writes, in this transaction.
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

	// No existing DM — create one inside the same transaction.

	// Insert channel with type 'dm' and empty name.
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

	// Insert both participants.
	_, err = tx.Exec(
		`INSERT INTO dm_participants (channel_id, user_id) VALUES (?, ?), (?, ?)`,
		channelID, user1ID, channelID, user2ID,
	)
	if err != nil {
		_ = tx.Rollback()
		return nil, false, false, nil, fmt.Errorf("GetOrCreateDMChannel insert participants: %w", err)
	}

	// Test seam (package db only, no exported setter): lets a same-package
	// test simulate a failure/cancellation in the exact window the old
	// two-step create-then-CloseDM shape used to leave open, and confirm the
	// whole transaction rolls back instead of landing the recipient open.
	if hook := d.afterDMParticipantsInsertHook; hook != nil {
		if hookErr := hook(); hookErr != nil {
			_ = tx.Rollback()
			return nil, false, false, nil, hookErr
		}
	}

	// Decide user2ID's (the recipient's) visibility and write dm_open_state
	// in the SAME transaction — see getOrCreateDMChannel's doc comment
	// (Codex review round 2, P1) for why this must not be a separate step.
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

// acceptUndecidedRequestOnOpen accepts the pending or ignored request that
// senderID holds against recipientID (the caller opening the DM), if any:
// TrustSender, then the transition to accepted. The recipient's dm_open_state
// row is already written by the caller. Returns nil when there is no such
// request. q must be bound to the caller's transaction.
func acceptUndecidedRequestOnOpen(ctx context.Context, q *dbgen.Queries, recipientID, senderID int64) (*MessageRequest, error) {
	row, err := q.GetMessageRequestByPair(ctx, dbgen.GetMessageRequestByPairParams{SenderID: senderID, RecipientID: recipientID})
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get request: %w", err)
	}
	if row.State != "pending" && row.State != "ignored" {
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
// already trusts user1ID and writes dm_open_state for the freshly created
// channelID accordingly, both against tx — so it commits or rolls back as
// one unit with the caller's transaction. Split out of getOrCreateDMChannel
// only to keep that function's statement count down; it owns no transaction
// lifecycle of its own (the caller rolls back on a non-nil error).
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

// FindDMChannelIDBetween returns the id of the 1:1 DM channel the two users
// share, or ok=false when none exists. It never creates anything, and group
// DMs never match — blocks do not gate them, so side effects keyed off a
// block (like voice eviction) must not reach a group call.
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
			MentionCount:  int(rows[i].MentionCount),
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

// OpenDM adds a DM channel to a user's open list (idempotent). The bool
// reports whether the DM was actually (re)opened by this call — false when it
// was already open, via the INSERT OR IGNORE's affected-row count — so a
// caller can distinguish a genuine open from a no-op on an already-open DM.
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
