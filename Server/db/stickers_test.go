package db_test

import (
	"context"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func TestStickerCRUDRoundTrip(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "sticker-uploader")

	wave := "👋"
	created, err := database.CreateSticker(ctx, "Wave", &wave, "uuid-wave", "image/gif", uid)
	if err != nil || created.ID == 0 || created.Name != "Wave" || created.StoredAs != "uuid-wave" || created.Emoji == nil || *created.Emoji != "👋" {
		t.Fatalf("CreateSticker = %+v, %v", created, err)
	}
	byName, err := database.GetStickerByName(ctx, "wAvE")
	if err != nil || byName == nil || byName.ID != created.ID {
		t.Fatalf("GetStickerByName is not case-insensitive: %+v, %v", byName, err)
	}
	if _, err := database.CreateSticker(ctx, "WAVE", nil, "uuid-2", "image/png", uid); !db.IsUniqueConstraintError(err) {
		t.Fatalf("a case-variant name = %v, want a unique-constraint error", err)
	}
	if _, err := database.CreateSticker(ctx, "Alpha", nil, "uuid-3", "image/png", uid); err != nil {
		t.Fatal(err)
	}
	list, err := database.ListStickers(ctx)
	if err != nil || len(list) != 2 || list[0].Name != "Alpha" || list[1].Name != "Wave" {
		t.Fatalf("ListStickers = %+v, %v; want name order", list, err)
	}
	if n, err := database.CountStickers(ctx); err != nil || n != 2 {
		t.Errorf("CountStickers = %d, %v", n, err)
	}

	updated, err := database.UpdateSticker(ctx, created.ID, "Hello", nil)
	if err != nil || updated == nil || updated.Name != "Hello" || updated.Emoji != nil || updated.StoredAs != "uuid-wave" {
		t.Fatalf("UpdateSticker = %+v, %v", updated, err)
	}
	if missing, err := database.UpdateSticker(ctx, 999, "Nope", nil); err != nil || missing != nil {
		t.Errorf("UpdateSticker(missing) = %+v, %v; want nil, nil", missing, err)
	}
	if ok, err := database.DeleteSticker(ctx, created.ID); err != nil || !ok {
		t.Fatalf("DeleteSticker = %v, %v", ok, err)
	}
	if ok, err := database.DeleteSticker(ctx, created.ID); err != nil || ok {
		t.Errorf("second DeleteSticker = %v, %v; want false", ok, err)
	}
	if got, err := database.GetSticker(ctx, created.ID); err != nil || got != nil {
		t.Errorf("GetSticker after delete = %+v, %v", got, err)
	}
}

// A sticker message keeps its name when the sticker is deleted, loses the link,
// and goes with its message.
func TestMessageStickerSurvivesStickerDeleteAndCascadesWithMessage(t *testing.T) {
	database := openMigratedMemory(t)
	ctx := context.Background()
	uid := seedUser(t, database, "sticker-author")
	st, err := database.CreateSticker(ctx, "Wave", nil, "uuid-wave", "image/png", uid)
	if err != nil {
		t.Fatal(err)
	}
	chID := seedChannel(t, database, "stickers")
	msg, err := database.CreateMessageWithMentions(ctx, chID, uid, "[Sticker: Wave]", nil, nil, 0, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, `INSERT INTO message_stickers (message_id, sticker_id, name) VALUES (?, ?, 'Wave')`, msg.ID, st.ID); err != nil {
		t.Fatal(err)
	}

	info, err := database.GetMessageSticker(ctx, msg.ID)
	if err != nil || info == nil || info.ID == nil || *info.ID != st.ID || info.URL == nil || *info.URL != db.StickerImageURL(st.ID) {
		t.Fatalf("GetMessageSticker = %+v, %v", info, err)
	}
	if plain, err := database.GetMessageSticker(ctx, 12345); err != nil || plain != nil {
		t.Errorf("GetMessageSticker(not a sticker message) = %+v, %v", plain, err)
	}

	if ok, err := database.DeleteSticker(ctx, st.ID); err != nil || !ok {
		t.Fatalf("DeleteSticker = %v, %v", ok, err)
	}
	info, err = database.GetMessageSticker(ctx, msg.ID)
	if err != nil || info == nil || info.Name != "Wave" || info.ID != nil || info.URL != nil {
		t.Fatalf("after delete: %+v, %v; want name kept, id and url null", info, err)
	}

	if _, err := database.ExecContext(ctx, `DELETE FROM messages WHERE id = ?`, msg.ID); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM message_stickers`).Scan(&n); err != nil || n != 0 {
		t.Errorf("message_stickers rows after the message went = %d, %v", n, err)
	}
}
