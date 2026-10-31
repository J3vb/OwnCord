package db

import (
	"context"
	"fmt"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// CallLogParams describes the call log row CreateCallLog writes. StartedAt and
// LastSeenAt use the messages.timestamp layout ("2006-01-02 15:04:05", UTC).
// Content is the fallback text that only old clients show.
type CallLogParams struct {
	ChannelID      int64
	AuthorID       int64
	Content        string
	StartedAt      string
	LastSeenAt     string
	ParticipantIDs []int64
}

// CallLogRow is a call log message with its call block.
type CallLogRow struct {
	Message *Message
	Call    CallInfo
}

// CreateCallLog writes a call log row in one transaction: the message with
// kind = 1, its message_calls row, the participants, and the author's read
// state (advanceAuthorReadState, so the author's own row is not unread to
// them). A channel can hold one live call: a second open call for the channel
// fails with ErrConflict and writes nothing.
func (d *DB) CreateCallLog(ctx context.Context, p CallLogParams) (*CallLogRow, error) {
	var out *CallLogRow
	err := d.inWriteTx(ctx, "CreateCallLog", func(q *dbgen.Queries) error {
		m, err := q.InsertCallMessage(ctx, dbgen.InsertCallMessageParams{
			ChannelID: p.ChannelID, UserID: p.AuthorID, Content: p.Content,
		})
		if err != nil {
			return fmt.Errorf("insert message: %w", err)
		}
		if err := q.InsertMessageCall(ctx, dbgen.InsertMessageCallParams{
			MessageID: m.ID, ChannelID: p.ChannelID,
			StartedAt: p.StartedAt, LastSeenAt: p.LastSeenAt,
		}); err != nil {
			if IsUniqueConstraintError(err) {
				return fmt.Errorf("channel %d already has a live call: %w", p.ChannelID, ErrConflict)
			}
			return fmt.Errorf("insert call: %w", err)
		}
		ids := make([]int64, 0, len(p.ParticipantIDs))
		for _, uid := range p.ParticipantIDs {
			if err := q.InsertMessageCallParticipant(ctx, dbgen.InsertMessageCallParticipantParams{
				MessageID: m.ID, UserID: uid,
			}); err != nil {
				return fmt.Errorf("insert participant: %w", err)
			}
			ids = append(ids, uid)
		}
		advanceAuthorReadState(ctx, q, p.AuthorID, p.ChannelID, m.ID)
		out = &CallLogRow{
			Message: messageFromGen(m),
			Call:    CallInfo{StartedAt: p.StartedAt, Participants: ids},
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// EndCall closes a live call at endedAt and rewrites the fallback content, in
// one transaction. It reports whether this call ended it: a second end finds
// no live row, changes nothing and returns false.
func (d *DB) EndCall(ctx context.Context, messageID int64, endedAt, content string) (bool, error) {
	ended := false
	err := d.inWriteTx(ctx, "EndCall", func(q *dbgen.Queries) error {
		n, err := q.EndMessageCall(ctx, dbgen.EndMessageCallParams{
			EndedAt: &endedAt, MessageID: messageID,
		})
		if err != nil {
			return fmt.Errorf("end call: %w", err)
		}
		if n == 0 {
			return nil
		}
		if err := q.UpdateCallMessageContent(ctx, dbgen.UpdateCallMessageContentParams{
			Content: content, ID: messageID,
		}); err != nil {
			return fmt.Errorf("update content: %w", err)
		}
		ended = true
		return nil
	})
	if err != nil {
		return false, err
	}
	return ended, nil
}

// attachCalls fills Kind and Call on every call log row in msgs with one
// batched read of the call rows and one of the participants. Rows of other
// kinds are untouched, and a page with no call rows costs no query.
func (d *DB) attachCalls(ctx context.Context, msgs []MessageAPIResponse) error {
	var ids []int64
	idx := make(map[int64]int)
	for i := range msgs {
		if msgs[i].Kind == MessageKindNameCall {
			ids = append(ids, msgs[i].ID)
			idx[msgs[i].ID] = i
		}
	}
	if len(ids) == 0 {
		return nil
	}
	calls, err := d.q.GetMessageCallsByMessageIDs(ctx, padIDs(ids))
	if err != nil {
		return fmt.Errorf("calls: %w", err)
	}
	parts, err := d.q.GetMessageCallParticipantsByMessageIDs(ctx, padIDs(ids))
	if err != nil {
		return fmt.Errorf("participants: %w", err)
	}
	byMsg := make(map[int64]*CallInfo, len(calls))
	for _, c := range calls {
		byMsg[c.MessageID] = &CallInfo{StartedAt: c.StartedAt, EndedAt: c.EndedAt, Participants: []int64{}}
	}
	for _, p := range parts {
		if ci, ok := byMsg[p.MessageID]; ok {
			ci.Participants = append(ci.Participants, p.UserID)
		}
	}
	for id, ci := range byMsg {
		msgs[idx[id]].Call = ci
	}
	return nil
}
