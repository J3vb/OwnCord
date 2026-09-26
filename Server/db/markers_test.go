package db

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func testMarkerKey(b byte) []byte {
	key := make([]byte, 32)
	for i := range key {
		key[i] = b
	}
	return key
}

func openTestMarkers(t *testing.T, key []byte) *MarkerStore {
	t.Helper()
	m, err := OpenMarkerStore(filepath.Join(t.TempDir(), "erasure", "markers.sqlite"), key)
	if err != nil {
		t.Fatalf("OpenMarkerStore: %v", err)
	}
	t.Cleanup(func() { _ = m.Close() })
	return m
}

func TestMarkerStore_TokenIsKeyedAndUnlinkable(t *testing.T) {
	a := openTestMarkers(t, testMarkerKey(1))
	b := openTestMarkers(t, testMarkerKey(2))
	tok := a.SubjectToken(42)
	if len(tok) != 64 || tok != a.SubjectToken(42) {
		t.Fatalf("token = %q, want a stable 64-hex digest", tok)
	}
	if tok == b.SubjectToken(42) {
		t.Error("the same id under another key yields the same token; the key does not bind it")
	}
	if strings.Contains(tok, "42") && a.SubjectToken(420)[:10] == tok[:10] {
		t.Error("token leaks the id")
	}
	if a.SubjectToken(42) == a.SubjectToken(43) {
		t.Error("two subjects share a token")
	}
	if _, err := OpenMarkerStore(":memory:", []byte("short")); err == nil {
		t.Error("a short key was accepted")
	}
}

func TestMarkerStore_PendingConfirmDiscard(t *testing.T) {
	ctx := context.Background()
	m := openTestMarkers(t, testMarkerKey(3))
	tok, created, err := m.RecordPendingAccount(ctx, 7, 0)
	if err != nil || !created || tok != m.SubjectToken(7) {
		t.Fatalf("RecordPendingAccount = %q, %v, %v", tok, created, err)
	}
	if _, again, err := m.RecordPendingAccount(ctx, 7, 0); err != nil || again {
		t.Fatalf("second RecordPendingAccount created = %v, %v; want false", again, err)
	}
	markers, err := m.Markers(ctx)
	if err != nil || len(markers) != 1 || markers[0].State != MarkerPending || markers[0].Scope != MarkerScopeAccount {
		t.Fatalf("markers = %+v, %v", markers, err)
	}
	if err := m.DiscardPending(ctx, tok); err != nil {
		t.Fatal(err)
	}
	if markers, _ := m.Markers(ctx); len(markers) != 0 {
		t.Fatalf("discard left %+v", markers)
	}
	if _, _, err := m.RecordPendingAccount(ctx, 7, 0); err != nil {
		t.Fatal(err)
	}
	if err := m.ConfirmAccount(ctx, tok); err != nil {
		t.Fatal(err)
	}
	markers, _ = m.Markers(ctx)
	if len(markers) != 1 || markers[0].State != MarkerRecorded {
		t.Fatalf("after confirm: %+v", markers)
	}
	// A recorded marker is not discarded by DiscardPending.
	if err := m.DiscardPending(ctx, tok); err != nil {
		t.Fatal(err)
	}
	if markers, _ := m.Markers(ctx); len(markers) != 1 {
		t.Fatalf("DiscardPending removed a recorded marker")
	}
	// The file survives a reopen with the same key and refuses nothing.
	path := m.Path()
	_ = m.Close()
	reopened, err := OpenMarkerStore(path, testMarkerKey(3))
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if markers, _ := reopened.Markers(ctx); len(markers) != 1 {
		t.Fatalf("markers after reopen = %+v", markers)
	}
}

// ReplayAccounts on an in-memory database: a marker whose account is
// present erases it — recorded, or still pending from a crash (a restore
// can revert the commit the pending marker was waiting on, so a present
// account proves nothing, and the request behind the marker was
// authorised); a pending marker whose account is gone is confirmed;
// recorded markers for absent accounts do nothing.
func TestMarkerStore_ReplayAccounts(t *testing.T) {
	ctx := context.Background()
	database := openMigratedMemoryInternal(t)
	m := openTestMarkers(t, testMarkerKey(4))
	owner, _ := database.CreateUser(ctx, "replay-owner", "hash", 1)
	resurrected, _ := database.CreateUser(ctx, "resurrected", "hash", 4)
	crashedBefore, _ := database.CreateUser(ctx, "crashed-before-commit", "hash", 4)
	gone, _ := database.CreateUser(ctx, "crashed-after-commit", "hash", 4)
	if _, err := database.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, gone); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{resurrected} {
		tok, _, _ := m.RecordPendingAccount(ctx, id, 0)
		_ = m.ConfirmAccount(ctx, tok)
	}
	_, _, _ = m.RecordPendingAccount(ctx, crashedBefore, 0)
	_, _, _ = m.RecordPendingAccount(ctx, gone, 0)

	var erased []int64
	rep, err := m.ReplayAccounts(ctx, database, func(ctx context.Context, userID int64, token string) error {
		if token != m.SubjectToken(userID) {
			t.Errorf("erase called with token %q for %d", token, userID)
		}
		erased = append(erased, userID)
		_, err := database.ReplayEraseAccount(ctx, userID, token)
		return err
	})
	if err != nil {
		t.Fatalf("ReplayAccounts: %v", err)
	}
	if rep.Erased != 2 || rep.Confirmed != 1 {
		t.Errorf("report = %+v, want 2 erased (one recorded, one pending), 1 confirmed", rep)
	}
	slices.Sort(erased)
	if want := []int64{resurrected, crashedBefore}; !slices.Equal(erased, want) {
		t.Errorf("erased = %v, want %v", erased, want)
	}
	if u, _ := database.GetUserByID(ctx, resurrected); u != nil {
		t.Error("the resurrected account survived the replay")
	}
	if u, _ := database.GetUserByID(ctx, crashedBefore); u != nil {
		t.Error("the account behind a pending marker survived the replay")
	}
	if u, _ := database.GetUserByID(ctx, owner); u == nil {
		t.Error("an account without a marker was erased")
	}
	markers, _ := m.Markers(ctx)
	byTok := map[string]DeletionMarker{}
	for _, mk := range markers {
		byTok[mk.SubjectToken] = mk
	}
	if mk := byTok[m.SubjectToken(resurrected)]; mk.Replays != 1 || mk.LastReplay == nil {
		t.Errorf("replayed marker = %+v, want replays 1", mk)
	}
	if mk, ok := byTok[m.SubjectToken(gone)]; !ok || mk.State != MarkerRecorded {
		t.Errorf("marker for the account gone before confirm = %+v, want recorded", mk)
	}
	if mk, ok := byTok[m.SubjectToken(crashedBefore)]; !ok || mk.State != MarkerRecorded || mk.Replays != 0 {
		t.Errorf("marker applied while pending = %+v, want recorded, not counted as a replay", mk)
	}
	// A second replay finds nothing to do.
	rep, err = m.ReplayAccounts(ctx, database, func(context.Context, int64, string) error { t.Error("erase called again"); return nil })
	if err != nil || rep != (ReplayReport{}) {
		t.Errorf("second replay = %+v, %v", rep, err)
	}
}

func openMigratedMemoryInternal(t *testing.T) *DB {
	t.Helper()
	database, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := Migrate(database); err != nil {
		t.Fatal(err)
	}
	return database
}

func TestMarkerStore_FileLivesOutsideTheDatabase(t *testing.T) {
	dir := t.TempDir()
	m, err := OpenMarkerStore(filepath.Join(dir, "data", "erasure", "markers.sqlite"), testMarkerKey(6))
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	if _, _, err := m.RecordPendingAccount(context.Background(), 1, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "data", "erasure", "markers.sqlite")); err != nil {
		t.Errorf("marker file not created: %v", err)
	}
}

func TestMarkerStore_MessagesMarkersMoveForwardAndReplay(t *testing.T) {
	ctx := context.Background()
	m := openTestMarkers(t, testMarkerKey(7))
	if m.MessagesToken(5) == m.SubjectToken(5) || m.MessagesToken(5) == m.MessagesToken(6) {
		t.Fatal("messages tokens collide with account tokens or each other")
	}
	if err := m.RecordMessagesSweep(ctx, 5, "2026-09-01 00:00:00", 0); err != nil {
		t.Fatal(err)
	}
	if err := m.RecordMessagesSweep(ctx, 5, "2026-09-02 00:00:00", 0); err != nil {
		t.Fatal(err)
	}
	// An older cutoff never moves the marker back.
	if err := m.RecordMessagesSweep(ctx, 5, "2026-08-01 00:00:00", 0); err != nil {
		t.Fatal(err)
	}
	markers, _ := m.Markers(ctx)
	if len(markers) != 1 || markers[0].Scope != MarkerScopeMessages || *markers[0].ChannelID != 5 || *markers[0].Cutoff != "2026-09-02 00:00:00" {
		t.Fatalf("markers = %+v", markers)
	}
	calls := map[int64]string{}
	n, err := m.ReplayMessages(ctx, func(_ context.Context, ch int64, cutoff string) (int, error) {
		calls[ch] = cutoff
		return 3, nil
	})
	if err != nil || n != 3 || calls[5] != "2026-09-02 00:00:00" {
		t.Fatalf("ReplayMessages = %d, %v, calls %v", n, err, calls)
	}
	markers, _ = m.Markers(ctx)
	if markers[0].Replays != 1 {
		t.Errorf("replays = %d, want 1", markers[0].Replays)
	}
	// Account markers are not handed to the messages sweep.
	tok, _, _ := m.RecordPendingAccount(ctx, 9, 0)
	_ = m.ConfirmAccount(ctx, tok)
	n, err = m.ReplayMessages(ctx, func(_ context.Context, ch int64, _ string) (int, error) {
		if ch != 5 {
			t.Errorf("unexpected channel %d", ch)
		}
		return 0, nil
	})
	if err != nil || n != 0 {
		t.Errorf("second replay = %d, %v", n, err)
	}
	markers, _ = m.Markers(ctx)
	for _, mk := range markers {
		if mk.Scope == MarkerScopeMessages && mk.Replays != 1 {
			t.Errorf("an idle replay counted: %+v", mk)
		}
	}
}
