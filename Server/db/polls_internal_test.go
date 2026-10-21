package db

import (
	"context"
	"testing"
)

func TestAttachPolls_DeletedHidden(t *testing.T) {
	database := openMigratedMemoryInternal(t)
	ctx := context.Background()
	u, err := database.CreateUser(ctx, "pa", "hash", 4)
	if err != nil {
		t.Fatal(err)
	}
	ch, err := database.CreateChannel(ctx, "general", "text", "", "", 0)
	if err != nil {
		t.Fatal(err)
	}
	id, err := database.CreateMessage(ctx, ch, u, "poll", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		`INSERT INTO polls (message_id, question, expires_at) VALUES (?1, 'q', '2999-01-01T00:00:00Z')`,
		`INSERT INTO poll_answers (message_id, answer_id, text) VALUES (?1, 1, 'a'), (?1, 2, 'b')`,
	} {
		if _, err := database.ExecContext(ctx, q, id); err != nil {
			t.Fatal(err)
		}
	}
	msgs := []MessageAPIResponse{{ID: id, Deleted: true}, {ID: id, Kind: "call"}}
	if err := database.attachPolls(ctx, msgs, 0); err != nil {
		t.Fatal(err)
	}
	if msgs[0].Poll != nil {
		t.Error("a deleted poll still carries its block")
	}
	if msgs[1].Poll != nil {
		t.Error("a system row carries a poll block")
	}
	live := []MessageAPIResponse{{ID: id}}
	if err := database.attachPolls(ctx, live, 0); err != nil || live[0].Poll == nil {
		t.Fatalf("live row: poll = %v, err = %v", live[0].Poll, err)
	}
}

func TestAttachPolls_NoCandidatesNoQuery(t *testing.T) {
	database := openMigratedMemoryInternal(t)
	// A page of deleted and system rows is answered without touching the
	// tables, which a closed database would otherwise fail.
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	msgs := []MessageAPIResponse{{ID: 1, Deleted: true}, {ID: 2, Kind: "call"}}
	if err := database.attachPolls(context.Background(), msgs, 7); err != nil {
		t.Fatalf("attachPolls on a page with no live ordinary rows = %v, want nil", err)
	}
}
