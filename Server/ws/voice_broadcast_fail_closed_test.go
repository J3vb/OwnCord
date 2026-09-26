package ws

import (
	"context"
	"errors"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

// erroringVisibilityReader wraps a real VisibilityReader and forces one of
// GetChannel / IsGroupDM to fail, for filterDMAudience's Codex review round
// 2, P2 fail-closed tests below. Internal package (ws, not ws_test):
// filterDMAudience is unexported.
type erroringVisibilityReader struct {
	VisibilityReader
	failGetChannel bool
	failIsGroupDM  bool
}

func (r erroringVisibilityReader) GetChannel(ctx context.Context, id int64) (*db.Channel, error) {
	if r.failGetChannel {
		return nil, errors.New("simulated GetChannel failure")
	}
	return r.VisibilityReader.GetChannel(ctx, id)
}

func (r erroringVisibilityReader) IsGroupDM(ctx context.Context, channelID int64) (bool, error) {
	if r.failIsGroupDM {
		return false, errors.New("simulated IsGroupDM failure")
	}
	return r.VisibilityReader.IsGroupDM(ctx, channelID)
}

func newFilterDMAudienceTestDB(t *testing.T) *db.DB {
	t.Helper()
	database, err := db.Open(":memory:")
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() { _ = database.Close() })
	if err := db.Migrate(database); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	return database
}

// TestFilterDMAudience_ChannelLookupErrorFailsClosedToSubjectOnly and
// TestFilterDMAudience_GroupLookupErrorFailsClosedToSubjectOnly are Codex
// review round 2, P2: a GetChannel or IsGroupDM error used to fall back to
// the full, unfiltered audience — leaking a DM voice subject's presence to
// everyone in the room the moment either lookup errored. Fail closed
// instead: subjectID alone.
func TestFilterDMAudience_ChannelLookupErrorFailsClosedToSubjectOnly(t *testing.T) {
	database := newFilterDMAudienceTestDB(t)
	ctx := context.Background()
	alice, err := database.CreateUser(ctx, "fda-chan-alice", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	bob, err := database.CreateUser(ctx, "fda-chan-bob", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	ch, _, err := database.GetOrCreateDMChannel(ctx, alice, bob)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	h := newTestHub(t, database, nil, nil)
	h.readers.Visibility = erroringVisibilityReader{VisibilityReader: database, failGetChannel: true}

	got := h.filterDMAudience(ctx, ch.ID, alice, []int64{alice, bob})
	if len(got) != 1 || got[0] != alice {
		t.Errorf("filterDMAudience (GetChannel error) = %v, want [%d] only", got, alice)
	}
}

func TestFilterDMAudience_GroupLookupErrorFailsClosedToSubjectOnly(t *testing.T) {
	database := newFilterDMAudienceTestDB(t)
	ctx := context.Background()
	alice, err := database.CreateUser(ctx, "fda-group-alice", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	bob, err := database.CreateUser(ctx, "fda-group-bob", "hash", 4)
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	ch, _, err := database.GetOrCreateDMChannel(ctx, alice, bob)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}

	h := newTestHub(t, database, nil, nil)
	h.readers.Visibility = erroringVisibilityReader{VisibilityReader: database, failIsGroupDM: true}

	got := h.filterDMAudience(ctx, ch.ID, alice, []int64{alice, bob})
	if len(got) != 1 || got[0] != alice {
		t.Errorf("filterDMAudience (IsGroupDM error) = %v, want [%d] only", got, alice)
	}
}
