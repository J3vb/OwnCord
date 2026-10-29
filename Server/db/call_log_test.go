package db_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

const (
	callStart = "2026-10-16 10:00:00"
	callSeen  = "2026-10-16 10:00:30"
	callEnd   = "2026-10-16 10:05:00"
)

// callFixture is a DM between two users, as the call log needs it.
type callFixture struct {
	database       *db.DB
	alice, bob, dm int64
}

func newCallFixture(t *testing.T) callFixture {
	t.Helper()
	database := openMigratedMemory(t)
	alice := seedUser(t, database, "alice")
	bob := seedUser(t, database, "bob")
	dm, _, err := database.GetOrCreateDMChannel(context.Background(), alice, bob)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	return callFixture{database: database, alice: alice, bob: bob, dm: dm.ID}
}

func (f callFixture) startCall(t *testing.T, participants ...int64) *db.CallLogRow {
	t.Helper()
	row, err := f.database.CreateCallLog(context.Background(), db.CallLogParams{
		ChannelID: f.dm, AuthorID: f.alice, Content: "started a call.",
		StartedAt: callStart, LastSeenAt: callSeen, ParticipantIDs: participants,
	})
	if err != nil {
		t.Fatalf("CreateCallLog: %v", err)
	}
	return row
}

func count(t *testing.T, database *db.DB, query string, args ...any) int {
	t.Helper()
	var n int
	if err := database.QueryRowContext(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatalf("%s: %v", query, err)
	}
	return n
}

func TestMigration064_ExistingMessagesKindZero(t *testing.T) {
	database := openMemory(t)
	if err := db.MigrateFS(database, migrationsBefore(t, "064")); err != nil {
		t.Fatalf("migrate to 063: %v", err)
	}
	ctx := context.Background()
	alice := seedUser(t, database, "alice")
	ch := seedChannelRawSQL(t, database, "general")
	// Raw SQL: the generated writers name the kind column, which 063 lacks.
	res, err := database.ExecContext(ctx,
		`INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'before the migration')`, ch, alice)
	if err != nil {
		t.Fatalf("insert message: %v", err)
	}
	id, _ := res.LastInsertId()
	if err := db.Migrate(database); err != nil {
		t.Fatalf("Migrate to head: %v", err)
	}
	if got := count(t, database, `SELECT kind FROM messages WHERE id = ?`, id); got != 0 {
		t.Errorf("existing message kind = %d, want 0", got)
	}
	m, err := database.GetMessage(ctx, id)
	if err != nil || m == nil || m.Kind != db.MessageKindUser {
		t.Errorf("GetMessage kind = %+v (%v), want MessageKindUser", m, err)
	}
}

func TestCreateCallLog_KindCallParticipantsAndAuthorReadState(t *testing.T) {
	f := newCallFixture(t)
	row := f.startCall(t, f.alice, f.bob)

	if row.Message.Kind != db.MessageKindCall || row.Message.UserID != f.alice || row.Message.Content != "started a call." {
		t.Errorf("message = %+v, want a kind-call row authored by alice", row.Message)
	}
	if got := count(t, f.database, `SELECT kind FROM messages WHERE id = ?`, row.Message.ID); got != 1 {
		t.Errorf("stored kind = %d, want 1", got)
	}
	if row.Call.StartedAt != callStart || row.Call.EndedAt != nil {
		t.Errorf("call = %+v, want started %s and live", row.Call, callStart)
	}
	if !slices.Equal(row.Call.Participants, []int64{f.alice, f.bob}) {
		t.Errorf("participants = %v", row.Call.Participants)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM message_call_participants WHERE message_id = ?`, row.Message.ID); got != 2 {
		t.Errorf("participant rows = %d, want 2", got)
	}
	last, _, found, err := f.database.GetReadState(context.Background(), f.alice, f.dm)
	if err != nil || !found || last != row.Message.ID {
		t.Errorf("author read state = %d found=%v err=%v, want %d", last, found, err, row.Message.ID)
	}
	if _, _, found, _ := f.database.GetReadState(context.Background(), f.bob, f.dm); found {
		t.Error("the other participant's read state moved; the row must stay unread for them")
	}
}

func TestCreateCallLog_SecondOpenCallSameChannelConflicts(t *testing.T) {
	f := newCallFixture(t)
	first := f.startCall(t, f.alice)
	_, err := f.database.CreateCallLog(context.Background(), db.CallLogParams{
		ChannelID: f.dm, AuthorID: f.bob, Content: "started a call.",
		StartedAt: callStart, LastSeenAt: callSeen, ParticipantIDs: []int64{f.bob},
	})
	if !errors.Is(err, db.ErrConflict) {
		t.Fatalf("second open call: err = %v, want ErrConflict", err)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE channel_id = ? AND kind = 1`, f.dm); got != 1 {
		t.Errorf("call messages = %d, want 1 (the losing insert must roll back)", got)
	}
	// Once the first call has ended, the channel can hold a new one.
	if ended, err := f.database.EndCall(context.Background(), first.Message.ID, callEnd, "ended"); err != nil || !ended {
		t.Fatalf("EndCall = %v, %v", ended, err)
	}
	f.startCall(t, f.bob)
}

func TestEndCall_SecondEndIsNoop(t *testing.T) {
	f := newCallFixture(t)
	row := f.startCall(t, f.alice)
	ctx := context.Background()

	ended, err := f.database.EndCall(ctx, row.Message.ID, callEnd, "started a call that lasted 5 minutes.")
	if err != nil || !ended {
		t.Fatalf("first EndCall = %v, %v, want true", ended, err)
	}
	ended, err = f.database.EndCall(ctx, row.Message.ID, "2026-10-16 11:00:00", "other text")
	if err != nil || ended {
		t.Fatalf("second EndCall = %v, %v, want false", ended, err)
	}
	var endedAt, content string
	if err := f.database.QueryRowContext(ctx,
		`SELECT c.ended_at, m.content FROM message_calls c JOIN messages m ON m.id = c.message_id WHERE c.message_id = ?`,
		row.Message.ID).Scan(&endedAt, &content); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if endedAt != callEnd || content != "started a call that lasted 5 minutes." {
		t.Errorf("ended_at=%q content=%q: the second end changed the row", endedAt, content)
	}
}

func TestEditMessageContent_CallRowNotFound(t *testing.T) {
	f := newCallFixture(t)
	row := f.startCall(t, f.alice)
	_, err := f.database.EditMessage(context.Background(), row.Message.ID, f.alice, "rewritten")
	if !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("EditMessage on a call row: err = %v, want ErrNotFound", err)
	}
	m, _ := f.database.GetMessage(context.Background(), row.Message.ID)
	if m.Content != "started a call." || m.EditedAt != nil {
		t.Errorf("call row after refused edit = %+v", m)
	}
}

func TestSoftDeleteMessage_CallRowUntouched(t *testing.T) {
	f := newCallFixture(t)
	row := f.startCall(t, f.alice)
	ctx := context.Background()
	for name, call := range map[string]func() error{
		"author":    func() error { return f.database.DeleteMessage(ctx, row.Message.ID, f.alice, false) },
		"moderator": func() error { return f.database.DeleteMessage(ctx, row.Message.ID, f.bob, true) },
		"removal": func() error {
			return f.database.DeleteMessageWithRemoval(ctx, row.Message.ID, f.bob, true, f.alice, nil, "")
		},
	} {
		if err := call(); !errors.Is(err, db.ErrNotFound) {
			t.Errorf("%s delete: err = %v, want ErrNotFound", name, err)
		}
	}
	if got := count(t, f.database, `SELECT deleted FROM messages WHERE id = ?`, row.Message.ID); got != 0 {
		t.Errorf("deleted = %d, want 0", got)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM moderation_actions`); got != 0 {
		t.Errorf("a refused removal left %d ledger rows", got)
	}
}

func TestMessagesForAPI_CallRowCarriesKindAndCall(t *testing.T) {
	f := newCallFixture(t)
	ctx := context.Background()
	before, err := f.database.CreateMessage(ctx, f.dm, f.bob, "hi", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	row := f.startCall(t, f.alice, f.bob)
	if _, err := f.database.EndCall(ctx, row.Message.ID, callEnd, "ended"); err != nil {
		t.Fatalf("EndCall: %v", err)
	}
	after, err := f.database.CreateMessage(ctx, f.dm, f.bob, "bye", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}

	check := func(name string, msgs []db.MessageAPIResponse, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(msgs) != 3 {
			t.Fatalf("%s: %d messages, want 3", name, len(msgs))
		}
		for _, m := range msgs {
			switch m.ID {
			case row.Message.ID:
				if m.Kind != "call" || m.Call == nil {
					t.Fatalf("%s: call row = kind %q call %v", name, m.Kind, m.Call)
				}
				if m.Call.StartedAt != callStart || m.Call.EndedAt == nil || *m.Call.EndedAt != callEnd ||
					!slices.Equal(m.Call.Participants, []int64{f.alice, f.bob}) {
					t.Errorf("%s: call = %+v", name, m.Call)
				}
			case before, after:
				if m.Kind != "" || m.Call != nil {
					t.Errorf("%s: ordinary message %d carries kind %q call %v", name, m.ID, m.Kind, m.Call)
				}
			}
		}
	}
	msgs, err := f.database.GetMessagesForAPI(ctx, f.dm, 0, 10, f.alice)
	check("before", msgs, err)
	msgs, err = f.database.GetMessagesAfterForAPI(ctx, f.dm, 0, 10, f.alice)
	check("after", msgs, err)
	msgs, err = f.database.GetMessagesAroundForAPI(ctx, f.dm, row.Message.ID, 5, 5, f.alice)
	check("around", msgs, err)
}

func TestSearch_ExcludesCallRows(t *testing.T) {
	f := newCallFixture(t)
	ctx := context.Background()
	// The fallback text is indexed like any content; both rows contain "zebra".
	row, err := f.database.CreateCallLog(ctx, db.CallLogParams{
		ChannelID: f.dm, AuthorID: f.alice, Content: "zebra call",
		StartedAt: callStart, LastSeenAt: callSeen, ParticipantIDs: []int64{f.alice},
	})
	if err != nil {
		t.Fatalf("CreateCallLog: %v", err)
	}
	ordinary, err := f.database.CreateMessage(ctx, f.dm, f.bob, "zebra message", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	for name, run := range map[string]func() ([]db.MessageSearchResult, error){
		"all channels": func() ([]db.MessageSearchResult, error) {
			return f.database.SearchMessages(ctx, "zebra", nil, db.SearchPage{Limit: 10})
		},
		"in channels": func() ([]db.MessageSearchResult, error) {
			return f.database.SearchMessagesInChannels(ctx, "zebra", []int64{f.dm}, db.SearchPage{Limit: 10})
		},
		"recent": func() ([]db.MessageSearchResult, error) {
			return f.database.SearchMessagesInChannels(ctx, "zebra", []int64{f.dm}, db.SearchPage{Limit: 10, Recent: true})
		},
	} {
		got, err := run()
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(got) != 1 || got[0].MessageID != ordinary {
			ids := make([]int64, 0, len(got))
			for _, r := range got {
				ids = append(ids, r.MessageID)
			}
			t.Errorf("%s: hits = %v, want only %d (call row %d must not match)", name, ids, ordinary, row.Message.ID)
		}
	}
}

func TestEraseAccount_RemovesCallParticipation(t *testing.T) {
	f := newCallFixture(t)
	ctx := context.Background()
	third := seedUser(t, f.database, "carol")
	// alice authors one call and bob joined it; bob authors another that alice joined.
	aliceCall := f.startCall(t, f.alice, f.bob)
	if _, err := f.database.EndCall(ctx, aliceCall.Message.ID, callEnd, "ended"); err != nil {
		t.Fatalf("EndCall: %v", err)
	}
	bobCall, err := f.database.CreateCallLog(ctx, db.CallLogParams{
		ChannelID: f.dm, AuthorID: f.bob, Content: "started a call.",
		StartedAt: callStart, LastSeenAt: callSeen, ParticipantIDs: []int64{f.bob, f.alice, third},
	})
	if err != nil {
		t.Fatalf("CreateCallLog: %v", err)
	}

	if _, err := f.database.EraseAccount(ctx, f.alice, ""); err != nil {
		t.Fatalf("EraseAccount: %v", err)
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM message_call_participants WHERE user_id = ?`, f.alice); got != 0 {
		t.Errorf("erased user still in %d participant rows", got)
	}
	// The call alice authored goes with its tables.
	for _, q := range []string{
		`SELECT COUNT(*) FROM messages WHERE id = ?`,
		`SELECT COUNT(*) FROM message_calls WHERE message_id = ?`,
		`SELECT COUNT(*) FROM message_call_participants WHERE message_id = ?`,
	} {
		if got := count(t, f.database, q, aliceCall.Message.ID); got != 0 {
			t.Errorf("%s = %d for the authored call, want 0", q, got)
		}
	}
	// Bob's call stays, with the other participants intact.
	var rest []int64
	rows, err := f.database.QueryContext(ctx,
		`SELECT user_id FROM message_call_participants WHERE message_id = ? ORDER BY user_id`, bobCall.Message.ID)
	if err != nil {
		t.Fatalf("query: %v", err)
	}
	defer rows.Close() //nolint:errcheck // test read path
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan: %v", err)
		}
		rest = append(rest, id)
	}
	if want := []int64{f.bob, third}; !slices.Equal(rest, want) {
		t.Errorf("surviving participants = %v, want %v", rest, want)
	}
}

func TestDeleteChannel_CascadesCallTables(t *testing.T) {
	f := newCallFixture(t)
	row := f.startCall(t, f.alice, f.bob)
	if err := f.database.DeleteChannel(context.Background(), f.dm); err != nil {
		t.Fatalf("DeleteChannel: %v", err)
	}
	for _, table := range []string{"message_calls", "message_call_participants"} {
		if got := count(t, f.database, `SELECT COUNT(*) FROM `+table+` WHERE message_id = ?`, row.Message.ID); got != 0 {
			t.Errorf("%s rows after channel delete = %d, want 0", table, got)
		}
	}
	if got := count(t, f.database, `SELECT COUNT(*) FROM messages WHERE id = ?`, row.Message.ID); got != 0 {
		t.Errorf("call message survived the channel delete")
	}
}

// Call rows and group event rows are read-only wherever messages are written.
// This keeps them written only by the call log and the group events: no
// statement outside call_log.sql, group_events.sql, message_pins.sql and welcome.sql (and
// their Go callers) may set the kind column. message_pins.sql must hold only
// the pin-row insert and the window lookup, so a new insert or update cannot create or retype
// one.
func TestCallLog_OnlyWriterOfKind(t *testing.T) {
	stmt := regexp.MustCompile(`(?is)(INSERT\s+(?:OR\s+\w+\s+)?INTO\s+messages\b[^;` + "`" + `]*|UPDATE\s+messages\s+SET\b[^;` + "`" + `]*)`)
	kind := regexp.MustCompile(`(?i)\bkind\b\s*(=|,|\))`)
	var files []string
	for _, pattern := range []string{"queries/sqlite/*.sql", "*.go"} {
		m, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatalf("glob %s: %v", pattern, err)
		}
		files = append(files, m...)
	}
	checked := 0
	for _, f := range files {
		base := filepath.Base(f)
		if strings.HasSuffix(base, "_test.go") || base == "call_log.sql" || base == "call_log.go" ||
			base == "group_events.sql" || base == "group_events.go" || base == "message_pins.sql" ||
			base == "welcome.sql" {
			continue
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("read %s: %v", f, err)
		}
		for _, s := range stmt.FindAllString(string(raw), -1) {
			checked++
			// "kind = 0" in a WHERE clause is a guard, not a write.
			head := s
			if i := strings.Index(strings.ToUpper(s), "WHERE"); i >= 0 {
				head = s[:i]
			}
			if kind.MatchString(head) {
				t.Errorf("%s writes messages.kind outside the call log and group events: %s", f, strings.TrimSpace(s))
			}
		}
	}
	if checked == 0 {
		t.Fatal("matched no messages writer; the scan is broken")
	}
}

func TestPurgeChannelMessages_SkipsCallRows(t *testing.T) {
	f := newCallFixture(t)
	ctx := context.Background()
	row := f.startCall(t, f.alice)
	plain, err := f.database.CreateMessage(ctx, f.dm, f.bob, "hi", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	ids, err := f.database.PurgeChannelMessages(ctx, f.dm, 0, 10)
	if err != nil {
		t.Fatalf("PurgeChannelMessages: %v", err)
	}
	if !slices.Equal(ids, []int64{plain}) {
		t.Errorf("purged ids = %v, want only %d", ids, plain)
	}
	if got := count(t, f.database, `SELECT deleted FROM messages WHERE id = ?`, row.Message.ID); got != 0 {
		t.Errorf("call row deleted = %d, want 0", got)
	}
}

func TestPurgeUserChannelMessagesSince_SkipsCallRows(t *testing.T) {
	f := newCallFixture(t)
	ctx := context.Background()
	row := f.startCall(t, f.alice) // authored by alice
	plain, err := f.database.CreateMessage(ctx, f.dm, f.alice, "hi", nil)
	if err != nil {
		t.Fatalf("CreateMessage: %v", err)
	}
	ids, err := f.database.PurgeUserChannelMessagesSince(ctx, f.dm, f.alice, "2000-01-01 00:00:00", 10)
	if err != nil {
		t.Fatalf("PurgeUserChannelMessagesSince: %v", err)
	}
	if !slices.Equal(ids, []int64{plain}) {
		t.Errorf("purged ids = %v, want only %d", ids, plain)
	}
	if got := count(t, f.database, `SELECT deleted FROM messages WHERE id = ?`, row.Message.ID); got != 0 {
		t.Errorf("call row deleted = %d, want 0", got)
	}
}

func TestSetMessagePinned_CallRowNotFound(t *testing.T) {
	f := newCallFixture(t)
	row := f.startCall(t, f.alice)
	if _, err := f.database.SetMessagePinned(context.Background(), db.SetPinnedParams{MessageID: row.Message.ID, Pinned: true, UserID: 1}); !errors.Is(err, db.ErrNotFound) {
		t.Fatalf("pin call row: err = %v, want ErrNotFound", err)
	}
	if got := count(t, f.database, `SELECT pinned FROM messages WHERE id = ?`, row.Message.ID); got != 0 {
		t.Errorf("pinned = %d, want 0", got)
	}
}

func TestOpenCallReads_LiveVersusNone(t *testing.T) {
	f := newCallFixture(t)
	ctx := context.Background()
	if oc, err := f.database.GetOpenCall(ctx, f.dm); err != nil || oc != nil {
		t.Fatalf("GetOpenCall with no call = %v, %v; want nil, nil", oc, err)
	}
	if list, err := f.database.ListOpenCalls(ctx); err != nil || len(list) != 0 {
		t.Fatalf("ListOpenCalls with no call = %v, %v", list, err)
	}
	row := f.startCall(t, f.alice)
	oc, err := f.database.GetOpenCall(ctx, f.dm)
	if err != nil || oc == nil {
		t.Fatalf("GetOpenCall = %v, %v", oc, err)
	}
	if oc.MessageID != row.Message.ID || oc.AuthorID != f.alice || oc.ChannelID != f.dm ||
		oc.StartedAt != callStart || oc.LastSeenAt != callSeen {
		t.Errorf("open call = %+v", oc)
	}
	list, err := f.database.ListOpenCalls(ctx)
	if err != nil || len(list) != 1 || list[0] != *oc {
		t.Fatalf("ListOpenCalls = %v, %v", list, err)
	}
	if _, err := f.database.EndCall(ctx, row.Message.ID, callEnd, "x"); err != nil {
		t.Fatal(err)
	}
	if oc, _ := f.database.GetOpenCall(ctx, f.dm); oc != nil {
		t.Errorf("an ended call is still listed as open: %+v", oc)
	}
	if list, _ := f.database.ListOpenCalls(ctx); len(list) != 0 {
		t.Errorf("ListOpenCalls after the end = %v", list)
	}
}

func TestAddCallParticipants_IdempotentAndSkipsMissingUsers(t *testing.T) {
	f := newCallFixture(t)
	ctx := context.Background()
	row := f.startCall(t, f.alice)
	if err := f.database.AddCallParticipants(ctx, row.Message.ID, nil); err != nil {
		t.Fatalf("empty add: %v", err)
	}
	for range 2 {
		if err := f.database.AddCallParticipants(ctx, row.Message.ID, []int64{f.alice, f.bob, 9999}); err != nil {
			t.Fatalf("AddCallParticipants: %v", err)
		}
	}
	ci, err := f.database.GetCallInfo(ctx, row.Message.ID)
	if err != nil || ci == nil {
		t.Fatalf("GetCallInfo: %v", err)
	}
	if !slices.Equal(ci.Participants, []int64{f.alice, f.bob}) {
		t.Errorf("participants = %v, want alice and bob once each and no vanished user", ci.Participants)
	}
}

func TestTouchCall_OnlyMovesForwardAndOnlyWhileLive(t *testing.T) {
	f := newCallFixture(t)
	ctx := context.Background()
	row := f.startCall(t, f.alice)
	seen := func() string {
		oc, err := f.database.GetOpenCall(ctx, f.dm)
		if err != nil || oc == nil {
			t.Fatalf("GetOpenCall: %v", err)
		}
		return oc.LastSeenAt
	}
	if err := f.database.TouchCall(ctx, row.Message.ID, "2026-10-16 10:02:00"); err != nil {
		t.Fatal(err)
	}
	if got := seen(); got != "2026-10-16 10:02:00" {
		t.Fatalf("last_seen_at = %q, want the later time", got)
	}
	if err := f.database.TouchCall(ctx, row.Message.ID, callSeen); err != nil {
		t.Fatal(err)
	}
	if got := seen(); got != "2026-10-16 10:02:00" {
		t.Errorf("last_seen_at moved backwards to %q", got)
	}
	if _, err := f.database.EndCall(ctx, row.Message.ID, callEnd, "x"); err != nil {
		t.Fatal(err)
	}
	if err := f.database.TouchCall(ctx, row.Message.ID, "2026-10-16 11:00:00"); err != nil {
		t.Fatal(err)
	}
	if n := count(t, f.database, `SELECT COUNT(*) FROM message_calls WHERE message_id = ? AND last_seen_at = '2026-10-16 10:02:00'`, row.Message.ID); n != 1 {
		t.Error("TouchCall changed an ended call")
	}
}

func TestGetCallInfo_NilForNonCallMessage(t *testing.T) {
	f := newCallFixture(t)
	ctx := context.Background()
	id, err := f.database.CreateMessage(ctx, f.dm, f.alice, "plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	if ci, err := f.database.GetCallInfo(ctx, id); err != nil || ci != nil {
		t.Errorf("GetCallInfo(plain message) = %v, %v; want nil, nil", ci, err)
	}
}
