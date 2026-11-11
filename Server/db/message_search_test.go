package db_test

import (
	"context"
	"slices"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// ─── SearchMessages ───────────────────────────────────────────────────────────

func TestSearchMessages_FindsMatch(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "zara")
	chID := seedChannel(t, database, "searchch")

	_, _ = database.CreateMessage(context.Background(), chID, userID, "hello world fts test", nil)
	_, _ = database.CreateMessage(context.Background(), chID, userID, "unrelated content here", nil)

	results, err := database.SearchMessages(context.Background(), "hello", nil, db.SearchPage{Limit: 10})
	mustDo(t, "SearchMessages", err)
	if len(results) != 1 {
		t.Errorf("expected 1 result, got %d", len(results))
	}
	if results[0].Content != "hello world fts test" {
		t.Errorf("Content = %q, want 'hello world fts test'", results[0].Content)
	}
}

func TestSearchMessages_NFDQueryFindsNFCMessage(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "zara")
	chID := seedChannel(t, database, "searchch")

	_, _ = database.CreateMessage(context.Background(), chID, userID, "my r\u00e9sum\u00e9 draft", nil)

	results, err := database.SearchMessages(context.Background(), "re\u0301sume\u0301", nil, db.SearchPage{Limit: 10})
	mustDo(t, "SearchMessages", err)
	if len(results) != 1 {
		t.Fatalf("NFD query found %d NFC messages, want 1", len(results))
	}
}

func TestSearchMessages_FilterByChannel(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "adam")
	ch1 := seedChannel(t, database, "ch1")
	ch2 := seedChannel(t, database, "ch2")

	_, _ = database.CreateMessage(context.Background(), ch1, userID, "needle in channel 1", nil)
	_, _ = database.CreateMessage(context.Background(), ch2, userID, "needle in channel 2", nil)

	results, _ := database.SearchMessages(context.Background(), "needle", &ch1, db.SearchPage{Limit: 10})
	if len(results) != 1 {
		t.Errorf("expected 1 result in ch1, got %d", len(results))
	}
	if results[0].ChannelID != ch1 {
		t.Errorf("ChannelID = %d, want %d", results[0].ChannelID, ch1)
	}
}

func TestSearchMessages_NoResults(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "beth")
	chID := seedChannel(t, database, "ch")
	_, _ = database.CreateMessage(context.Background(), chID, userID, "hello there", nil)

	results, _ := database.SearchMessages(context.Background(), "xyzzy", nil, db.SearchPage{Limit: 10})
	if len(results) != 0 {
		t.Errorf("expected 0 results, got %d", len(results))
	}
}

func TestSearchMessages_LimitRespected(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "carl")
	chID := seedChannel(t, database, "ch")

	for range 5 {
		_, _ = database.CreateMessage(context.Background(), chID, userID, "searchable keyword content", nil)
	}

	results, _ := database.SearchMessages(context.Background(), "keyword", nil, db.SearchPage{Limit: 3})
	if len(results) != 3 {
		t.Errorf("expected 3 results (limit), got %d", len(results))
	}
}

func TestSearchMessages_DeletedNotReturned(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "diana")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, userID, "vanishing keyword message", nil)
	_ = database.DeleteMessage(context.Background(), id, userID, false)

	results, _ := database.SearchMessages(context.Background(), "vanishing", nil, db.SearchPage{Limit: 10})
	if len(results) != 0 {
		t.Errorf("expected 0 results (deleted excluded), got %d", len(results))
	}
}

// Migration 019 narrows the messages_au trigger to AFTER UPDATE OF content;
// an edit must still reindex the FTS table (old term gone, new term found).
func TestSearchMessages_EditReindexes(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "edith")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, userID, "obsolete wording here", nil)
	if _, err := database.EditMessage(context.Background(), id, userID, "fresh wording here"); err != nil {
		t.Fatalf("EditMessage: %v", err)
	}

	stale, _ := database.SearchMessages(context.Background(), "obsolete", nil, db.SearchPage{Limit: 10})
	if len(stale) != 0 {
		t.Errorf("expected 0 results for pre-edit content, got %d", len(stale))
	}
	updated, _ := database.SearchMessages(context.Background(), "fresh", nil, db.SearchPage{Limit: 10})
	if len(updated) != 1 {
		t.Errorf("expected 1 result for post-edit content, got %d", len(updated))
	}
}

// Pinning updates a non-content column, which the narrowed trigger must
// ignore — the message stays searchable and the FTS index stays consistent.
func TestSearchMessages_PinnedMessageStaysSearchable(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "pinny")
	chID := seedChannel(t, database, "ch")

	id, _ := database.CreateMessage(context.Background(), chID, userID, "pinworthy announcement", nil)
	if _, err := database.SetMessagePinned(context.Background(), db.SetPinnedParams{MessageID: id, Pinned: true, UserID: 1}); err != nil {
		t.Fatalf("SetMessagePinned: %v", err)
	}

	results, err := database.SearchMessages(context.Background(), "pinworthy", nil, db.SearchPage{Limit: 10})
	mustDo(t, "SearchMessages", err)
	if len(results) != 1 {
		t.Errorf("expected pinned message to remain searchable, got %d results", len(results))
	}
}

// OC-0096: sanitizeFTSQuery kept '-' as an allowed bareword character, but in
// FTS5's MATCH grammar '-' introduces a column filter ("-col: expr"), so
// "well-known" parses as "well" followed by a filter on a nonexistent column
// "known" and SQLite raises "no such column: known" instead of matching.
func TestSearchMessages_HyphenatedQuery(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "hyphenuser")
	chID := seedChannel(t, database, "hyphench")

	_, _ = database.CreateMessage(context.Background(), chID, userID, "a well-known fact", nil)

	results, err := database.SearchMessages(context.Background(), "well-known", nil, db.SearchPage{Limit: 10})
	if err != nil {
		t.Fatalf("SearchMessages(%q): %v", "well-known", err)
	}
	if len(results) != 1 {
		t.Errorf("expected 1 result, got %d", len(results))
	}
}

// OC-0002: sanitizeFTSQuery only filters characters, not FTS5's bareword
// boolean keywords (AND, OR, NOT). A query consisting of (or containing) one
// of those keywords in an operator position makes SQLite raise an
// "fts5: syntax error", which SearchMessages surfaces as an error (mapped by
// the service layer to a 500) instead of returning zero results.
func TestSearchMessages_BooleanKeywordQuery(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "booleanuser")
	chID := seedChannel(t, database, "booleanch")

	_, _ = database.CreateMessage(context.Background(), chID, userID, "hello world", nil)

	for _, q := range []string{"AND", "OR", "NOT", "AND world", "hello AND"} {
		if _, err := database.SearchMessages(context.Background(), q, nil, db.SearchPage{Limit: 10}); err != nil {
			t.Errorf("SearchMessages(%q): unexpected error: %v", q, err)
		}
	}
}

// Same root cause as TestSearchMessages_BooleanKeywordQuery, but through the
// SearchMessagesInChannels caller, which sanitizes with the same
// sanitizeFTSQuery helper.
func TestSearchMessagesInChannels_BooleanKeywordQuery(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "boolchanuser")
	chID := seedChannel(t, database, "boolchanch")

	_, _ = database.CreateMessage(context.Background(), chID, userID, "hello world", nil)

	for _, q := range []string{"AND", "OR", "NOT", "AND world", "hello AND"} {
		if _, err := database.SearchMessagesInChannels(context.Background(), q, []int64{chID}, db.SearchPage{Limit: 10}); err != nil {
			t.Errorf("SearchMessagesInChannels(%q): unexpected error: %v", q, err)
		}
	}
}

// DP-20: the last term of a query is a prefix, so a half-typed word still
// finds the message ("deplo" finds "deploy"). Only the last term: earlier
// ones were finished words when the user typed past them.
func TestSearchMessages_LastTermIsAPrefix(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "prefixuser")
	chID := seedChannel(t, database, "prefixch")

	_, _ = database.CreateMessage(context.Background(), chID, userID, "please deploy the app", nil)

	for _, q := range []string{"deplo", "app deplo", "please-dep"} {
		results, err := database.SearchMessages(context.Background(), q, nil, db.SearchPage{Limit: 10})
		if err != nil {
			t.Fatalf("SearchMessages(%q): %v", q, err)
		}
		if len(results) != 1 {
			t.Errorf("SearchMessages(%q) = %d results, want 1", q, len(results))
		}
		results, err = database.SearchMessagesInChannels(context.Background(), q, []int64{chID}, db.SearchPage{Limit: 10})
		if err != nil {
			t.Fatalf("SearchMessagesInChannels(%q): %v", q, err)
		}
		if len(results) != 1 {
			t.Errorf("SearchMessagesInChannels(%q) = %d results, want 1", q, len(results))
		}
	}

	results, err := database.SearchMessages(context.Background(), "deplo app", nil, db.SearchPage{Limit: 10})
	if err != nil {
		t.Fatalf("SearchMessages(%q): %v", "deplo app", err)
	}
	if len(results) != 0 {
		t.Errorf("SearchMessages(%q) = %d results, want 0: only the last term is a prefix", "deplo app", len(results))
	}
}

// DP-20: a last term shorter than three runes matches only that exact word,
// so "de" does not find "deploy" but still finds the word "de"; three runes
// are enough to prefix.
func TestSearchMessages_ShortLastTermIsExact(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "shortuser")
	chID := seedChannel(t, database, "shortch")

	_, _ = database.CreateMessage(context.Background(), chID, userID, "please deploy the app", nil)
	_, _ = database.CreateMessage(context.Background(), chID, userID, "ciao de mi amigo", nil)

	for q, want := range map[string]int{"de": 1, "please de": 0, "dep": 1} {
		results, err := database.SearchMessagesInChannels(context.Background(), q, []int64{chID}, db.SearchPage{Limit: 10})
		if err != nil {
			t.Fatalf("SearchMessagesInChannels(%q): %v", q, err)
		}
		if len(results) != want {
			t.Errorf("SearchMessagesInChannels(%q) = %d results, want %d", q, len(results), want)
		}
	}
}

// DP-20: a Recent page is newest first, and Before keeps only ids strictly
// below the cursor.
func TestSearchMessages_RecentBeforeCursor(t *testing.T) {
	database := openMigratedMemory(t)
	userID := seedUser(t, database, "cursoruser")
	chID := seedChannel(t, database, "cursorch")

	ids := make([]int64, 5)
	for i := range ids {
		ids[i], _ = database.CreateMessage(context.Background(), chID, userID, "cursorword message", nil)
	}
	want := []int64{ids[2], ids[1], ids[0]}

	check := func(name string, got []db.MessageSearchResult, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		gotIDs := make([]int64, len(got))
		for i, r := range got {
			gotIDs[i] = r.MessageID
		}
		if !slices.Equal(gotIDs, want) {
			t.Errorf("%s ids = %v, want %v", name, gotIDs, want)
		}
	}
	page := db.SearchPage{Limit: 10, Recent: true, Before: ids[3]}
	got, err := database.SearchMessages(context.Background(), "cursorword", &chID, page)
	check("SearchMessages", got, err)
	got, err = database.SearchMessagesInChannels(context.Background(), "cursorword", []int64{chID}, page)
	check("SearchMessagesInChannels", got, err)
}
