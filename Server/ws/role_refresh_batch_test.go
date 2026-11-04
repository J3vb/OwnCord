package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

// memberFrames reads obs's queue and returns each member_update or
// member_update_batch frame as the user ids it carries, in order.
func memberFrames(t *testing.T, f *rrFixture, obs int64, want int) (types []string, frames [][]int64) {
	t.Helper()
	seen := 0
	rrWaitFor(t, "the member frames", func() bool {
		for _, raw := range drainChan(f.sends[obs], 60*time.Millisecond) {
			var env struct {
				Type    string `json:"type"`
				Payload struct {
					UserID  int64 `json:"user_id"`
					Members []struct {
						UserID int64 `json:"user_id"`
					} `json:"members"`
				} `json:"payload"`
			}
			if json.Unmarshal(raw, &env) != nil {
				continue
			}
			switch env.Type {
			case MsgTypeMemberUpdate:
				types = append(types, env.Type)
				frames = append(frames, []int64{env.Payload.UserID})
				seen++
			case MsgTypeMemberUpdateBatch:
				ids := make([]int64, 0, len(env.Payload.Members))
				for _, m := range env.Payload.Members {
					ids = append(ids, m.UserID)
				}
				types = append(types, env.Type)
				frames = append(frames, ids)
				seen += len(ids)
			}
		}
		return seen >= want
	})
	return types, frames
}

// A rename touching 130 holders goes out as three batches (64, 64, 2), and a
// member whose role cannot be read is left out without holding the rest back.
func TestRoleRefresh_MemberUpdatesBatched(t *testing.T) {
	f := newRRFixture(t, true)
	obs := f.addUser("rr-batch-obs", rrModRole, 0)
	ctx := context.Background()
	const m = 130
	ids := make([]int64, 0, m+1)
	for i := range m {
		id, err := f.database.CreateUser(ctx, fmt.Sprintf("rr-batch-%03d", i), "hash", rrMemberRole)
		if err != nil {
			t.Fatalf("CreateUser: %v", err)
		}
		ids = append(ids, id)
		if i == 70 {
			ids = append(ids, 987654) // no such user: its role cannot be read
		}
	}
	f.hub.EnqueueRoleRefresh(RoleRefresh{MemberUpdate: ids})
	waitRoleRefreshIdle(t, f.hub)

	types, frames := memberFrames(t, f, obs, m)
	if !slices.Equal(types, []string{MsgTypeMemberUpdateBatch, MsgTypeMemberUpdateBatch, MsgTypeMemberUpdateBatch}) {
		t.Fatalf("frame types = %v, want three member_update_batch frames", types)
	}
	var got []int64
	for i, fr := range frames {
		if want := []int{64, 64, 2}[i]; len(fr) != want {
			t.Errorf("batch %d carries %d members, want %d", i, len(fr), want)
		}
		got = append(got, fr...)
	}
	want := slices.DeleteFunc(slices.Clone(ids), func(id int64) bool { return id == 987654 })
	if !slices.Equal(got, want) {
		t.Errorf("members out of order, missing or including the unreadable one (%d of %d)", len(got), len(want))
	}
}

// One member keeps the plain member_update every client version understands, and a
// list where no role can be read sends nothing.
func TestRoleRefresh_SingleMemberUpdateStaysPlain(t *testing.T) {
	f := newRRFixture(t, true)
	obs := f.addUser("rr-single-obs", rrModRole, 0)
	holder := f.addUser("rr-single-holder", rrMemberRole, 0)

	f.hub.EnqueueRoleRefresh(RoleRefresh{MemberUpdate: []int64{987654}})
	waitRoleRefreshIdle(t, f.hub)
	f.hub.EnqueueRoleRefresh(RoleRefresh{MemberUpdate: []int64{holder}})
	waitRoleRefreshIdle(t, f.hub)

	types, frames := memberFrames(t, f, obs, 1)
	if !slices.Equal(types, []string{MsgTypeMemberUpdate}) || !slices.Equal(frames[0], []int64{holder}) {
		t.Errorf("frames = %v %v, want one plain member_update for %d only", types, frames, holder)
	}
}

// A member erased after the round read it costs only its own entry: the rest of the
// batch is still sequenced, and a batch left with one member goes out plain.
func TestMemberUpdates_ErasedMemberLeavesTheRestOfTheBatch(t *testing.T) {
	ctx := context.Background()
	h := newTestHubWith(t, HubOptions{DB: newTeardownTestDB(t)})
	if err := h.PurgeUserFromReplay(ctx, 42); err != nil {
		t.Fatalf("PurgeUserFromReplay: %v", err)
	}
	send := func(ids ...int64) {
		members := make([]memberUpdatePayload, 0, len(ids))
		for _, id := range ids {
			members = append(members, memberUpdatePayload{UserID: id, Role: "r"})
		}
		h.deliverBroadcast(broadcastMsg{msg: memberUpdatesMsg(members), members: members})
	}
	sequenceFiller(h) // the ring replays only after a frame newer than its oldest
	sequenceFiller(h)
	before := atomic.LoadUint64(&h.seq)
	send(41, 42, 43)
	send(42, 44)
	send(42)

	type frame struct {
		Type    string `json:"type"`
		Payload struct {
			UserID  int64 `json:"user_id"`
			Members []struct {
				UserID int64 `json:"user_id"`
			} `json:"members"`
		} `json:"payload"`
	}
	events := h.replayBuf.EventsSince(before)
	got := make([]string, 0, len(events))
	for _, data := range events {
		var f frame
		if err := json.Unmarshal(data, &f); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		ids := []int64{f.Payload.UserID}
		if f.Type == MsgTypeMemberUpdateBatch {
			ids = ids[:0]
			for _, m := range f.Payload.Members {
				ids = append(ids, m.UserID)
			}
		}
		got = append(got, fmt.Sprint(f.Type, ids))
	}
	want := []string{"member_update_batch[41 43]", "member_update[44]"}
	if !slices.Equal(got, want) {
		t.Errorf("sequenced frames = %v, want %v", got, want)
	}
}
