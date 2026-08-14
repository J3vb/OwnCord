package db_test

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/owncord/server/db"
)

// storageMentionCap mirrors the package-internal maxMentionsPerMessage backstop.
const storageMentionCap = 20

// seedMentionFixture creates two users and a text channel for mention tests.
func seedMentionFixture(t *testing.T, database *db.DB) {
	t.Helper()
	ctx := context.Background()
	for _, name := range []string{"alice", "bob", "Carol"} {
		if _, err := database.CreateUser(ctx, name, "hash", 4); err != nil {
			t.Fatalf("CreateUser(%s): %v", name, err)
		}
	}
	if _, err := database.CreateChannel(ctx, "general", "text", "", "", 0); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}
}

func TestCreateMessageWithMentions_StoresRowsAndFlag(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	msg, err := database.CreateMessageWithMentions(ctx, 1, 1, "hi @bob", nil, []int64{2}, true)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	if !msg.MentionsEveryone {
		t.Error("MentionsEveryone = false, want true")
	}

	got, err := database.GetMentionsByMessageIDs(ctx, []int64{msg.ID})
	if err != nil {
		t.Fatalf("GetMentionsByMessageIDs: %v", err)
	}
	if len(got[msg.ID]) != 1 || got[msg.ID][0] != 2 {
		t.Errorf("mentions = %v, want [2]", got[msg.ID])
	}

	// The flag must survive a re-read through the ordinary message getter.
	reread, err := database.GetMessage(ctx, msg.ID)
	if err != nil || reread == nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if !reread.MentionsEveryone {
		t.Error("re-read MentionsEveryone = false, want true")
	}
}

// TestCreateMessageWithMentions_CapsStoredRows locks the storage-side backstop:
// a caller cannot widen the fan-out past storageMentionCap.
func TestCreateMessageWithMentions_CapsStoredRows(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	ids := make([]int64, 0, storageMentionCap+5)
	for i := range storageMentionCap + 5 {
		uid, err := database.CreateUser(ctx, "capped"+string(rune('a'+i)), "hash", 4)
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		ids = append(ids, uid)
	}

	msg, err := database.CreateMessageWithMentions(ctx, 1, 1, "spam", nil, ids, false)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	got, err := database.GetMentionsByMessageIDs(ctx, []int64{msg.ID})
	if err != nil {
		t.Fatalf("GetMentionsByMessageIDs: %v", err)
	}
	if len(got[msg.ID]) != storageMentionCap {
		t.Errorf("stored = %d, want %d", len(got[msg.ID]), storageMentionCap)
	}
}

func TestReplaceMessageMentions(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	msg, err := database.CreateMessageWithMentions(ctx, 1, 1, "hi @bob", nil, []int64{2}, true)
	if err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	if err := database.ReplaceMessageMentions(ctx, msg.ID, []int64{3}, false); err != nil {
		t.Fatalf("ReplaceMessageMentions: %v", err)
	}

	got, err := database.GetMentionsByMessageIDs(ctx, []int64{msg.ID})
	if err != nil {
		t.Fatalf("GetMentionsByMessageIDs: %v", err)
	}
	if len(got[msg.ID]) != 1 || got[msg.ID][0] != 3 {
		t.Errorf("mentions = %v, want [3]", got[msg.ID])
	}
	reread, err := database.GetMessage(ctx, msg.ID)
	if err != nil || reread == nil {
		t.Fatalf("GetMessage: %v", err)
	}
	if reread.MentionsEveryone {
		t.Error("MentionsEveryone = true, want false after replace")
	}
}

func TestIncrementMentionCounts_AndReadStateClear(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	if err := database.IncrementMentionCounts(ctx, 1, 100, []int64{2, 3}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}
	if err := database.IncrementMentionCounts(ctx, 1, 100, []int64{2}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}

	if n, _ := database.GetMentionCount(ctx, 2, 1); n != 2 {
		t.Errorf("user 2 mention_count = %d, want 2", n)
	}
	if n, _ := database.GetMentionCount(ctx, 3, 1); n != 1 {
		t.Errorf("user 3 mention_count = %d, want 1", n)
	}

	// Marking the channel read clears the badge, and only for that user.
	if err := database.UpdateReadState(ctx, 2, 1, 99); err != nil {
		t.Fatalf("UpdateReadState: %v", err)
	}
	if n, _ := database.GetMentionCount(ctx, 2, 1); n != 0 {
		t.Errorf("after read state, user 2 mention_count = %d, want 0", n)
	}
	if n, _ := database.GetMentionCount(ctx, 3, 1); n != 1 {
		t.Errorf("user 3 mention_count = %d, want 1", n)
	}
}

// TestIncrementMentionCounts_BatchesAcrossChunkBoundary exercises the
// multi-row upsert with a recipient count that spans more than one exec
// chunk (mentionCountChunkSize=500), pinning that every recipient still gets
// exactly one increment (or a freshly seeded row) regardless of which chunk
// it landed in — the batching must not drop or double-count a row at the
// boundary.
func TestIncrementMentionCounts_BatchesAcrossChunkBoundary(t *testing.T) {
	database := newMigratedTestDB(t)
	ctx := context.Background()
	if _, err := database.CreateChannel(ctx, "everyone-chan", "text", "", "", 0); err != nil {
		t.Fatalf("CreateChannel: %v", err)
	}

	const n = 520 // > one 500-row chunk, so the run crosses a chunk boundary.
	ids := make([]int64, 0, n)
	for i := range n {
		uid, err := database.CreateUser(ctx, "batchuser"+strconv.Itoa(i), "hash", 4)
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		ids = append(ids, uid)
	}

	if err := database.IncrementMentionCounts(ctx, 1, 1, ids); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}

	for _, uid := range []int64{ids[0], ids[499], ids[500], ids[n-1]} {
		if got, err := database.GetMentionCount(ctx, uid, 1); err != nil || got != 1 {
			t.Errorf("user %d mention_count = %d (err=%v), want 1", uid, got, err)
		}
	}

	// A second pass bumps every one of them again, chunk boundary included.
	// msgID is higher than the first pass's so the read-state guard does not
	// treat this as the same already-seen message.
	if err := database.IncrementMentionCounts(ctx, 1, 2, ids); err != nil {
		t.Fatalf("IncrementMentionCounts (second pass): %v", err)
	}
	for _, uid := range []int64{ids[0], ids[499], ids[500], ids[n-1]} {
		if got, err := database.GetMentionCount(ctx, uid, 1); err != nil || got != 2 {
			t.Errorf("user %d mention_count after second pass = %d (err=%v), want 2", uid, got, err)
		}
	}
}

func TestIncrementMentionCounts_EmptyIsNoop(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	if err := database.IncrementMentionCounts(context.Background(), 1, 1, nil); err != nil {
		t.Fatalf("IncrementMentionCounts(nil): %v", err)
	}
}

// TestIncrementMentionCounts_NoOpWhenReaderAlreadyPastMessage locks OC-0066:
// a mark_read that lands between the message commit and the deferred badge
// increment must not leave a phantom mention_count behind. If the recipient's
// read state already covers the mentioning message (last_message_id >=
// msgID), the increment for that message must be a no-op — otherwise the
// badge is stuck at 1 forever on a channel with zero unread, since nothing
// else ever zeroes it again.
func TestIncrementMentionCounts_NoOpWhenReaderAlreadyPastMessage(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	msgID, err := database.CreateMessage(ctx, 1, 1, "hey @bob", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	// The reader (user 2 = bob) marks the channel read before the deferred
	// badge increment for this same message lands.
	if err := database.UpdateReadState(ctx, 2, 1, msgID); err != nil {
		t.Fatalf("UpdateReadState: %v", err)
	}

	if err := database.IncrementMentionCounts(ctx, 1, msgID, []int64{2}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}

	if n, _ := database.GetMentionCount(ctx, 2, 1); n != 0 {
		t.Errorf("mention_count = %d after a read state that already covers the mentioning message, want 0 (phantom badge)", n)
	}
}

// TestIncrementMentionCounts_StillAppliesWhenReaderIsBehind is the control:
// the guard must not turn every increment into a no-op — a reader who has NOT
// read up to msgID still gets the badge.
func TestIncrementMentionCounts_StillAppliesWhenReaderIsBehind(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	// Bob's read state is behind: he has read message 1's predecessor, not the
	// mention itself.
	older, err := database.CreateMessage(ctx, 1, 1, "hi", nil)
	if err != nil {
		t.Fatalf("CreateMessage(older): %v", err)
	}
	if err := database.UpdateReadState(ctx, 2, 1, older); err != nil {
		t.Fatalf("UpdateReadState: %v", err)
	}

	msgID, err := database.CreateMessage(ctx, 1, 1, "hey @bob", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	if err := database.IncrementMentionCounts(ctx, 1, msgID, []int64{2}); err != nil {
		t.Fatalf("IncrementMentionCounts: %v", err)
	}

	if n, _ := database.GetMentionCount(ctx, 2, 1); n != 1 {
		t.Errorf("mention_count = %d for a reader behind the mentioning message, want 1", n)
	}
}

func TestGetUserIDsByUsernames_CaseInsensitive(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)

	got, err := database.GetUserIDsByUsernames(context.Background(), []string{"BOB", "carol", "ghost"})
	if err != nil {
		t.Fatalf("GetUserIDsByUsernames: %v", err)
	}
	if got["bob"] != 2 {
		t.Errorf("bob = %d, want 2", got["bob"])
	}
	if got["carol"] != 3 {
		t.Errorf("carol = %d, want 3 (stored as \"Carol\")", got["carol"])
	}
	if _, ok := got["ghost"]; ok {
		t.Error("unknown username must not resolve")
	}
}

// TestGetUserIDsByUsernames_NonASCIIUppercase locks OC-0131: a username
// holding an uppercase non-ASCII letter (legal per auth.ValidateUsername,
// e.g. "Émile") must resolve through the exact same spelling it was queried
// with. users.username is only COLLATE NOCASE, which folds ASCII A-Z only, so
// the map key this function builds from the returned row must fold no harder
// than that column does -- a Unicode-aware strings.ToLower would fold 'É' to
// 'é' here and desync the key from the caller's (equally ASCII-folded)
// lookup spelling, making the row permanently unreachable by name.
func TestGetUserIDsByUsernames_NonASCIIUppercase(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	uid, err := database.CreateUser(ctx, "Émile", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	got, err := database.GetUserIDsByUsernames(ctx, []string{"Émile"})
	if err != nil {
		t.Fatalf("GetUserIDsByUsernames: %v", err)
	}
	if got["Émile"] != uid {
		t.Errorf(`result["Émile"] = %d, want %d (map key must match the query spelling for a non-ASCII-uppercase username)`, got["Émile"], uid)
	}
}

// TestGetUserIDsByUsernames_LapsedTempBan_StillResolves locks the "reconverged
// raw column" fix: nothing clears users.banned when a temp ban's ban_expires
// lapses (that's decided lazily, at login, by auth.IsEffectivelyBanned), so a
// raw `banned = 0` filter would leave a reinstated user permanently
// unresolvable as an @mention target even though they can log in and post
// again.
func TestGetUserIDsByUsernames_LapsedTempBan_StillResolves(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	past := time.Now().Add(-1 * time.Hour)
	if err := database.BanUser(ctx, 2, "temp ban", &past); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	got, err := database.GetUserIDsByUsernames(ctx, []string{"bob"})
	if err != nil {
		t.Fatalf("GetUserIDsByUsernames: %v", err)
	}
	if got["bob"] != 2 {
		t.Errorf("bob = %d, want 2 (a lapsed temp ban must not hide the user from mention resolution)", got["bob"])
	}
}

// TestGetUserIDsByUsernames_ActiveTempBan_Excluded is the complement: a temp
// ban that has NOT yet lapsed must still exclude the user, same as today.
func TestGetUserIDsByUsernames_ActiveTempBan_Excluded(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	future := time.Now().Add(1 * time.Hour)
	if err := database.BanUser(ctx, 2, "temp ban", &future); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	got, err := database.GetUserIDsByUsernames(ctx, []string{"bob"})
	if err != nil {
		t.Fatalf("GetUserIDsByUsernames: %v", err)
	}
	if _, ok := got["bob"]; ok {
		t.Error("actively temp-banned user must not resolve as a mention target")
	}
}

// TestGetUserIDsByUsernames_ActiveTempBan_SQLiteTimeFormat_Excluded pins the
// expiry filter against the second ban_expires spelling auth.IsEffectivelyBanned
// accepts (and that auth/helpers_test.go locks): SQLite's space-separated
// "2006-01-02 15:04:05". The comparison in the SQL filter is lexical and ' '
// sorts BELOW 'T', so an unnormalised clause reads any same-day space-form
// expiry as already lapsed and fails OPEN — a genuinely banned user back in
// the fan-out. The expiry here is deliberately later on the *same UTC day* so
// only the separator, not the date, can decide the comparison.
func TestGetUserIDsByUsernames_ActiveTempBan_SQLiteTimeFormat_Excluded(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	// End of the current UTC day: still in the future, still the same date, so
	// the ' ' vs 'T' separator is the only thing that can flip the comparison.
	now := time.Now().UTC()
	future := time.Date(now.Year(), now.Month(), now.Day(), 23, 59, 59, 0, time.UTC)
	if !future.After(now) {
		t.Skip("run within the last second of the UTC day; no same-day future instant exists")
	}
	if _, err := database.ExecContext(ctx,
		`UPDATE users SET banned = 1, ban_reason = 'temp ban', ban_expires = ? WHERE id = ?`,
		future.Format("2006-01-02 15:04:05"), 2,
	); err != nil {
		t.Fatalf("seed space-format ban_expires: %v", err)
	}

	got, err := database.GetUserIDsByUsernames(ctx, []string{"bob"})
	if err != nil {
		t.Fatalf("GetUserIDsByUsernames: %v", err)
	}
	if _, ok := got["bob"]; ok {
		t.Error("temp ban stored in SQLite's space-separated time format must still exclude the user")
	}
}

// TestGetUserIDsByUsernames_PermanentBan_Excluded locks the nil-expiry case:
// a permanent ban (ban_expires NULL) must keep excluding the user forever.
func TestGetUserIDsByUsernames_PermanentBan_Excluded(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	if err := database.BanUser(ctx, 2, "permanent ban", nil); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	got, err := database.GetUserIDsByUsernames(ctx, []string{"bob"})
	if err != nil {
		t.Fatalf("GetUserIDsByUsernames: %v", err)
	}
	if _, ok := got["bob"]; ok {
		t.Error("permanently banned user must not resolve as a mention target")
	}
}

// TestListMentionTargetsByRoles_LapsedTempBan_Included covers the same
// expiry-aware fix on the @everyone/@here fan-out path.
func TestListMentionTargetsByRoles_LapsedTempBan_Included(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	past := time.Now().Add(-1 * time.Hour)
	if err := database.BanUser(ctx, 2, "temp ban", &past); err != nil {
		t.Fatalf("BanUser: %v", err)
	}

	targets, err := database.ListMentionTargetsByRoles(ctx, []int64{4})
	if err != nil {
		t.Fatalf("ListMentionTargetsByRoles: %v", err)
	}
	found := false
	for _, tgt := range targets {
		if tgt.UserID == 2 {
			found = true
		}
	}
	if !found {
		t.Error("user with a lapsed temp ban must still appear in the @everyone/@here fan-out")
	}
}

func TestListMentionTargetsByRoles(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	if err := database.UpdateUserStatus(ctx, 2, "online"); err != nil {
		t.Fatalf("UpdateUserStatus: %v", err)
	}

	targets, err := database.ListMentionTargetsByRoles(ctx, []int64{4})
	if err != nil {
		t.Fatalf("ListMentionTargetsByRoles: %v", err)
	}
	if len(targets) != 3 {
		t.Fatalf("targets = %d, want 3", len(targets))
	}
	for _, tgt := range targets {
		if tgt.UserID == 2 && tgt.Status != "online" {
			t.Errorf("user 2 status = %q, want online", tgt.Status)
		}
	}

	empty, err := database.ListMentionTargetsByRoles(ctx, nil)
	if err != nil || len(empty) != 0 {
		t.Errorf("no roles must yield no targets: %v %v", empty, err)
	}
}

func TestListBlockersOf(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	if err := database.BlockUser(ctx, 2, 1); err != nil {
		t.Fatalf("BlockUser: %v", err)
	}
	blockers, err := database.ListBlockersOf(ctx, 1)
	if err != nil {
		t.Fatalf("ListBlockersOf: %v", err)
	}
	if len(blockers) != 1 || blockers[0] != 2 {
		t.Errorf("blockers = %v, want [2]", blockers)
	}
}

func TestGetChannelOverrides(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	if err := database.UpsertChannelOverride(ctx, 1, 4, 0, 2); err != nil {
		t.Fatalf("UpsertChannelOverride: %v", err)
	}
	got, err := database.GetChannelOverrides(ctx, 1)
	if err != nil {
		t.Fatalf("GetChannelOverrides: %v", err)
	}
	if o, ok := got[4]; !ok || o.Deny != 2 {
		t.Errorf("override for role 4 = %+v, want deny=2", o)
	}
}

// TestMessagesForAPI_CarryMentions locks that REST history hands back the
// resolved mention list and the everyone flag.
func TestMessagesForAPI_CarryMentions(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	if _, err := database.CreateMessageWithMentions(ctx, 1, 1, "hi @bob", nil, []int64{2}, true); err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	msgs, err := database.GetMessagesForAPI(ctx, 1, 0, 10, 1)
	if err != nil {
		t.Fatalf("GetMessagesForAPI: %v", err)
	}
	if len(msgs) != 1 {
		t.Fatalf("messages = %d, want 1", len(msgs))
	}
	if len(msgs[0].Mentions) != 1 || msgs[0].Mentions[0] != 2 {
		t.Errorf("mentions = %v, want [2]", msgs[0].Mentions)
	}
	if !msgs[0].MentionsEveryone {
		t.Error("mentions_everyone = false, want true")
	}
}

func TestSearchMessages_CarryMentions(t *testing.T) {
	database := newMigratedTestDB(t)
	seedMentionFixture(t, database)
	ctx := context.Background()

	if _, err := database.CreateMessageWithMentions(ctx, 1, 1, "deployment notes", nil, []int64{2}, false); err != nil {
		t.Fatalf("CreateMessageWithMentions: %v", err)
	}
	results, err := database.SearchMessages(ctx, "deployment", nil, 10)
	if err != nil {
		t.Fatalf("SearchMessages: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("results = %d, want 1", len(results))
	}
	if len(results[0].Mentions) != 1 || results[0].Mentions[0] != 2 {
		t.Errorf("mentions = %v, want [2]", results[0].Mentions)
	}
	if results[0].MentionsEveryone {
		t.Error("mentions_everyone = true, want false")
	}
}
