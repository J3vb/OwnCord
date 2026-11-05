package db_test

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

func gifFavUser(t *testing.T, d *db.DB, name string) int64 {
	t.Helper()
	uid, err := d.CreateUser(context.Background(), name, "x", 4)
	mustDo(t, "CreateUser", err)
	return uid
}

func TestGIFFavorites_AddListRemoveNewestFirst(t *testing.T) {
	d := openMigratedMemory(t)
	ctx := context.Background()
	uid := gifFavUser(t, d, "alice")

	for _, n := range []string{"a", "b", "c"} {
		f := db.GIFFavorite{URL: "https://media.klipy.com/" + n + ".gif", PreviewURL: "https://media.klipy.com/" + n + "_t.gif", Title: n}
		if err := d.AddGIFFavorite(ctx, uid, f); err != nil {
			t.Fatalf("add %s: %v", n, err)
		}
	}
	got, err := d.ListGIFFavorites(ctx, uid)
	mustDo(t, "list", err)
	if len(got) != 3 || got[0].Title != "c" || got[2].Title != "a" {
		t.Fatalf("want newest first c,b,a; got %+v", got)
	}

	mustDo(t, "remove", d.RemoveGIFFavorite(ctx, uid, "https://media.klipy.com/b.gif"))
	got, _ = d.ListGIFFavorites(ctx, uid)
	if len(got) != 2 {
		t.Fatalf("after remove: %d rows, want 2", len(got))
	}
}

func TestGIFFavorites_AddIsIdempotentAndPerUser(t *testing.T) {
	d := openMigratedMemory(t)
	ctx := context.Background()
	a, b := gifFavUser(t, d, "alice"), gifFavUser(t, d, "bob")
	f := db.GIFFavorite{URL: "https://media.klipy.com/a.gif", PreviewURL: "https://media.klipy.com/a_t.gif"}
	for range 2 {
		mustDo(t, "add", d.AddGIFFavorite(ctx, a, f))
	}
	mustDo(t, "add other user", d.AddGIFFavorite(ctx, b, f))
	if got, _ := d.ListGIFFavorites(ctx, a); len(got) != 1 {
		t.Errorf("alice has %d, want 1", len(got))
	}
	mustDo(t, "RemoveGIFFavorite", d.RemoveGIFFavorite(ctx, a, f.URL))
	if got, _ := d.ListGIFFavorites(ctx, b); len(got) != 1 {
		t.Errorf("bob lost his favorite when alice removed hers")
	}
}

func TestGIFFavorites_CapRefusesNewButAllowsExisting(t *testing.T) {
	d := openMigratedMemory(t)
	ctx := context.Background()
	uid := gifFavUser(t, d, "alice")
	for i := range db.MaxGIFFavorites {
		u := fmt.Sprintf("https://media.klipy.com/%d.gif", i)
		if err := d.AddGIFFavorite(ctx, uid, db.GIFFavorite{URL: u, PreviewURL: u}); err != nil {
			t.Fatalf("add %d: %v", i, err)
		}
	}
	over := db.GIFFavorite{URL: "https://media.klipy.com/over.gif", PreviewURL: "https://media.klipy.com/over.gif"}
	if err := d.AddGIFFavorite(ctx, uid, over); !errors.Is(err, db.ErrGIFFavoritesFull) {
		t.Fatalf("over cap err = %v, want ErrGIFFavoritesFull", err)
	}
	again := db.GIFFavorite{URL: "https://media.klipy.com/0.gif", PreviewURL: "https://media.klipy.com/0.gif"}
	mustDo(t, "re-adding an existing favorite at the cap must succeed", d.AddGIFFavorite(ctx, uid, again))
}
