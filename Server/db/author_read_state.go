package db

import (
	"context"
	"log/slog"

	"github.com/J3vb/OwnCord/Server/db/dbgen"
)

// advanceAuthorReadState is UpdateReadState for the send path, run inside the
// transaction that inserts the author's message. Both unread queries count
// "messages with id > my read_states row" without filtering by author, so
// without it an author's own message reads back as unread to themselves: post,
// navigate away, and the next `ready` restates it as a badge. Advancing the
// read state, rather than filtering the queries by author, keeps the stored
// state truthful and covers DMs and text channels through one path.
//
// It shares the insert's writer checkout rather than taking a second one
// after the commit: under a burst of simultaneous sends every checkout queues
// behind the other senders', so a second checkout put each sender back in the
// writer queue before its acknowledgement (OC-0454).
//
// Best-effort, as it was as a separate statement after the commit: a failure
// is logged and the message still commits. SQLite rolls back only the failing
// statement unless the error is one that aborts the whole transaction
// (SQLITE_FULL, SQLITE_IOERR, SQLITE_NOMEM); then the commit fails too and the
// send reports the failure truthfully, because the message was not stored
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
