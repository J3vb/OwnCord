package db

import (
	"errors"
	"fmt"
	"strings"
)

// ErrSearchBadHas is returned for a SearchQuery.Has kind the builder does not know, so
// an unknown kind cannot silently widen a search.
var ErrSearchBadHas = errors.New("unknown search has kind")

// searchHasClause maps a has kind to its fixed SQL predicate. Attachment clauses join
// on attachments.message_id = m.id, so an unlinked attachment never matches; the
// builder's base m.deleted = 0 keeps soft-deleted messages out.
var searchHasClause = map[string]string{
	"link":  `(instr(lower(m.content), 'http://') > 0 OR instr(lower(m.content), 'https://') > 0)`,
	"file":  `EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)`,
	"image": `EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.mime_type LIKE 'image/%')`,
	"video": `EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.mime_type LIKE 'video/%')`,
	"sound": `EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.mime_type LIKE 'audio/%')`,
}

// searchExtraFilters renders the has:, mentions: and pinned: predicates as " AND ..."
// fragments; values are bound, the only concatenated text is the fixed fragments
// above.
func searchExtraFilters(q SearchQuery) (sql string, args []any, err error) {
	var sb strings.Builder
	for _, kind := range q.Has {
		clause, ok := searchHasClause[kind]
		if !ok {
			return "", nil, fmt.Errorf("%w: %q", ErrSearchBadHas, kind)
		}
		sb.WriteString(" AND " + clause)
	}
	for _, uid := range q.MentionIDs {
		// A reply ping is a notification, not a mention in the text, and
		// @everyone lives in messages.mentions_everyone, never here. A message
		// that pings and also names the user is stored as one reply_ping row,
		// so that row still counts while the current text names the user
		// (approximate, like has:link).
		sb.WriteString(` AND EXISTS (SELECT 1 FROM message_mentions mm
			JOIN users mu ON mu.id = mm.mentioned_user_id
			WHERE mm.message_id = m.id AND mm.mentioned_user_id = ?
			AND (mm.reply_ping = 0 OR instr(lower(m.content), '@' || lower(mu.username)) > 0))`)
		args = append(args, uid)
	}
	if q.Pinned != nil {
		// Literal 1/0 (not a bound arg) so the planner can use the partial
		// index idx_messages_pinned for pinned:true.
		if *q.Pinned {
			sb.WriteString(" AND m.pinned = 1")
		} else {
			sb.WriteString(" AND m.pinned = 0")
		}
	}
	return sb.String(), args, nil
}
