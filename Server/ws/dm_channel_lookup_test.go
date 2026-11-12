package ws

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
)

type countingReader struct {
	VisibilityReader
	getChannel atomic.Int32
	dmLookups  atomic.Int32
}

func (r *countingReader) GetChannel(ctx context.Context, id int64) (*db.Channel, error) {
	r.getChannel.Add(1)
	return r.VisibilityReader.GetChannel(ctx, id)
}

func (r *countingReader) ListDMChannelIDsAmong(ctx context.Context, ids []int64) ([]int64, error) {
	r.dmLookups.Add(1)
	return r.VisibilityReader.ListDMChannelIDsAmong(ctx, ids)
}

// A reconnecting user's open DMs count as known without a per-DM channel read.
func TestComputeReadableChannels_OpenDMsNeedNoChannelRead(t *testing.T) {
	f := newRRFixture(t, false)
	ctx := context.Background()
	u := f.addUser("dm-known-a", rrMemberRole, 0)
	peer := f.addUser("dm-known-b", rrMemberRole, 0)
	third := f.addUser("dm-known-c", rrMemberRole, 0)
	oneToOne, _, err := f.database.GetOrCreateDMChannel(ctx, u, peer)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	group, err := f.database.CreateGroupDMChannel(ctx, "crew", u, []int64{u, peer, third})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}
	user, err := f.database.GetUserByID(ctx, u)
	if err != nil || user == nil {
		t.Fatalf("GetUserByID: %v", err)
	}

	reader := &countingReader{VisibilityReader: f.database}
	allowed := map[int64]bool{f.chA: true, oneToOne.ID: true, group.ID: true}
	readable, err := f.hub.computeReadableChannels(ctx, reader, user, allowed)
	if err != nil {
		t.Fatalf("computeReadableChannels: %v", err)
	}
	if n := reader.getChannel.Load(); n != 0 {
		t.Errorf("GetChannel called %d times, want 0", n)
	}
	for id := range allowed {
		if !readable[id] {
			t.Errorf("channel %d not readable", id)
		}
	}
}

// A role refresh round finds the held DMs with one narrow read, not a row per DM.
func TestListRoleChannels_FindsHeldDMsInOneRead(t *testing.T) {
	f := newRRFixture(t, false)
	ctx := context.Background()
	u := f.addUser("rr-held-a", rrMemberRole, f.chA)
	peer := f.addUser("rr-held-b", rrMemberRole, 0)
	third := f.addUser("rr-held-c", rrMemberRole, 0)
	held, _, err := f.database.GetOrCreateDMChannel(ctx, u, peer)
	if err != nil {
		t.Fatalf("GetOrCreateDMChannel: %v", err)
	}
	unheld, err := f.database.CreateGroupDMChannel(ctx, "crew", u, []int64{u, peer, third})
	if err != nil {
		t.Fatalf("CreateGroupDMChannel: %v", err)
	}
	f.hub.pubsub.Subscribe(f.clients[u], ChannelTopic(held.ID))

	reader := &countingReader{VisibilityReader: f.database}
	f.hub.readers.Visibility = reader
	rc, ok := f.hub.listRoleChannels(ctx, []int64{u})
	if !ok {
		t.Fatal("listRoleChannels failed")
	}
	if _, dm := rc.dms[held.ID]; !dm {
		t.Errorf("held DM %d missing from rc.dms", held.ID)
	}
	if _, dm := rc.dms[unheld.ID]; dm {
		t.Errorf("unheld DM %d should not be read", unheld.ID)
	}
	if n := reader.dmLookups.Load(); n != 1 {
		t.Errorf("DM lookups = %d, want 1", n)
	}
	if allowed := f.hub.heldDMs(u, rc); !allowed[held.ID] {
		t.Error("held DM not allowed")
	}
}
