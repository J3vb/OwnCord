package db_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// OC-0358: EditMessage's UPDATE was keyed on id alone, so an edit that raced a
// delete rewrote a tombstone and reported success — the caller then broadcast
// chat_edited for a message every client had already replaced with "message
// deleted". OC-0284 gave SoftDeleteMessage and SetMessagePinned an
// `AND deleted = 0` guard for exactly this reason; the edit path is the last
// writer that lacked it.
//
// The read-then-write window is real but too narrow to hit reliably, so this
// drives the state the race produces: a row already soft-deleted when the
// UPDATE lands.

func TestEditMessage_RefusesASoftDeletedRow(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	userID := seedUser(t, database, "edit-race-owner")
	chID := seedChannel(t, database, "edit-race-ch")

	id, err := database.CreateMessage(ctx, chID, userID, "original", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if err := database.DeleteMessage(ctx, id, userID, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}

	updated, err := database.EditMessage(ctx, id, userID, "resurrected")
	if !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("EditMessage on a deleted row: err = %v, want ErrNotFound (got row %+v)", err, updated)
	}

	// The tombstone is intact: no content, no edited_at.
	msg, err := database.GetMessage(ctx, id)
	if err != nil || msg == nil {
		t.Fatalf("GetMessage: %v", err)
	}
	switch {
	case msg.Content == "resurrected":
		t.Error("the refused edit still rewrote the deleted row's content")
	case !msg.Deleted:
		t.Error("the row is no longer marked deleted")
	case msg.EditedAt != nil:
		t.Error("the refused edit still stamped edited_at")
	}
}

// OC-0357: messages_fts uses FTS5's unicode61 tokenizer, where every
// non-alphanumeric rune is a token separator — "user_id" is indexed as `user`
// and `id`. sanitizeFTSQuery kept letters, digits and spaces, folded '-' to a
// space, and silently DROPPED every other separator, concatenating the
// neighbouring tokens into one term that exists nowhere in the index. Any
// query carrying punctuation therefore matched nothing at all.
func TestSearchMessages_PunctuationFoldsToASeparator(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	userID := seedUser(t, database, "fts-author")
	chID := seedChannel(t, database, "fts-ch")

	for _, content := range []string{
		"the user_id column is indexed as two tokens",
		"contact me at someone@example.com please",
		"see docs/architecture/README.md for the map",
	} {
		if _, err := database.CreateMessage(ctx, chID, userID, content, nil); err != nil {
			t.Fatalf("CreateMessage: %v", err)
		}
	}

	for _, tc := range []struct {
		name, query, want string
	}{
		{"underscore", "user_id", "user_id column"},
		{"at sign and dot", "someone@example.com", "someone@example.com"},
		{"slashes and a dot", "docs/architecture/README.md", "docs/architecture"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := database.SearchMessages(ctx, tc.query, nil, 10)
			if err != nil {
				t.Fatalf("SearchMessages(%q): %v", tc.query, err)
			}
			if len(got) == 0 {
				t.Fatalf("SearchMessages(%q) found nothing; the separators must fold to spaces, not vanish", tc.query)
			}
			if !strings.Contains(got[0].Content, tc.want) {
				t.Errorf("SearchMessages(%q) matched %q, want the row containing %q", tc.query, got[0].Content, tc.want)
			}
		})
	}
}

// The separator folding must not reopen what the sanitizer exists to close:
// FTS5 operator syntax still has to be inert.
func TestSearchMessages_OperatorSyntaxStaysInert(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	userID := seedUser(t, database, "fts-operator-author")
	chID := seedChannel(t, database, "fts-operator-ch")

	if _, err := database.CreateMessage(ctx, chID, userID, "harmless content here", nil); err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	// Every one of these is FTS5 grammar; none may reach the engine as syntax,
	// and none may error the query.
	for _, q := range []string{
		`"harmless" OR "nothing"`,
		`harmless AND NOT content`,
		`content: harmless`,
		`har*`,
		`NEAR(harmless content, 2)`,
		`^harmless`,
		`(harmless)`,
		`AND`,
		`-`,
		`""`,
	} {
		if _, err := database.SearchMessages(ctx, q, nil, 10); err != nil {
			t.Errorf("SearchMessages(%q) errored: %v — operator syntax must be neutralized, not passed through", q, err)
		}
	}
}
