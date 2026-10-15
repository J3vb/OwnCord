package db_test

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// seedReactionFixture creates users 1..n and a message from user 1.
func seedReactionFixture(t *testing.T, database *db.DB, users int) int64 {
	t.Helper()
	ctx := context.Background()
	for i := range users {
		if _, err := database.CreateUser(ctx, "reactor"+strconv.Itoa(i), "hash", 4); err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
	}
	if _, err := database.CreateChannel(ctx, "general", "text", "", "", 0); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
	msgID, err := database.CreateMessage(ctx, 1, 1, "hello", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	return msgID
}

// fillDistinct adds n distinct emoji "e0".."e{n-1}" from user 1.
func fillDistinct(t *testing.T, database *db.DB, msgID int64, n int) {
	t.Helper()
	for i := range n {
		if err := database.AddReaction(context.Background(), msgID, 1, "e"+strconv.Itoa(i)); err != nil {
			t.Fatalf("AddReaction(e%d): %v", i, err)
		}
	}
}

func TestAddReaction_CapRefusesNewDistinctAt20(t *testing.T) {
	database := openMigratedMemory(t)
	msgID := seedReactionFixture(t, database, 2)
	fillDistinct(t, database, msgID, db.MaxDistinctReactions)

	err := database.AddReaction(context.Background(), msgID, 2, "new")
	if !errors.Is(err, db.ErrReactionLimit) {
		t.Fatalf("AddReaction(new) = %v, want ErrReactionLimit", err)
	}
	counts, err := database.GetReactions(context.Background(), msgID)
	if err != nil || len(counts) != db.MaxDistinctReactions {
		t.Errorf("distinct emoji = %d (err %v), want %d", len(counts), err, db.MaxDistinctReactions)
	}
}

func TestAddReaction_AllowsExistingEmojiAtCap(t *testing.T) {
	database := openMigratedMemory(t)
	msgID := seedReactionFixture(t, database, 2)
	fillDistinct(t, database, msgID, db.MaxDistinctReactions)

	if err := database.AddReaction(context.Background(), msgID, 2, "e3"); err != nil {
		t.Fatalf("AddReaction(existing emoji) at cap: %v", err)
	}
}

func TestAddReaction_DuplicateStillConflictAtCap(t *testing.T) {
	database := openMigratedMemory(t)
	msgID := seedReactionFixture(t, database, 1)
	fillDistinct(t, database, msgID, db.MaxDistinctReactions)

	err := database.AddReaction(context.Background(), msgID, 1, "e3")
	if err == nil {
		t.Fatal("duplicate reaction accepted")
	}
	if errors.Is(err, db.ErrReactionLimit) {
		t.Errorf("duplicate at cap = %v, want the unique-constraint failure, not ErrReactionLimit", err)
	}
}

func TestAddReaction_CountsDistinctNotRows(t *testing.T) {
	database := openMigratedMemory(t)
	msgID := seedReactionFixture(t, database, 30)
	ctx := context.Background()
	// 19 distinct emoji, each reacted by many users: rows far exceed 20.
	for i := 1; i <= 30; i++ {
		for e := range db.MaxDistinctReactions - 1 {
			if err := database.AddReaction(ctx, msgID, int64(i), "e"+strconv.Itoa(e)); err != nil {
				t.Fatalf("AddReaction(user %d, e%d): %v", i, e, err)
			}
		}
	}
	if err := database.AddReaction(ctx, msgID, 1, "twentieth"); err != nil {
		t.Fatalf("the 20th distinct emoji was refused: %v", err)
	}
	if err := database.AddReaction(ctx, msgID, 1, "twenty-first"); !errors.Is(err, db.ErrReactionLimit) {
		t.Fatalf("the 21st distinct emoji = %v, want ErrReactionLimit", err)
	}
}

func TestAddReaction_CapRaceNeverExceeds20(t *testing.T) {
	database := openMigratedMemory(t)
	const racers = 10
	msgID := seedReactionFixture(t, database, racers+1)
	fillDistinct(t, database, msgID, db.MaxDistinctReactions-1)

	var wg sync.WaitGroup
	errs := make([]error, racers)
	start := make(chan struct{})
	for i := range racers {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			errs[i] = database.AddReaction(context.Background(), msgID, int64(i+2), "race"+strconv.Itoa(i))
		}(i)
	}
	close(start)
	wg.Wait()

	won, refused := 0, 0
	for _, err := range errs {
		switch {
		case err == nil:
			won++
		case errors.Is(err, db.ErrReactionLimit):
			refused++
		default:
			t.Errorf("unexpected error: %v", err)
		}
	}
	if won != 1 || refused != racers-1 {
		t.Errorf("won = %d, refused = %d, want 1 and %d", won, refused, racers-1)
	}
	counts, err := database.GetReactions(context.Background(), msgID)
	if err != nil || len(counts) != db.MaxDistinctReactions {
		t.Errorf("distinct emoji = %d (err %v), want exactly %d", len(counts), err, db.MaxDistinctReactions)
	}
}
