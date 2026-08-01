package db_test

import (
	"context"
	"testing"

	"github.com/owncord/server/db"
)

// seedEmojiUploader inserts the user row the emoji.uploaded_by foreign key
// needs, and returns its id.
func seedEmojiUploader(t *testing.T, database *db.DB) int64 {
	t.Helper()
	res, err := database.ExecContext(context.Background(),
		`INSERT INTO users (username, password) VALUES ('emoji-uploader', 'x')`)
	if err != nil {
		t.Fatalf("seed uploader: %v", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("LastInsertId: %v", err)
	}
	return id
}

// These run against the real embedded migration set: migration 026 is what
// adds the mime_type column these queries select, so the inline test schema
// would not carry it.

func TestEmojiCRUDRoundTrip(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	uploader := seedEmojiUploader(t, database)

	created, err := database.CreateEmoji(ctx, "wave", "uuid-wave", "image/png", uploader)
	if err != nil {
		t.Fatalf("CreateEmoji: %v", err)
	}
	if created.ID == 0 {
		t.Fatalf("CreateEmoji returned id 0")
	}
	if created.Shortcode != "wave" || created.StoredAs != "uuid-wave" || created.MimeType != "image/png" {
		t.Errorf("created = %+v, want wave/uuid-wave/image/png", created)
	}
	if created.CreatedAt == "" {
		t.Errorf("created_at is empty")
	}

	byID, err := database.GetEmoji(ctx, created.ID)
	if err != nil || byID == nil {
		t.Fatalf("GetEmoji = %v, %v", byID, err)
	}
	if byID.StoredAs != "uuid-wave" {
		t.Errorf("GetEmoji.StoredAs = %q, want uuid-wave", byID.StoredAs)
	}

	byCode, err := database.GetEmojiByShortcode(ctx, "wave")
	if err != nil || byCode == nil {
		t.Fatalf("GetEmojiByShortcode = %v, %v", byCode, err)
	}
	if byCode.ID != created.ID {
		t.Errorf("GetEmojiByShortcode.ID = %d, want %d", byCode.ID, created.ID)
	}

	deleted, err := database.DeleteEmoji(ctx, created.ID)
	if err != nil {
		t.Fatalf("DeleteEmoji: %v", err)
	}
	if !deleted {
		t.Errorf("DeleteEmoji reported no row removed")
	}
	// A second delete of the same id must report false rather than pretending.
	again, err := database.DeleteEmoji(ctx, created.ID)
	if err != nil {
		t.Fatalf("second DeleteEmoji: %v", err)
	}
	if again {
		t.Errorf("second DeleteEmoji reported a removal")
	}
}

func TestEmojiMissingRowsAreNilNotError(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()

	e, err := database.GetEmoji(ctx, 999)
	if err != nil {
		t.Fatalf("GetEmoji(missing): %v", err)
	}
	if e != nil {
		t.Errorf("GetEmoji(missing) = %v, want nil", e)
	}

	e, err = database.GetEmojiByShortcode(ctx, "nosuch")
	if err != nil {
		t.Fatalf("GetEmojiByShortcode(missing): %v", err)
	}
	if e != nil {
		t.Errorf("GetEmojiByShortcode(missing) = %v, want nil", e)
	}
}

func TestListEmojiIsOrderedAndEmptySliceWhenNone(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	uploader := seedEmojiUploader(t, database)

	list, err := database.ListEmoji(ctx)
	if err != nil {
		t.Fatalf("ListEmoji: %v", err)
	}
	if list == nil || len(list) != 0 {
		t.Fatalf("ListEmoji on an empty table = %v, want an empty slice", list)
	}

	for _, sc := range []string{"zulu", "alpha", "mike"} {
		if _, err := database.CreateEmoji(ctx, sc, "uuid-"+sc, "image/png", uploader); err != nil {
			t.Fatalf("CreateEmoji(%s): %v", sc, err)
		}
	}
	list, err = database.ListEmoji(ctx)
	if err != nil {
		t.Fatalf("ListEmoji: %v", err)
	}
	want := []string{"alpha", "mike", "zulu"}
	if len(list) != len(want) {
		t.Fatalf("len(list) = %d, want %d", len(list), len(want))
	}
	for i, sc := range want {
		if list[i].Shortcode != sc {
			t.Errorf("list[%d] = %q, want %q", i, list[i].Shortcode, sc)
		}
	}
}

func TestCreateEmojiRejectsDuplicateShortcode(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	uploader := seedEmojiUploader(t, database)

	if _, err := database.CreateEmoji(ctx, "wave", "uuid-a", "image/png", uploader); err != nil {
		t.Fatalf("first CreateEmoji: %v", err)
	}
	// The table's UNIQUE index is the backstop behind the service's own
	// pre-check, so a lost race still cannot produce two :wave: rows.
	if _, err := database.CreateEmoji(ctx, "wave", "uuid-b", "image/gif", uploader); err == nil {
		t.Fatalf("duplicate CreateEmoji succeeded, want a uniqueness error")
	}
}
