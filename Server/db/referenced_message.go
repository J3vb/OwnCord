package db

import (
	"context"
	"fmt"
	"strings"
)

// referencedSnippetRunes caps a reply snippet's content.
const referencedSnippetRunes = 100

// attachReferencedMessages fills ReferencedMessage for every reply in msgs.
// A parent is only ever read from the reply's own channel.
func (d *DB) attachReferencedMessages(ctx context.Context, msgs []MessageAPIResponse) ([]MessageAPIResponse, error) {
	byChannel := map[int64][]int64{}
	for i := range msgs {
		if m := &msgs[i]; m.ReplyTo != nil {
			byChannel[m.ChannelID] = append(byChannel[m.ChannelID], *m.ReplyTo)
		}
	}
	found := make(map[[2]int64]*ReferencedMessage)
	for ch, ids := range byChannel {
		refs, err := d.GetReferencedMessages(ctx, ch, ids)
		if err != nil {
			return nil, err
		}
		for id, r := range refs {
			found[[2]int64{ch, id}] = r
		}
	}
	for i := range msgs {
		if msgs[i].ReplyTo != nil {
			msgs[i].ReferencedMessage = found[[2]int64{msgs[i].ChannelID, *msgs[i].ReplyTo}]
		}
	}
	return msgs, nil
}

// GetReferencedMessages returns the reply snippets for parent ids that live
// in channelID, keyed by id. A parent in another channel or already purged is
// absent; a soft-deleted one is redacted to {id, deleted: true}.
func (d *DB) GetReferencedMessages(ctx context.Context, channelID int64, ids []int64) (map[int64]*ReferencedMessage, error) {
	out := make(map[int64]*ReferencedMessage, len(ids))
	if len(ids) == 0 {
		return out, nil
	}
	args := []any{channelID}
	var sb strings.Builder
	for i, id := range ids {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteByte('?')
		args = append(args, id)
	}
	query := fmt.Sprintf( //nolint:gosec // G201: placeholder interpolation, not user input
		`SELECT m.id, m.deleted, m.content, u.id, u.username, u.avatar,
		        EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)
		 FROM messages m LEFT JOIN users u ON m.user_id = u.id
		 WHERE m.channel_id = ? AND m.id IN (%s)`, sb.String())
	rows, err := d.reader.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("GetReferencedMessages: %w", err)
	}
	defer rows.Close() //nolint:errcheck
	for rows.Next() {
		var (
			r        ReferencedMessage
			deleted  int
			hasAtt   int
			uid      *int64
			username *string
			avatar   *string
		)
		if err := rows.Scan(&r.ID, &deleted, &r.Content, &uid, &username, &avatar, &hasAtt); err != nil {
			return nil, fmt.Errorf("GetReferencedMessages scan: %w", err)
		}
		if deleted != 0 || uid == nil || username == nil {
			out[r.ID] = &ReferencedMessage{ID: r.ID, Deleted: true}
			continue
		}
		if runes := []rune(r.Content); len(runes) > referencedSnippetRunes {
			r.Content = string(runes[:referencedSnippetRunes])
		}
		r.HasAttachments = hasAtt != 0
		r.User = &UserPublic{ID: *uid, Username: *username, Avatar: avatar}
		out[r.ID] = &r
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("GetReferencedMessages rows: %w", err)
	}
	return out, nil
}
