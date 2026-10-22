package service

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/auth"
	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/permissions"
)

// failingThreadStore is a ThreadStore whose every call fails with err.
type failingThreadStore struct{ err error }

func (s failingThreadStore) GetThreadByStarter(context.Context, int64) (*db.ThreadInfo, error) {
	return nil, s.err
}
func (s failingThreadStore) CreateThread(context.Context, db.NewThread) (*db.ThreadInfo, bool, error) {
	return nil, false, s.err
}
func (s failingThreadStore) GetThread(context.Context, int64) (*db.ThreadInfo, error) {
	return nil, s.err
}
func (s failingThreadStore) ListThreadsBy(context.Context, int64, bool, db.ThreadListOptions, db.ThreadCursor, int) ([]db.ThreadListRow, error) {
	return nil, s.err
}
func (s failingThreadStore) UpdateThread(context.Context, int64, db.ThreadPatch, bool) (*db.ThreadInfo, error) {
	return nil, s.err
}
func (s failingThreadStore) DeleteThread(context.Context, int64) (bool, error) { return false, s.err }
func (s failingThreadStore) NextThreadArchiveDue(context.Context) (time.Time, bool, error) {
	return time.Time{}, false, s.err
}
func (s failingThreadStore) ArchiveDueThreads(context.Context, time.Time, int) ([]db.DueThread, int, error) {
	return nil, 0, s.err
}

func TestThreadService_WithoutThreadStorageAnswersInternal(t *testing.T) {
	f := newThreadFixture(t)
	// A Store that is not a ThreadStore leaves the service without storage.
	svc := &ThreadService{st: f.database, perms: f.perms, limiter: auth.NewRateLimiter()}
	name := "x"
	checks := map[string]func() error{
		"create": func() error {
			_, _, err := svc.Create(bg(), CreateThreadParams{UserID: thrOwner, ChannelID: thrParent, MessageID: 1, Name: "a"})
			return err
		},
		"update": func() error {
			_, err := svc.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: 1, Name: &name})
			return err
		},
		"delete": func() error { _, err := svc.Delete(bg(), thrMod, 1); return err },
		"get":    func() error { _, err := svc.Get(bg(), 1); return err },
		"list": func() error {
			_, _, _, err := svc.List(bg(), thrOwner, thrParent, ThreadListParams{}, ThreadCursor{}, 5)
			return err
		},
	}
	for op, call := range checks {
		if err := call(); !errors.Is(err, ErrInternal) {
			t.Errorf("%s without storage = %v, want ErrInternal", op, err)
		}
	}
	if NewThreadService(f.database, f.perms, nil).ts == nil {
		t.Error("a *db.DB store must satisfy ThreadStore")
	}
}

func TestThreadService_StoreFailuresAreInternalNotLeaked(t *testing.T) {
	f := newThreadFixture(t)
	secret := errors.New("disk exploded: /var/secret/path")
	svc := &ThreadService{st: f.database, ts: failingThreadStore{secret}, perms: f.perms, limiter: auth.NewRateLimiter()}
	name := "x"
	checks := map[string]func() error{
		"create": func() error {
			_, _, err := svc.Create(bg(), CreateThreadParams{UserID: thrOwner, ChannelID: thrParent, MessageID: 1, Name: "a"})
			return err
		},
		"update": func() error {
			_, err := svc.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: 1, Name: &name})
			return err
		},
		"delete": func() error { _, err := svc.Delete(bg(), thrMod, 1); return err },
		"get":    func() error { _, err := svc.Get(bg(), 1); return err },
		"list": func() error {
			_, _, _, err := svc.List(bg(), thrOwner, thrParent, ThreadListParams{}, ThreadCursor{}, 5)
			return err
		},
	}
	for op, call := range checks {
		if err := call(); !errors.Is(err, ErrInternal) || !errors.Is(err, secret) {
			t.Errorf("%s with a failing store = %v, want ErrInternal wrapping the cause", op, err)
		}
	}
}

func TestThreadService_GetIsUngatedAndNilForUnknown(t *testing.T) {
	f := newThreadFixture(t)
	th := f.start(t, thrOwner, "open")
	if got, err := f.threads.Get(bg(), th.ID); err != nil || got == nil || got.ID != th.ID {
		t.Fatalf("Get = %+v, %v", got, err)
	}
	if got, err := f.threads.Get(bg(), 987654); err != nil || got != nil {
		t.Fatalf("Get(unknown) = %+v, %v, want nil, nil", got, err)
	}
}

func TestThreadExistsError_NamesTheWinnerAndIsAConflict(t *testing.T) {
	err := error(&ThreadExistsError{ThreadID: 9})
	if !errors.Is(err, ErrThreadExists) || !errors.Is(err, ErrConflict) {
		t.Error("ThreadExistsError must match ErrThreadExists and ErrConflict")
	}
	if msg := err.Error(); msg == "" || !contains(msg, "9") {
		t.Errorf("message = %q, want the thread id", msg)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

func TestThreadCreate_OwnerRetryNeedsViewOnParentAndRefusesBadInput(t *testing.T) {
	f := newThreadFixture(t)
	th := f.start(t, thrOwner, "mine")
	p := CreateThreadParams{UserID: thrOwner, ChannelID: thrParent, MessageID: *th.StarterMessageID, Name: "mine"}
	if got, created, err := f.threads.Create(bg(), p); err != nil || created || got.ID != th.ID {
		t.Fatalf("retry = %+v, %v, %v", got, created, err)
	}
	// An owner who has lost the parent gets nothing back, and no thread leaks.
	seedChannelOverride(t, f.database, permissions.MemberRoleID, thrParent, 0, permissions.ReadMessages)
	f.perms.InvalidateAll()
	if got, _, err := f.threads.Create(bg(), p); err == nil || got != nil {
		t.Fatalf("retry without parent READ = %+v, %v, want a refusal", got, err)
	}
	if _, _, err := f.threads.Create(bg(), CreateThreadParams{UserID: thrOwner, ChannelID: -1, MessageID: 1, Name: "a"}); !errors.Is(err, ErrBadRequest) {
		t.Errorf("negative channel = %v, want ErrBadRequest", err)
	}
}

func TestThreadCreate_OnlyInTextChannels(t *testing.T) {
	f := newThreadFixture(t)
	seedChannel(t, f.database, &db.Channel{ID: 12, Name: "voice", Type: "voice"})
	voiceMsg := f.post(t, 12, thrOwner, "hello")
	if _, _, err := f.threads.Create(bg(), CreateThreadParams{UserID: thrOwner, ChannelID: 12, MessageID: voiceMsg, Name: "a"}); err == nil {
		t.Fatal("a thread started in a voice channel")
	}
}

func TestThreadActor_Refusals(t *testing.T) {
	f := newThreadFixture(t)
	th := f.start(t, thrOwner, "t")
	name := "n"

	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: 0, Name: &name}); !errors.Is(err, ErrBadRequest) {
		t.Errorf("thread id 0 = %v, want ErrBadRequest", err)
	}
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: 987654, Name: &name}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown thread = %v, want ErrNotFound", err)
	}
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: thrParent, Name: &name}); !errors.Is(err, ErrNotFound) {
		t.Errorf("an ordinary channel as thread = %v, want ErrNotFound", err)
	}
	if _, err := f.threads.Delete(bg(), thrMod, 987654); !errors.Is(err, ErrNotFound) {
		t.Errorf("delete unknown = %v, want ErrNotFound", err)
	}
	if _, err := f.threads.Delete(bg(), thrOwner, th.ID); !errors.Is(err, ErrForbidden) {
		t.Errorf("owner delete = %v, want ErrForbidden", err)
	}

	// A member who cannot read the parent sees no thread at all.
	seedChannelOverride(t, f.database, permissions.MemberRoleID, thrParent, 0, permissions.ReadMessages)
	f.perms.InvalidateAll()
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, Name: &name}); !errors.Is(err, ErrNotFound) {
		t.Errorf("update without parent READ = %v, want ErrNotFound", err)
	}
}

func TestThreadActor_TimedOutOwnerIsRefused(t *testing.T) {
	f := newThreadFixture(t)
	th := f.start(t, thrOwner, "t")
	if _, err := f.database.ExecContext(bg(), `UPDATE roles SET permissions = permissions | ? WHERE id = ?`,
		permissions.ModerateMembers, permissions.ModeratorRoleID); err != nil {
		t.Fatal(err)
	}
	f.perms.InvalidateAll()
	mod := NewModerationService(f.database, f.perms)
	if _, err := mod.Timeout(bg(), thrMod, thrOwner, "cool off", time.Hour, nil); err != nil {
		t.Fatalf("Timeout: %v", err)
	}
	name := "n"
	if _, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, Name: &name}); !errors.Is(err, ErrTimedOut) {
		t.Errorf("timed-out owner update = %v, want ErrTimedOut", err)
	}
	if got, _ := f.threads.Get(bg(), th.ID); got == nil || got.Name != "t" {
		t.Errorf("a refused update changed the thread: %+v", got)
	}
}

func TestThreadUpdate_PatchValidation(t *testing.T) {
	f := newThreadFixture(t)
	th := f.start(t, thrOwner, "t")
	long := string(make([]rune, 101))
	blank := "   "
	zero, bad, good := 0, 7, 60
	for name, p := range map[string]UpdateThreadParams{
		"name too long":  {Name: &long},
		"blank name":     {Name: &blank},
		"zero period":    {AutoArchiveMinutes: &zero},
		"unknown period": {AutoArchiveMinutes: &bad},
	} {
		p.UserID, p.ThreadID = thrOwner, th.ID
		if _, err := f.threads.Update(bg(), p); !errors.Is(err, ErrBadRequest) {
			t.Errorf("%s = %v, want ErrBadRequest", name, err)
		}
	}
	got, err := f.threads.Update(bg(), UpdateThreadParams{UserID: thrOwner, ThreadID: th.ID, AutoArchiveMinutes: &good})
	if err != nil || got.AutoArchiveMinutes != 60 {
		t.Errorf("valid period = %+v, %v", got, err)
	}
}

func TestThreadDelete_ReportsThreadAsItWasAndRemovesIt(t *testing.T) {
	f := newThreadFixture(t)
	th := f.start(t, thrOwner, "doomed")
	f.post(t, th.ID, thrOwner, "inside")
	gone, err := f.threads.Delete(bg(), thrMod, th.ID)
	if err != nil || gone.ID != th.ID || gone.ParentID != thrParent || gone.Name != "doomed" {
		t.Fatalf("Delete = %+v, %v", gone, err)
	}
	if after, _ := f.threads.Get(bg(), th.ID); after != nil {
		t.Errorf("thread survived: %+v", after)
	}
	// The starter message stays in the parent, without a thread.
	msgs, err := f.database.GetMessagesForAPI(bg(), thrParent, 0, 10, thrOwner)
	if err != nil || len(msgs) != 1 || msgs[0].Thread != nil {
		t.Errorf("parent history after delete = %+v, %v", msgs, err)
	}
}

func TestThreadList_LimitsAndGates(t *testing.T) {
	f := newThreadFixture(t)
	for i := range 3 {
		f.start(t, thrMod, fmt.Sprintf("t%d", i))
	}
	// A zero or negative limit means the default; an oversized one is capped.
	for _, limit := range []int{0, -5, 100000} {
		page, _, more, err := f.threads.List(bg(), thrOther, thrParent, ThreadListParams{}, ThreadCursor{}, limit)
		if err != nil || len(page) != 3 || more {
			t.Errorf("limit %d = %d threads, more=%v, err=%v, want all 3", limit, len(page), more, err)
		}
	}
	page, next, more, err := f.threads.List(bg(), thrOther, thrParent, ThreadListParams{}, ThreadCursor{}, 3)
	if err != nil || more || len(page) != 3 || next.ID != page[2].ID {
		t.Errorf("exact page = %d, next %+v, more %v, err %v", len(page), next, more, err)
	}
	if _, _, _, err := f.threads.List(bg(), thrOther, 0, ThreadListParams{}, ThreadCursor{}, 5); !errors.Is(err, ErrBadRequest) {
		t.Errorf("parent 0 = %v, want ErrBadRequest", err)
	}
	if _, _, _, err := f.threads.List(bg(), thrOther, 987654, ThreadListParams{}, ThreadCursor{}, 5); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown parent = %v, want ErrNotFound", err)
	}
	empty, next, more, err := f.threads.List(bg(), thrOther, thrParent, ThreadListParams{Archived: true}, ThreadCursor{}, 5)
	if err != nil || len(empty) != 0 || more || next != (ThreadCursor{}) {
		t.Errorf("no archived threads = %+v %+v %v %v", empty, next, more, err)
	}
}

func TestMapThreadErr_KindsAndWrapping(t *testing.T) {
	cause := errors.New("boom")
	cases := []struct {
		name string
		in   error
		want error
	}{
		{"starter gone", fmt.Errorf("x: %w", db.ErrThreadStarterInvalid), ErrNotFound},
		{"thread gone", db.ErrThreadGone, ErrNotFound},
		{"not found", db.ErrNotFound, ErrNotFound},
		{"locked", db.ErrThreadLockedForActor, permissions.ErrThreadLocked},
		{"erasing", db.ErrAccountErasing, ErrForbidden},
		{"other", cause, ErrInternal},
	}
	for _, c := range cases {
		if got := mapThreadErr(c.in); !errors.Is(got, c.want) {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
	var exists *ThreadExistsError
	if got := mapThreadErr(&db.ThreadExistsError{ThreadID: 5}); !errors.As(got, &exists) || exists.ThreadID != 5 {
		t.Errorf("exists = %v", got)
	}
	if got := mapThreadErr(cause); !errors.Is(got, cause) {
		t.Error("an internal error must keep its cause for logs")
	}
}

func TestAdmitThreadFocus_ThroughTheParent(t *testing.T) {
	f := newThreadFixture(t)
	th := f.start(t, thrOwner, "focus")
	channels := NewChannelService(f.database, f.perms)

	ch, err := channels.AdmitThreadFocus(bg(), thrOther, th.ID)
	if err != nil || ch == nil || ch.ID != th.ID || !ch.IsThread() {
		t.Fatalf("admit = %+v, %v", ch, err)
	}
	if _, err := channels.AdmitThreadFocus(bg(), thrOther, 0); !errors.Is(err, ErrBadRequest) {
		t.Errorf("thread 0 = %v, want ErrBadRequest", err)
	}
	if _, err := channels.AdmitThreadFocus(bg(), thrOther, 987654); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown = %v, want ErrNotFound", err)
	}
	// An ordinary channel is not a thread: channel_focus is its door.
	if _, err := channels.AdmitThreadFocus(bg(), thrOther, thrParent); !errors.Is(err, ErrNotFound) {
		t.Errorf("ordinary channel = %v, want ErrNotFound", err)
	}

	seedChannelOverride(t, f.database, permissions.MemberRoleID, thrParent, 0, permissions.ReadMessages)
	f.perms.InvalidateAll()
	if _, err := channels.AdmitThreadFocus(bg(), thrOther, th.ID); !errors.Is(err, ErrForbidden) {
		t.Errorf("without parent READ = %v, want ErrForbidden", err)
	}
	if _, err := channels.HandleThreadFocus(bg(), thrOther, th.ID); !errors.Is(err, ErrForbidden) {
		t.Errorf("HandleThreadFocus without parent READ = %v, want ErrForbidden", err)
	}
}

func TestHandleThreadFocus_MarksTheThreadRead(t *testing.T) {
	f := newThreadFixture(t)
	th := f.start(t, thrOwner, "read")
	last := f.post(t, th.ID, thrOwner, "latest")
	channels := NewChannelService(f.database, f.perms)

	if _, err := channels.HandleThreadFocus(bg(), thrOther, th.ID); err != nil {
		t.Fatal(err)
	}
	lastRead, mentions, found, err := f.database.GetReadState(bg(), thrOther, th.ID)
	if err != nil || !found || lastRead != last || mentions != 0 {
		t.Errorf("read state = %d/%d found=%v err=%v, want read through %d", lastRead, mentions, found, err, last)
	}
}

// recordingStore is a threadArchiveStore with scripted answers.
type recordingStore struct {
	mu        sync.Mutex
	due       time.Time
	dueOK     bool
	dueErr    error
	sweepErrs []error
	batches   [][]db.DueThread
	listed    []int
	calls     int
}

func (s *recordingStore) NextThreadArchiveDue(context.Context) (time.Time, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.due, s.dueOK, s.dueErr
}

func (s *recordingStore) ArchiveDueThreads(context.Context, time.Time, int) ([]db.DueThread, int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	i := s.calls
	s.calls++
	if i < len(s.sweepErrs) && s.sweepErrs[i] != nil {
		return nil, 0, s.sweepErrs[i]
	}
	if i < len(s.batches) {
		return s.batches[i], s.listed[i], nil
	}
	return nil, 0, nil
}

func (s *recordingStore) sweeps() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.calls
}

func fastArchiver(st threadArchiveStore) *ThreadArchiver {
	return &ThreadArchiver{
		st: st, now: time.Now, slack: 0, maxSleep: 20 * time.Millisecond, retryAfter: 10 * time.Millisecond,
	}
}

func TestThreadArchiver_SweepDrainsFullBatchesAndSurfacesErrors(t *testing.T) {
	full := make([]db.DueThread, threadArchiveBatch)
	for i := range full {
		full[i] = db.DueThread{ID: int64(i + 1), ParentID: 1}
	}
	st := &recordingStore{
		batches: [][]db.DueThread{full, {{ID: 999, ParentID: 1}}},
		listed:  []int{threadArchiveBatch, 1},
	}
	a := fastArchiver(st)
	rec := &threadRecorder{}
	a.SetNotifier(rec)
	if err := a.Sweep(bg()); err != nil {
		t.Fatal(err)
	}
	if st.sweeps() != 2 || len(rec.got()) != threadArchiveBatch+1 {
		t.Errorf("sweeps %d, notified %d, want 2 and %d", st.sweeps(), len(rec.got()), threadArchiveBatch+1)
	}

	// A full batch that archived nothing (all re-posted meanwhile) ends the sweep.
	idle := &recordingStore{batches: [][]db.DueThread{nil}, listed: []int{threadArchiveBatch}}
	if err := fastArchiver(idle).Sweep(bg()); err != nil || idle.sweeps() != 1 {
		t.Errorf("idle full batch: err %v sweeps %d, want one sweep", err, idle.sweeps())
	}

	boom := errors.New("boom")
	failing := &recordingStore{sweepErrs: []error{boom}}
	if err := fastArchiver(failing).Sweep(bg()); !errors.Is(err, boom) {
		t.Errorf("sweep error = %v, want it wrapped", err)
	}
	// Without storage nothing runs, and Run returns at once.
	none := &ThreadArchiver{}
	if err := none.Sweep(bg()); err != nil {
		t.Errorf("storage-less sweep = %v", err)
	}
	done := make(chan struct{})
	go func() { none.Run(bg()); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("storage-less Run did not return")
	}
	if NewThreadArchiver(struct{ Store }{}).st != nil {
		t.Error("an archiver over a store without thread storage must be inert")
	}
}

func TestThreadArchiver_RunSweepsRetriesAndStops(t *testing.T) {
	boom := errors.New("boom")
	st := &recordingStore{
		sweepErrs: []error{boom}, // the first sweep fails, then the retry succeeds
		batches:   [][]db.DueThread{nil, {{ID: 5, ParentID: 1}}},
		listed:    []int{0, 1},
	}
	a := fastArchiver(st)
	rec := &threadRecorder{}
	a.SetNotifier(rec)
	ctx, cancel := context.WithCancel(bg())
	done := make(chan struct{})
	go func() { a.Run(ctx); close(done) }()

	deadline := time.Now().Add(5 * time.Second)
	for len(rec.got()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if got := rec.got(); len(got) == 0 || got[0] != 5 {
		t.Fatalf("notified %v, want thread 5 after the failed sweep was retried", got)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not exit on cancel")
	}
}

func TestThreadArchiver_ReadFailureBacksOffWithoutSweeping(t *testing.T) {
	st := &recordingStore{dueErr: errors.New("read failed")}
	a := fastArchiver(st)
	sleep, failed := a.nextSleep(bg())
	if !failed || sleep != a.retryAfter {
		t.Fatalf("nextSleep = %v, %v, want the retry delay and failed", sleep, failed)
	}
	ctx, cancel := context.WithCancel(bg())
	done := make(chan struct{})
	go func() { a.Run(ctx); close(done) }()
	time.Sleep(60 * time.Millisecond)
	cancel()
	<-done
	if st.sweeps() != 0 {
		t.Errorf("%d sweeps ran while the due read was failing", st.sweeps())
	}

	// A due time in the past sleeps zero; a far one is capped.
	st2 := &recordingStore{dueOK: true, due: time.Now().Add(-time.Hour)}
	if s, failed := fastArchiver(st2).nextSleep(bg()); failed || s != 0 {
		t.Errorf("past due sleep = %v, %v, want 0", s, failed)
	}
	st2.due = time.Now().Add(time.Hour)
	if s, _ := fastArchiver(st2).nextSleep(bg()); s != 20*time.Millisecond {
		t.Errorf("far due sleep = %v, want the cap", s)
	}
}

func TestThreadArchiver_SleepOrDoneReturnsOnCancel(t *testing.T) {
	a := fastArchiver(&recordingStore{})
	ctx, cancel := context.WithCancel(bg())
	cancel()
	start := time.Now()
	a.sleepOrDone(ctx, time.Hour)
	if time.Since(start) > time.Second {
		t.Error("sleepOrDone ignored a cancelled context")
	}
	start = time.Now()
	a.sleepOrDone(bg(), 5*time.Millisecond)
	if time.Since(start) < 4*time.Millisecond {
		t.Error("sleepOrDone returned before its delay")
	}
}

func TestThreadCursorFor_CreatedSortIsIDOnly(t *testing.T) {
	c, err := ParseThreadCursorFor(ThreadSortCreated, "42")
	if err != nil || c.ID != 42 || c.Activity != "" {
		t.Fatalf("parse created = %+v, %v", c, err)
	}
	if got := FormatThreadCursorFor(ThreadSortCreated, c); got != "42" {
		t.Errorf("format created = %q", got)
	}
	if c, err := ParseThreadCursorFor(ThreadSortCreated, ""); err != nil || c.ID != 0 {
		t.Errorf("empty created cursor = %+v, %v", c, err)
	}
	for _, bad := range []string{"0", "-1", "x", "2026-01-01T00:00:00Z_5"} {
		if _, err := ParseThreadCursorFor(ThreadSortCreated, bad); !errors.Is(err, ErrBadRequest) {
			t.Errorf("created cursor %q: err = %v", bad, err)
		}
	}
	if _, err := ParseThreadCursorFor(ThreadSortActivity, "42"); !errors.Is(err, ErrBadRequest) {
		t.Errorf("a created cursor must not parse under activity: %v", err)
	}
}
