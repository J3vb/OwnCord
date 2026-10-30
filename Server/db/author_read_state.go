package db

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// advanceAuthorReadState is UpdateReadState for the send path, run inside the
// transaction that inserts the author's message. Both unread queries count
// messages with id > the read_states row without filtering by author, so
// without it an author's own message reads back as unread to themselves.
// Advancing the read state keeps the stored state truthful and covers DMs and
// text channels in one path.
//
// It shares the insert's writer checkout, because a second checkout after the
// commit would put each sender back in the writer queue behind the others
// before its acknowledgement.
//
// Best effort: a failure is logged and the message still commits. SQLite rolls
// back only the failing statement unless the error aborts the whole
// transaction (SQLITE_FULL, SQLITE_IOERR, SQLITE_NOMEM); then the commit fails
// too and the send reports it truthfully.
// either.
func advanceAuthorReadState(ctx context.Context, q *dbgen.Queries, userID, channelID, messageID int64) {
	if err := q.UpdateReadState(ctx, dbgen.UpdateReadStateParams{
		UserID:        userID,
		ChannelID:     channelID,
		LastMessageID: messageID,
	}); err != nil {
		slog.Warn("db: could not advance the author's read state past their message",
			"err", err, "user_id", userID, "channel_id", channelID, "msg_id", messageID)
	}
}
