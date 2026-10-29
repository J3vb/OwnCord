package service

import (
	"context"
	"errors"
	"strconv"
	"testing"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
)

type recordingWelcomeNotifier struct{ got []*WelcomeResult }

func (n *recordingWelcomeNotifier) WelcomeRow(_ context.Context, res *WelcomeResult) {
	n.got = append(n.got, res)
}

// failingWelcomeStore fails every welcome insert, the fault injected for the
// "a failed row write never fails the registration" edge.
type failingWelcomeStore struct{ calls int }

func (f *failingWelcomeStore) InsertWelcomeRow(context.Context, int64, int64, string) (*db.WelcomeRow, error) {
	f.calls++
	return nil, errors.New("disk full")
}

// welcomeDropStore cancels the request context the moment the account
// has committed, simulating a client that dropped mid-request.
type welcomeDropStore struct {
	*db.DB
	cancel context.CancelFunc
}

func (c *welcomeDropStore) CreateUserWithSession(ctx context.Context, username, hash string, roleID int, tokenHash, device, ip string) (int64, error) {
	uid, err := c.DB.CreateUserWithSession(ctx, username, hash, roleID, tokenHash, device, ip)
	c.cancel()
	return uid, err
}

type welcomeFixture struct {
	ctx      context.Context
	database *db.DB
	auth     *AuthService
	users    *UserService
	notifier *recordingWelcomeNotifier
	channel  int64
}

func newWelcomeFixture(t *testing.T, mode RegistrationMode) *welcomeFixture {
	t.Helper()
	ctx := context.Background()
	database := newTestDB(t)
	if err := database.SetSetting(ctx, registrationModeKey, string(mode)); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	seedChannel(t, database, &db.Channel{ID: 50, Name: "lobby", Type: "text"})
	f := &welcomeFixture{ctx: ctx, database: database, notifier: &recordingWelcomeNotifier{}, channel: 50}
	welcome := NewWelcomeService(database)
	welcome.SetNotifier(f.notifier)
	f.auth = NewAuthService(database, auth.NewRateLimiter(), make([]byte, 32), nil)
	f.auth.UseWelcome(welcome)
	f.users = NewUserService(database)
	f.users.welcome = welcome
	return f
}

func (f *welcomeFixture) pick(t *testing.T, id int64) {
	t.Helper()
	if err := f.database.SetSetting(f.ctx, WelcomeChannelKey, strconv.FormatInt(id, 10)); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
}

func (f *welcomeFixture) rows(t *testing.T) int {
	t.Helper()
	var n int
	if err := f.database.QueryRowContext(f.ctx, `SELECT COUNT(*) FROM messages WHERE kind = ?`, db.MessageKindMemberJoin).Scan(&n); err != nil {
		t.Fatalf("count welcome rows: %v", err)
	}
	return n
}

func (f *welcomeFixture) register(t *testing.T, name, invite string) *AuthResult {
	t.Helper()
	res, err := f.auth.Register(f.ctx, RegisterInput{
		Username: name, Password: "securePass1", InviteCode: invite, Device: "test", IP: "203.0.113.7",
	})
	if err != nil {
		t.Fatalf("Register(%s): %v", name, err)
	}
	return res
}

func TestWelcome_OpenRegistrationWritesRowAndNotifies(t *testing.T) {
	f := newWelcomeFixture(t, RegistrationOpen)
	f.pick(t, f.channel)
	res := f.register(t, "alice", "")

	if got := f.rows(t); got != 1 {
		t.Fatalf("welcome rows = %d, want 1", got)
	}
	if len(f.notifier.got) != 1 {
		t.Fatalf("notifier calls = %d, want 1", len(f.notifier.got))
	}
	n := f.notifier.got[0]
	if n.Row.ChannelID != f.channel || n.Row.UserID != res.User.ID || n.Author.Username != "alice" ||
		n.Row.Content != "alice joined the server." {
		t.Errorf("result = %+v row = %+v", n, n.Row)
	}
	// The joiner's own read state is past the row, so it is not unread for them.
	var last int64
	if err := f.database.QueryRowContext(f.ctx,
		`SELECT last_message_id FROM read_states WHERE user_id = ? AND channel_id = ?`, res.User.ID, f.channel).Scan(&last); err != nil || last != n.Row.MessageID {
		t.Errorf("read state = %d err=%v, want %d", last, err, n.Row.MessageID)
	}
	// History returns the wire kind.
	msgs, err := f.database.GetMessagesForAPI(f.ctx, f.channel, 0, 10, res.User.ID)
	if err != nil || len(msgs) != 1 || msgs[0].Kind != "member_join" {
		t.Fatalf("history = %+v err=%v, want one member_join row", msgs, err)
	}
}

func TestWelcome_InviteRegistrationWritesRow(t *testing.T) {
	f := newWelcomeFixture(t, RegistrationInvite)
	f.pick(t, f.channel)
	owner, err := f.database.CreateUser(f.ctx, "owner", "hash", 1)
	if err != nil {
		t.Fatal(err)
	}
	code, err := f.database.CreateInvite(f.ctx, owner, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	f.register(t, "bob", code)
	if got := f.rows(t); got != 1 || len(f.notifier.got) != 1 {
		t.Fatalf("rows = %d notifications = %d, want 1 and 1", got, len(f.notifier.got))
	}
}

func TestWelcome_OffWritesNothing(t *testing.T) {
	f := newWelcomeFixture(t, RegistrationOpen)
	f.register(t, "carol", "") // never picked
	if err := f.database.SetSetting(f.ctx, WelcomeChannelKey, ""); err != nil {
		t.Fatal(err)
	}
	f.register(t, "dave", "") // cleared
	if got := f.rows(t); got != 0 || len(f.notifier.got) != 0 {
		t.Fatalf("rows = %d notifications = %d, want 0 and 0", got, len(f.notifier.got))
	}
}

func TestWelcome_ApprovalModeWritesOnlyOnApprove(t *testing.T) {
	f := newWelcomeFixture(t, RegistrationApproval)
	f.pick(t, f.channel)
	res := f.register(t, "erin", "")
	if !res.PendingApproval {
		t.Fatal("expected a pending application")
	}
	if got := f.rows(t); got != 0 {
		t.Fatalf("a pending application wrote %d welcome rows, want 0", got)
	}
	var uid int64
	if err := f.database.QueryRowContext(f.ctx, `SELECT id FROM users WHERE username = 'erin'`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	if err := f.users.ApproveRegistration(f.ctx, 1, uid); err != nil {
		t.Fatalf("ApproveRegistration: %v", err)
	}
	if got := f.rows(t); got != 1 || len(f.notifier.got) != 1 || f.notifier.got[0].Author.ID != uid {
		t.Fatalf("rows = %d notifications = %d, want the approved member greeted once", got, len(f.notifier.got))
	}
}

// Edge 1: the pointer dangles once the channel is deleted or archived.
func TestWelcome_DanglingChannelWritesNothingAndRegistrationSucceeds(t *testing.T) {
	cases := map[string]string{
		"deleted":  `DELETE FROM channels WHERE id = 50`,
		"archived": `UPDATE channels SET archived = 1 WHERE id = 50`,
		"voice":    `UPDATE channels SET type = 'voice' WHERE id = 50`,
	}
	for name, stmt := range cases {
		t.Run(name, func(t *testing.T) {
			f := newWelcomeFixture(t, RegistrationOpen)
			f.pick(t, f.channel)
			if _, err := f.database.ExecContext(f.ctx, stmt); err != nil {
				t.Fatal(err)
			}
			f.register(t, "frank", "")
			if got := f.rows(t); got != 0 || len(f.notifier.got) != 0 {
				t.Fatalf("rows = %d notifications = %d, want 0 and 0", got, len(f.notifier.got))
			}
		})
	}
}

// Edge 2a: the client drops after the account committed; the row is still written.
func TestWelcome_RequestContextCancelledAfterCommitStillWrites(t *testing.T) {
	f := newWelcomeFixture(t, RegistrationOpen)
	f.pick(t, f.channel)
	ctx, cancel := context.WithCancel(f.ctx)
	defer cancel()
	welcome := NewWelcomeService(f.database)
	welcome.SetNotifier(f.notifier)
	svc := NewAuthService(&welcomeDropStore{DB: f.database, cancel: cancel}, auth.NewRateLimiter(), make([]byte, 32), nil)
	svc.UseWelcome(welcome)

	// The result is not asserted: the dropped request may fail its own read-back.
	_, _ = svc.Register(ctx, RegisterInput{Username: "gina", Password: "securePass1", Device: "test", IP: "203.0.113.8"})
	if ctx.Err() == nil {
		t.Fatal("the request context was never cancelled")
	}
	if got := f.rows(t); got != 1 || len(f.notifier.got) != 1 {
		t.Fatalf("rows = %d notifications = %d, want 1 and 1 after the client dropped", got, len(f.notifier.got))
	}
}

// Edge 2b: a failing row insert is logged and never fails the registration.
func TestWelcome_FailedInsertDoesNotFailRegistration(t *testing.T) {
	f := newWelcomeFixture(t, RegistrationOpen)
	f.pick(t, f.channel)
	fault := &failingWelcomeStore{}
	welcome := &WelcomeService{st: f.database, store: fault, notifier: f.notifier}
	f.auth.UseWelcome(welcome)

	res := f.register(t, "hank", "")
	if res.User == nil || res.Token == "" {
		t.Fatalf("registration result = %+v, want a session", res)
	}
	if fault.calls != 1 || f.rows(t) != 0 || len(f.notifier.got) != 0 {
		t.Fatalf("insert calls = %d rows = %d notifications = %d, want 1, 0, 0", fault.calls, f.rows(t), len(f.notifier.got))
	}
}

func TestWelcome_NilServiceGreetsNobody(t *testing.T) {
	var w *WelcomeService
	w.Greet(context.Background(), 1)
	w.SetNotifier(&recordingWelcomeNotifier{})
}

func TestSettingsPatch_WelcomeChannel(t *testing.T) {
	ctx := context.Background()
	database := newTestDB(t)
	uid, _ := database.CreateUser(ctx, "settings-owner", "hash", 1)
	seedChannel(t, database, &db.Channel{ID: 61, Name: "lobby", Type: "text"})
	seedChannel(t, database, &db.Channel{ID: 62, Name: "voice", Type: "voice"})
	seedChannel(t, database, &db.Channel{ID: 63, Name: "old", Type: "text"})
	if _, err := database.ExecContext(ctx, `UPDATE channels SET archived = 1 WHERE id = 63`); err != nil {
		t.Fatal(err)
	}
	svc := NewSettingsService(database)

	for _, bad := range []string{"62", "63", "999", "abc", "-1", "0", "61x", "061"} {
		_, err := svc.Patch(ctx, uid, map[string]string{WelcomeChannelKey: bad})
		if !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s=%q: err = %v, want ErrBadRequest", WelcomeChannelKey, bad, err)
		}
	}
	if settings, _ := svc.List(ctx); settings[WelcomeChannelKey] != "" {
		t.Fatalf("a refused patch wrote %s = %q", WelcomeChannelKey, settings[WelcomeChannelKey])
	}
	got, err := svc.Patch(ctx, uid, map[string]string{WelcomeChannelKey: " 61 "})
	if err != nil || got[WelcomeChannelKey] != "61" {
		t.Fatalf("text channel: stored %q err=%v, want 61", got[WelcomeChannelKey], err)
	}
	got, err = svc.Patch(ctx, uid, map[string]string{WelcomeChannelKey: ""})
	if err != nil || got[WelcomeChannelKey] != "" {
		t.Fatalf("clear: stored %q err=%v, want empty", got[WelcomeChannelKey], err)
	}
	if IsOwnerOnlySettingKey(WelcomeChannelKey) {
		t.Errorf("%s must be MANAGE_SERVER, not owner-only", WelcomeChannelKey)
	}
}

func TestDeleteMessage_WelcomeRowIsDeletable(t *testing.T) {
	f := newWelcomeFixture(t, RegistrationOpen)
	f.pick(t, f.channel)
	res := f.register(t, "ivy", "")
	id := f.notifier.got[0].Row.MessageID
	if err := f.database.DeleteMessage(f.ctx, id, res.User.ID, false); err != nil {
		t.Fatalf("DeleteMessage: %v", err)
	}
	var deleted int
	if err := f.database.QueryRowContext(f.ctx, `SELECT deleted FROM messages WHERE id = ?`, id).Scan(&deleted); err != nil || deleted != 1 {
		t.Fatalf("deleted = %d err=%v, want 1", deleted, err)
	}
}

// A welcome row deletes like a message (its author or a moderator, never a
// plain member) and is the one system row a member may reply to: the wave.
func TestWelcomeRow_DeleteAndReplyRules(t *testing.T) {
	svc, _, database, _ := pinFixture(t)
	ctx := context.Background()
	row, err := database.InsertWelcomeRow(ctx, 10, 2, "mod_bob joined the server.")
	if err != nil {
		t.Fatalf("InsertWelcomeRow: %v", err)
	}
	wave, err := svc.SendMessage(ctx, SendMessageParams{
		ChannelID: 10, UserID: 1, Username: "alice", Content: "\U0001F44B", ReplyTo: &row.MessageID,
	})
	if err != nil || wave == nil {
		t.Fatalf("a wave replying to a welcome row = %v, want it sent", err)
	}
	if _, err := svc.DeleteMessage(ctx, 1, row.MessageID); !errors.Is(err, ErrForbidden) {
		t.Errorf("member delete of another's welcome row = %v, want ErrForbidden", err)
	}
	if _, err := svc.DeleteMessage(ctx, 2, row.MessageID); err != nil {
		t.Errorf("author delete of own welcome row = %v, want nil", err)
	}
}
