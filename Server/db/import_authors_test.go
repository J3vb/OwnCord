package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// seedImported writes a message owned by owner and an import author row for it.
func seedImported(t *testing.T, database *db.DB, ch, owner int64, content, name string, color *string) int64 {
	t.Helper()
	ctx := context.Background()
	id, err := database.CreateMessage(ctx, ch, owner, content, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx,
		`INSERT INTO message_import_authors (message_id, discord_user_id, name, color) VALUES (?, ?, ?, ?)`,
		id, "1234567890", name, color); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestImportedAuthor_HistoryAndPins(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	owner := seedUser(t, database, "importer")
	alice := seedUser(t, database, "alice")
	ch := seedChannel(t, database, "general")

	color := "#ff8800"
	imp := seedImported(t, database, ch, owner, "from discord", "Ann", &color)
	plain, _ := database.CreateMessage(ctx, ch, alice, "native", nil)

	msgs, err := database.GetMessagesForAPI(ctx, ch, 0, 50, alice)
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range msgs {
		switch m.ID {
		case imp:
			if m.ImportedAuthor == nil || m.ImportedAuthor.Name != "Ann" || m.ImportedAuthor.Color == nil || *m.ImportedAuthor.Color != color {
				t.Errorf("imported message author = %+v", m.ImportedAuthor)
			}
		case plain:
			if m.ImportedAuthor != nil {
				t.Errorf("native message carries imported_author %+v", m.ImportedAuthor)
			}
		}
	}

	after, err := database.GetMessagesAfterForAPI(ctx, ch, 0, 50, alice)
	if err != nil || after[0].ID != imp || after[0].ImportedAuthor == nil {
		t.Fatalf("after: %v %+v", err, after)
	}
	around, err := database.GetMessagesAroundForAPI(ctx, ch, imp, 5, 5, alice)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range around {
		if m.ID == imp {
			found = m.ImportedAuthor != nil
		}
	}
	if !found {
		t.Error("around window lost imported_author")
	}

	if _, err := database.SetMessagePinned(ctx, db.SetPinnedParams{MessageID: imp, Pinned: true, UserID: alice}); err != nil {
		t.Fatal(err)
	}
	pins, err := database.GetPinnedMessages(ctx, ch, alice)
	if err != nil || len(pins) != 1 || pins[0].ImportedAuthor == nil || pins[0].ImportedAuthor.Name != "Ann" {
		t.Fatalf("pins: %v %+v", err, pins)
	}
}

func TestImportedAuthor_NullColourOmitted(t *testing.T) {
	database := openMigratedMemory(t)
	owner := seedUser(t, database, "importer")
	ch := seedChannel(t, database, "general")
	seedImported(t, database, ch, owner, "hi", "Bob", nil)
	msgs, err := database.GetMessagesForAPI(context.Background(), ch, 0, 50, owner)
	if err != nil || msgs[0].ImportedAuthor == nil || msgs[0].ImportedAuthor.Color != nil {
		t.Fatalf("%v %+v", err, msgs[0].ImportedAuthor)
	}
}

func TestImportedAuthor_ReplyPreview(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	owner := seedUser(t, database, "importer")
	alice := seedUser(t, database, "alice")
	ch := seedChannel(t, database, "general")
	imp := seedImported(t, database, ch, owner, "original", "Ann", nil)
	reply, _ := database.CreateMessage(ctx, ch, alice, "re", &imp)

	msgs, err := database.GetMessagesForAPI(ctx, ch, 0, 50, alice)
	if err != nil {
		t.Fatal(err)
	}
	if msgs[0].ID != reply || msgs[0].ReferencedMessage == nil || msgs[0].ReferencedMessage.ImportedAuthor == nil ||
		msgs[0].ReferencedMessage.ImportedAuthor.Name != "Ann" {
		t.Fatalf("reply preview = %+v", msgs[0].ReferencedMessage)
	}
}

func TestImportedAuthor_Search(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	owner := seedUser(t, database, "importer")
	alice := seedUser(t, database, "alice")
	ch := seedChannel(t, database, "general")
	imp := seedImported(t, database, ch, owner, "zebra from discord", "Ann", nil)
	plain, _ := database.CreateMessage(ctx, ch, alice, "zebra native", nil)

	rs, err := database.SearchMessagesFiltered(ctx, db.SearchQuery{Text: "zebra", ChannelIDs: []int64{ch}}, db.SearchPage{Limit: 50})
	if err != nil || len(rs) != 2 {
		t.Fatalf("search: %v %d", err, len(rs))
	}
	for _, r := range rs {
		if r.MessageID == imp && (r.ImportedAuthor == nil || r.ImportedAuthor.Name != "Ann") {
			t.Errorf("imported hit = %+v", r.ImportedAuthor)
		}
		if r.MessageID == plain && r.ImportedAuthor != nil {
			t.Errorf("native hit carries imported_author")
		}
	}
}
