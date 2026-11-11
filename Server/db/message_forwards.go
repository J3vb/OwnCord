package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// ErrForwardSourceGone means the forwarded message is deleted; CreateMessageDelivery
// returns it inside its transaction, so a delete that commits first wins.
var ErrForwardSourceGone = errors.New("forward source is gone")

// ForwardRow is a forward's side row (migration 071); as input to
// CreateMessageDelivery it also names the message re-read. No json tags (the wire
// shape is ForwardInfo).
type ForwardRow struct {
	// SourceMessageID is the original the jump link names (for a forward of a forward, the
	// original it copied); nil when gone.
	SourceMessageID *int64
	SourceChannelID int64
	SourceTimestamp string

	// ForwardedID is the message the sender chose to forward, re-read by the transaction;
	// input only, not stored, and differs from SourceMessageID for a forward of a forward.
	ForwardedID int64
}

// ForwardInfo is the forward block of a history row and live frame; SourceMessageID is
// null when the original is gone, and no author is carried.
type ForwardInfo struct {
	SourceChannelID int64  `json:"source_channel_id"`
	SourceMessageID *int64 `json:"source_message_id"`
	SourceTimestamp string `json:"source_timestamp"`
}

// ForwardAttachment is one file of a forwarded message; StoredAs never reaches a client.
type ForwardAttachment struct {
	ID            string
	Filename      string
	StoredAs      string
	Mime          string
	Size          int64
	Width, Height *int
	DurationMs    *int
	Waveform      *string
}

// GetMessageForward returns the side row of messageID, or nil when it is not a forward.
func (d *DB) GetMessageForward(ctx context.Context, messageID int64) (*ForwardRow, error) {
	r, err := d.q.GetMessageForward(ctx, messageID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("GetMessageForward: %w", err)
	}
	return &ForwardRow{
		SourceMessageID: r.SourceMessageID, SourceChannelID: r.SourceChannelID, SourceTimestamp: r.SourceTimestamp,
	}, nil
}

// ListForwardAttachments returns the files of messageID in upload order.
func (d *DB) ListForwardAttachments(ctx context.Context, messageID int64) ([]ForwardAttachment, error) {
	rows, err := d.q.ListAttachmentsForForward(ctx, &messageID)
	if err != nil {
		return nil, fmt.Errorf("ListForwardAttachments: %w", err)
	}
	out := make([]ForwardAttachment, 0, len(rows))
	for i := range rows {
		r := rows[i]
		out = append(out, ForwardAttachment{
			ID: r.ID, Filename: r.Filename, StoredAs: r.StoredAs, Mime: r.MimeType, Size: r.Size,
			Width: int64PtrToInt(r.Width), Height: int64PtrToInt(r.Height),
			DurationMs: int64PtrToInt(r.DurationMs), Waveform: r.Waveform,
		})
	}
	return out, nil
}

func int64PtrToInt(v *int64) *int {
	if v == nil {
		return nil
	}
	n := int(*v)
	return &n
}

// recheckForwardSource is the first half of the forward step: in the transaction
// before any write, the forwarded message must still be a live ordinary message.
func recheckForwardSource(ctx context.Context, q *dbgen.Queries, f *ForwardRow) error {
	s, err := q.GetForwardSourceState(ctx, f.ForwardedID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrForwardSourceGone
	}
	if err != nil {
		return fmt.Errorf("forward source: %w", err)
	}
	if s.Deleted != 0 || s.Kind != MessageKindUser {
		return ErrForwardSourceGone
	}
	return nil
}

func insertForwardRow(ctx context.Context, q *dbgen.Queries, messageID int64, f *ForwardRow) error {
	if err := q.InsertMessageForward(ctx, dbgen.InsertMessageForwardParams{
		MessageID: messageID, SourceMessageID: f.SourceMessageID,
		SourceChannelID: f.SourceChannelID, SourceTimestamp: f.SourceTimestamp,
	}); err != nil {
		return fmt.Errorf("forward row insert: %w", err)
	}
	return nil
}

func (d *DB) attachForwards(ctx context.Context, msgs []MessageAPIResponse) error {
	var ids []int64
	for i := range msgs {
		if msgs[i].Kind == "" && !msgs[i].Deleted {
			ids = append(ids, msgs[i].ID)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	rows, err := d.q.GetMessageForwardsByMessageIDs(ctx, padIDs(ids))
	if err != nil {
		return fmt.Errorf("forwards: %w", err)
	}
	if len(rows) == 0 {
		return nil
	}
	byMsg := make(map[int64]int, len(rows))
	for i := range rows {
		byMsg[rows[i].MessageID] = i
	}
	for i := range msgs {
		at, ok := byMsg[msgs[i].ID]
		if !ok || msgs[i].Deleted {
			continue
		}
		row := rows[at]
		info := &ForwardInfo{SourceChannelID: row.SourceChannelID, SourceTimestamp: row.SourceTimestamp}
		if row.SourceMessageID != nil && row.SourceDeleted != nil && *row.SourceDeleted == 0 {
			info.SourceMessageID = row.SourceMessageID
		}
		msgs[i].Forward = info
	}
	return nil
}
