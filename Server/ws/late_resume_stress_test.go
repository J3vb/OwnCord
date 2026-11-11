package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type stressFrame struct {
	Seq  uint64 `json:"seq"`
	Type string `json:"type"`
}

func parseStressFrame(t *testing.T, raw []byte) stressFrame {
	var f stressFrame
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Errorf("unparseable frame %q: %v", raw, err)
	}
	return f
}

// stressDevice models one device: it resumes with max(seq) seen, reads what its
// socket delivers, drops, and resumes again. Every channel_update with a seq
// above its starting point must reach it exactly once (replay or live).
type stressDevice struct {
	uid     int64
	lastSeq uint64
	seen    map[uint64]int // channel_update seq -> copies
	refused int
	resumes int
}

func (u *stressDevice) take(t *testing.T, raw []byte, live bool, connMax *uint64) {
	f := parseStressFrame(t, raw)
	if f.Seq == 0 {
		return // unsequenced (SESSION_REPLACED and the like)
	}
	if live {
		if f.Seq <= *connMax {
			t.Errorf("user %d: live seq %d not above the connection's previous %d (order/dup)", u.uid, f.Seq, *connMax)
		}
	}
	if f.Seq > *connMax {
		*connMax = f.Seq
	}
	if f.Type == "channel_update" {
		u.seen[f.Seq]++
	}
	if f.Seq > u.lastSeq {
		u.lastSeq = f.Seq
	}
}

// Real producers and a dispatcher run against devices that resume, drop and
// resume again in a loop. Every channel_update must reach every device exactly
// once, by replay or live, and live seqs only rise. A producer that resolved
// its audience before reading the mark fails here.
func TestRecipientsFrame_ResumeLoopNeverMissesOrDuplicates(t *testing.T) {
	f := newLateResumeFixture(t)
	h := f.hub
	ctx := context.Background()
	const nUsers = 6
	const nFrames = 280
	// Room for every frame of the run, so a device the scheduler starves is
	// never dropped for a full queue (that path is the loss tests' subject).
	const sendRoom = 1024

	users := make([]*stressDevice, nUsers)
	for i := range users {
		users[i] = &stressDevice{uid: f.createUser(t, fmt.Sprintf("stress-%d", i), 4), lastSeq: f.lastSeq, seen: map[uint64]int{}}
	}

	stop := make(chan struct{})
	var dispatchWG, wg sync.WaitGroup
	dispatchWG.Go(func() {
		for {
			select {
			case bm := <-h.broadcast:
				h.deliverBroadcast(bm)
			case <-stop:
				for {
					select {
					case bm := <-h.broadcast:
						h.deliverBroadcast(bm)
					default:
						return
					}
				}
			}
		}
	})

	var producing atomic.Int32
	producing.Store(3)
	// Two producers through the real queued producer, one through the sync one.
	for range 2 {
		wg.Go(func() {
			defer producing.Add(-1)
			for i := range nFrames / 2 {
				h.broadcastChannelScoped(ctx, f.chID, renameFrame(), "channel_update")
				if i%3 == 0 {
					h.BroadcastToAll([]byte(`{"type":"roles_update","payload":{}}`))
				}
				time.Sleep(50 * time.Microsecond)
			}
		})
	}
	wg.Go(func() {
		defer producing.Add(-1)
		for range nFrames / 4 {
			mark := h.audienceMark()
			aud := h.channelReadAudience(ctx, f.chID)
			h.sendSequencedToUsers(f.chID, aud, mark, renameFrame())
			time.Sleep(80 * time.Microsecond)
		}
	})

	var uwg sync.WaitGroup
	cycle := func(u *stressDevice, i int, prev *Client, final bool) *Client {
		dbu, err := f.database.GetUserByID(ctx, u.uid)
		if err != nil || dbu == nil {
			t.Errorf("GetUserByID: %v", err)
			return prev
		}
		allowed, err := h.computeAllowedChannels(ctx, h.readers.Visibility, dbu)
		if err != nil {
			t.Errorf("computeAllowedChannels: %v", err)
			return prev
		}
		c := NewTestClientWithUser(h, dbu, 0, make(chan []byte, sendRoom))
		c.lastSeq = u.lastSeq
		events, ok := h.reconnectRegister(ctx, c, u.lastSeq, allowed, allowed, "buffer", nil, 0)
		if !ok {
			u.refused++
			return prev
		}
		u.resumes++
		connMax := u.lastSeq
		for _, e := range events {
			u.take(t, e, false, &connMax)
		}
		// Read the socket for a moment.
		deadline := time.Now().Add(time.Duration(100+50*(i%5)) * time.Microsecond)
		if final {
			deadline = time.Now().Add(50 * time.Millisecond)
		}
		for time.Now().Before(deadline) {
			select {
			case m, open := <-c.send:
				if !open {
					t.Errorf("user %d: live connection's send closed", u.uid)
					return c
				}
				u.take(t, m, true, &connMax)
			default:
				time.Sleep(20 * time.Microsecond)
			}
		}
		return c
	}
	conns := make([]*Client, nUsers)
	for idx, u := range users {
		uwg.Go(func() {
			var cur *Client
			for i := 0; producing.Load() > 0; i++ {
				// Odd users drop the socket before resuming; even ones resume over
				// the still-registered connection (replace).
				if cur != nil && (idx%2 == 1 || i%3 == 0) {
					h.unregisterNow(cur)
					cur = nil
				}
				cur = cycle(u, i, cur, false)
			}
			conns[idx] = cur
		})
	}
	wg.Wait()
	uwg.Wait()
	close(stop)
	dispatchWG.Wait()

	// Quiesced: one last resume per user picks up whatever is left.
	for idx, u := range users {
		if conns[idx] != nil {
			h.unregisterNow(conns[idx])
		}
		cycle(u, 0, nil, true)
	}

	var all []uint64
	for _, e := range h.ReplayBuffer().EventsSince(f.lastSeq) {
		if fr := parseStressFrame(t, e); fr.Type == "channel_update" {
			all = append(all, fr.Seq)
		}
	}
	if len(all) == 0 {
		t.Fatal("setup: no channel_update was sequenced")
	}
	for _, u := range users {
		missing, dup := 0, 0
		for _, s := range all {
			switch n := u.seen[s]; {
			case n == 0:
				missing++
			case n > 1:
				dup++
			}
		}
		if missing > 0 || dup > 0 {
			t.Errorf("user %d: %d missing, %d duplicated of %d channel_update frames (%d resumes, %d refused)",
				u.uid, missing, dup, len(all), u.resumes, u.refused)
		}
	}
}
