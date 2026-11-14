package db_test

import (
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func lpImage(hash string, size int64, stamp string) db.LinkPreviewImage {
	return db.LinkPreviewImage{Hash: hash, MimeType: "image/webp", Size: size, Width: 4, Height: 3, CreatedAt: stamp, LastUsedAt: stamp}
}

func TestLinkPreviewCardAndImageRows(t *testing.T) {
	ctx := t.Context()
	database := openMigratedMemory(t)

	if _, err := database.GetLinkPreview(ctx, "nope"); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("GetLinkPreview(missing) err = %v, want ErrNotFound", err)
	}
	if _, err := database.GetLinkPreviewImage(ctx, "nope"); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("GetLinkPreviewImage(missing) err = %v, want ErrNotFound", err)
	}
	if ok, err := database.LinkPreviewImageExists(ctx, "img1"); err != nil || ok {
		t.Errorf("LinkPreviewImageExists(missing) = %v, %v", ok, err)
	}

	mustDo(t, "insert image", database.InsertLinkPreviewImage(ctx, lpImage("img1", 10, "2030-01-01T00:00:00Z")))
	// The same hash again only refreshes last_used_at.
	again := lpImage("img1", 99, "2030-01-02T00:00:00Z")
	mustDo(t, "reinsert image", database.InsertLinkPreviewImage(ctx, again))
	img, err := database.GetLinkPreviewImage(ctx, "img1")
	mustDo(t, "GetLinkPreviewImage", err)
	if img.Size != 10 || img.CreatedAt != "2030-01-01T00:00:00Z" || img.LastUsedAt != "2030-01-02T00:00:00Z" {
		t.Errorf("image after reinsert = %+v", img)
	}
	if ok, err := database.LinkPreviewImageExists(ctx, "img1"); err != nil || !ok {
		t.Errorf("LinkPreviewImageExists = %v, %v", ok, err)
	}
	mustDo(t, "touch image", database.TouchLinkPreviewImage(ctx, "img1", "2030-02-01T00:00:00Z"))
	if img, _ = database.GetLinkPreviewImage(ctx, "img1"); img.LastUsedAt != "2030-02-01T00:00:00Z" {
		t.Errorf("touched image = %+v", img)
	}

	card := db.LinkPreview{UrlHash: "u1", Url: "https://example.com/", Title: new("T"), ImageHash: new("img1"), FetchedAt: "2030-01-01T00:00:00Z", LastUsedAt: "2030-01-01T00:00:00Z"}
	mustDo(t, "upsert", database.UpsertLinkPreview(ctx, card))
	card.Title = new("T2")
	card.Failure = new("unavailable")
	mustDo(t, "re-upsert", database.UpsertLinkPreview(ctx, card))
	got, err := database.GetLinkPreview(ctx, "u1")
	mustDo(t, "GetLinkPreview", err)
	if *got.Title != "T2" || got.Failure == nil || *got.Failure != "unavailable" {
		t.Errorf("card after re-upsert = %+v", got)
	}
	mustDo(t, "touch card", database.TouchLinkPreview(ctx, "u1", "2030-03-01T00:00:00Z"))
	if got, _ = database.GetLinkPreview(ctx, "u1"); got.LastUsedAt != "2030-03-01T00:00:00Z" {
		t.Errorf("touched card = %+v", got)
	}
	// A card naming a missing image breaks the foreign key.
	bad := db.LinkPreview{UrlHash: "u2", Url: "https://x/", ImageHash: new("missing"), FetchedAt: "t", LastUsedAt: "t"}
	if err := database.UpsertLinkPreview(ctx, bad); err == nil {
		t.Error("UpsertLinkPreview with a missing image succeeded")
	}
}

func TestLinkPreviewImageListsAndDelete(t *testing.T) {
	ctx := t.Context()
	database := openMigratedMemory(t)

	if total, err := database.SumLinkPreviewImageBytes(ctx); err != nil || total != 0 {
		t.Fatalf("empty sum = %d, %v", total, err)
	}
	for i, h := range []string{"a", "b", "c"} {
		stamp := "2030-01-0" + string(rune('1'+i)) + "T00:00:00Z"
		mustDo(t, "insert", database.InsertLinkPreviewImage(ctx, lpImage(h, int64(10*(i+1)), stamp)))
	}
	mustDo(t, "card", database.UpsertLinkPreview(ctx, db.LinkPreview{UrlHash: "u", Url: "https://x/", ImageHash: new("c"), FetchedAt: "t", LastUsedAt: "t"}))

	if total, err := database.SumLinkPreviewImageBytes(ctx); err != nil || total != 60 {
		t.Errorf("sum = %d, %v; want 60", total, err)
	}
	oldest, err := database.ListOldestLinkPreviewImages(ctx, 2)
	mustDo(t, "oldest", err)
	if len(oldest) != 2 || oldest[0].Hash != "a" || oldest[1].Hash != "b" || oldest[0].Size != 10 {
		t.Errorf("oldest = %+v", oldest)
	}
	unused, err := database.ListLinkPreviewImagesUnusedBefore(ctx, "2030-01-03T00:00:00Z", 10)
	mustDo(t, "unused", err)
	if len(unused) != 2 || unused[0].Hash != "a" {
		t.Errorf("unused = %+v", unused)
	}
	// c is named by a card; a and b are not.
	unref, err := database.ListUnreferencedLinkPreviewImages(ctx, "2031-01-01T00:00:00Z", 10)
	mustDo(t, "unreferenced", err)
	if len(unref) != 2 || unref[0].Hash != "a" || unref[1].Hash != "b" {
		t.Errorf("unreferenced = %+v", unref)
	}
	if none, err := database.ListUnreferencedLinkPreviewImages(ctx, "2000-01-01T00:00:00Z", 10); err != nil || len(none) != 0 {
		t.Errorf("unreferenced before any use = %+v, %v", none, err)
	}

	if ok, err := database.DeleteLinkPreviewImage(ctx, "c"); err != nil || !ok {
		t.Errorf("DeleteLinkPreviewImage = %v, %v", ok, err)
	}
	if ok, err := database.DeleteLinkPreviewImage(ctx, "c"); err != nil || ok {
		t.Errorf("second delete = %v, %v; want false", ok, err)
	}
	// The card keeps its text and loses the image link.
	card, err := database.GetLinkPreview(ctx, "u")
	if err != nil || card.ImageHash != nil {
		t.Errorf("card after image delete = %+v, %v", card, err)
	}
}

func TestLinkPreviewMessageLinks(t *testing.T) {
	ctx := t.Context()
	database := openMigratedMemory(t)
	uid := seedUser(t, database, "lp-user")
	cid := seedChannel(t, database, "lp-chan")
	mid, err := database.CreateMessage(ctx, cid, uid, "hello", nil)
	mustDo(t, "CreateMessage", err)
	var version string
	mustDo(t, "version", database.QueryRowContext(ctx, `SELECT COALESCE(edited_at, timestamp) FROM messages WHERE id = ?`, mid).Scan(&version))

	mustDo(t, "image", database.InsertLinkPreviewImage(ctx, lpImage("img", 5, "2030-01-01T00:00:00Z")))
	for _, h := range []string{"u1", "u2"} {
		mustDo(t, "card", database.UpsertLinkPreview(ctx, db.LinkPreview{UrlHash: h, Url: "https://x/" + h, Title: new(h), ImageHash: new("img"), FetchedAt: "t", LastUsedAt: "t"}))
	}

	if cards, err := database.ListLinkPreviewsForMessages(ctx, nil); err != nil || cards == nil || len(cards) != 0 {
		t.Errorf("no ids = %v, %v; want empty non-nil", cards, err)
	}
	if cards, err := database.ListMessageLinkPreviews(ctx, mid); err != nil || len(cards) != 0 {
		t.Errorf("before any write = %v, %v", cards, err)
	}

	ok, err := database.ReplaceMessageLinkPreviews(ctx, mid, version, "hello", "2030-01-01T00:00:00Z", []string{"u2", "u1"})
	if err != nil || !ok {
		t.Fatalf("Replace = %v, %v", ok, err)
	}
	cards, err := database.ListMessageLinkPreviews(ctx, mid)
	mustDo(t, "list", err)
	if len(cards) != 2 || cards[0].UrlHash != "u2" || cards[1].UrlHash != "u1" || cards[0].ImageMimeType == nil || *cards[0].ImageWidth != 4 {
		t.Errorf("cards = %+v", cards)
	}
	batch, err := database.ListLinkPreviewsForMessages(ctx, []int64{mid, mid + 1})
	mustDo(t, "batch", err)
	if len(batch) != 2 || batch[0].MessageID != mid || batch[1].Position != 1 {
		t.Errorf("batch = %+v", batch)
	}

	// Wrong version, wrong text, then a hash with no card (which rolls the whole write back).
	if ok, err := database.ReplaceMessageLinkPreviews(ctx, mid, "other", "hello", "t", nil); err != nil || ok {
		t.Errorf("wrong version = %v, %v", ok, err)
	}
	if ok, err := database.ReplaceMessageLinkPreviews(ctx, mid, version, "changed", "t", nil); err != nil || ok {
		t.Errorf("wrong text = %v, %v", ok, err)
	}
	if ok, err := database.ReplaceMessageLinkPreviews(ctx, mid, version, "hello", "t", []string{"u1", "ghost"}); err == nil || ok {
		t.Errorf("unknown hash = %v, %v; want an error", ok, err)
	}
	if cards, _ = database.ListMessageLinkPreviews(ctx, mid); len(cards) != 2 {
		t.Errorf("a failed write changed the links: %+v", cards)
	}
}

func TestLinkPreviewQueriesFailOnClosedDB(t *testing.T) {
	ctx := t.Context()
	database := openMigratedMemory(t)
	mustDo(t, "close", database.Close())
	checks := map[string]error{}
	_, checks["GetLinkPreview"] = database.GetLinkPreview(ctx, "h")
	checks["UpsertLinkPreview"] = database.UpsertLinkPreview(ctx, db.LinkPreview{UrlHash: "h"})
	checks["TouchLinkPreview"] = database.TouchLinkPreview(ctx, "h", "t")
	_, checks["GetLinkPreviewImage"] = database.GetLinkPreviewImage(ctx, "h")
	_, checks["LinkPreviewImageExists"] = database.LinkPreviewImageExists(ctx, "h")
	checks["InsertLinkPreviewImage"] = database.InsertLinkPreviewImage(ctx, db.LinkPreviewImage{Hash: "h"})
	checks["TouchLinkPreviewImage"] = database.TouchLinkPreviewImage(ctx, "h", "t")
	_, checks["ListMessageLinkPreviews"] = database.ListMessageLinkPreviews(ctx, 1)
	_, checks["ListLinkPreviewsForMessages"] = database.ListLinkPreviewsForMessages(ctx, []int64{1})
	_, checks["ReplaceMessageLinkPreviews"] = database.ReplaceMessageLinkPreviews(ctx, 1, "v", "c", "t", nil)
	_, checks["SumLinkPreviewImageBytes"] = database.SumLinkPreviewImageBytes(ctx)
	_, checks["ListOldestLinkPreviewImages"] = database.ListOldestLinkPreviewImages(ctx, 1)
	_, checks["ListLinkPreviewImagesUnusedBefore"] = database.ListLinkPreviewImagesUnusedBefore(ctx, "t", 1)
	_, checks["ListUnreferencedLinkPreviewImages"] = database.ListUnreferencedLinkPreviewImages(ctx, "t", 1)
	_, checks["DeleteLinkPreviewImage"] = database.DeleteLinkPreviewImage(ctx, "h")
	for name, err := range checks {
		if err == nil {
			t.Errorf("%s on a closed database returned no error", name)
		}
	}
}

func TestLinkPreviewTouchAndPrune(t *testing.T) {
	ctx := t.Context()
	database := openMigratedMemory(t)
	uid := seedUser(t, database, "lp-prune")
	cid := seedChannel(t, database, "lp-prune-chan")
	mid, err := database.CreateMessage(ctx, cid, uid, "hi", nil)
	mustDo(t, "CreateMessage", err)
	var version string
	mustDo(t, "version", database.QueryRowContext(ctx, `SELECT COALESCE(edited_at, timestamp) FROM messages WHERE id = ?`, mid).Scan(&version))

	old := "2000-01-01T00:00:00Z"
	mustDo(t, "image", database.InsertLinkPreviewImage(ctx, lpImage("img", 5, old)))
	for _, h := range []string{"kept", "gone", "touched"} {
		mustDo(t, "card", database.UpsertLinkPreview(ctx, db.LinkPreview{UrlHash: h, Url: "https://x/" + h, FetchedAt: old, LastUsedAt: old}))
	}
	ok, err := database.ReplaceMessageLinkPreviews(ctx, mid, version, "hi", old, []string{"kept"})
	if err != nil || !ok {
		t.Fatalf("Replace = %v, %v", ok, err)
	}
	mustDo(t, "touch cards", database.TouchLinkPreviews(ctx, []string{"touched"}, "2030-01-01T00:00:00Z"))
	mustDo(t, "touch none", database.TouchLinkPreviews(ctx, nil, "x"))
	mustDo(t, "touch images", database.TouchLinkPreviewImages(ctx, []string{"img"}, "2030-01-01T00:00:00Z"))
	mustDo(t, "touch no images", database.TouchLinkPreviewImages(ctx, nil, "x"))
	if img, err := database.GetLinkPreviewImage(ctx, "img"); err != nil || img.LastUsedAt != "2030-01-01T00:00:00Z" {
		t.Errorf("image after touch = %+v, %v", img, err)
	}

	n, err := database.DeleteUnreferencedLinkPreviews(ctx, "2010-01-01T00:00:00Z")
	if err != nil || n != 1 {
		t.Fatalf("prune = %d, %v; want 1 (the old unreferenced card)", n, err)
	}
	if _, err := database.GetLinkPreview(ctx, "gone"); !errors.Is(err, db.ErrNotFound) {
		t.Errorf("gone card err = %v; want ErrNotFound", err)
	}
	for _, h := range []string{"kept", "touched"} {
		if _, err := database.GetLinkPreview(ctx, h); err != nil {
			t.Errorf("card %s: %v", h, err)
		}
	}
}
