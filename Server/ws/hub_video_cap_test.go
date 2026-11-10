package ws

// hub_video_cap_test.go: the server-wide video upload cap. The setting is the
// admin's; the hub holds the value auth_ok reads and tells connected clients with
// the unsequenced video_bitrate_cap frame after each save.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/J3vb/OwnCord/Server/db"
	"github.com/J3vb/OwnCord/Server/service"
)

// saveVideoCap stores the cap the way the admin PATCH does and hands it to the
// hub, which re-reads the stored value.
func saveVideoCap(t *testing.T, h *Hub, database *db.DB, kbps int) {
	t.Helper()
	if err := database.SetSetting(context.Background(), service.VoiceMaxVideoKbpsKey, strconv.Itoa(kbps)); err != nil {
		t.Errorf("SetSetting: %v", err)
		return
	}
	h.ApplyVideoBitrateCap(kbps)
}

// videoCapFrames returns the cap each queued video_bitrate_cap frame carries,
// and fails on a sequenced one.
func videoCapFrames(t *testing.T, c *Client) []int {
	t.Helper()
	var out []int
	for _, raw := range drain(c.send) {
		var f struct {
			Type    string          `json:"type"`
			Seq     json.RawMessage `json:"seq"`
			Payload struct {
				MaxVideoBitrate *int `json:"max_video_bitrate"`
			} `json:"payload"`
		}
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatalf("frame %s: %v", raw, err)
		}
		if f.Type != MsgTypeVideoBitrateCap {
			continue
		}
		if f.Seq != nil {
			t.Fatalf("video_bitrate_cap carries seq %s: %s", f.Seq, raw)
		}
		if f.Payload.MaxVideoBitrate == nil {
			t.Fatalf("video_bitrate_cap has no max_video_bitrate: %s", raw)
		}
		out = append(out, *f.Payload.MaxVideoBitrate)
	}
	return out
}

func authOKVideoCap(t *testing.T, h *Hub, u *db.User, replaySource string) int {
	t.Helper()
	var env struct {
		Payload struct {
			Cap *struct {
				MaxVideoBitrate int `json:"max_video_bitrate"`
			} `json:"video_bitrate_cap"`
		} `json:"payload"`
	}
	if err := json.Unmarshal(h.buildAuthOK(context.Background(), u, "member", nil, replaySource), &env); err != nil {
		t.Fatal(err)
	}
	if env.Payload.Cap == nil {
		t.Fatalf("auth_ok (%s) has no video_bitrate_cap", replaySource)
	}
	return env.Payload.Cap.MaxVideoBitrate
}

func TestVideoBitrateCap_FrameUnsequencedToAll(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	a := connect("vcframea", true)
	b := connect("vcframeb", true)
	settle(t, h)
	drain(a.send)
	drain(b.send)
	before := atomic.LoadUint64(&h.seq)

	saveVideoCap(t, h, database, 6000)
	for _, c := range []*Client{a, b} {
		if got := videoCapFrames(t, c); len(got) != 1 || got[0] != 6_000_000 {
			t.Fatalf("client %d cap frames = %v, want one 6000000", c.userID, got)
		}
	}
	if after := atomic.LoadUint64(&h.seq); after != before {
		t.Fatalf("seq moved %d -> %d: the cap frame was sequenced", before, after)
	}

	saveVideoCap(t, h, database, 0)
	for _, c := range []*Client{a, b} {
		if got := videoCapFrames(t, c); len(got) != 1 || got[0] != 0 {
			t.Fatalf("client %d cap frames = %v, want one 0 (no cap)", c.userID, got)
		}
	}
}

// A resume gets no ready, so auth_ok carries the cap on every tier.
func TestVideoBitrateCap_AuthOkCarriesCap_ConnectAndResume(t *testing.T) {
	h, database, _ := presenceBatchHub(t)
	u := &db.User{ID: 1, Username: "vcauth"}
	for _, source := range []string{"none", "buffer", "db"} {
		if got := authOKVideoCap(t, h, u, source); got != 0 {
			t.Errorf("auth_ok (%s) cap = %d with no setting, want 0", source, got)
		}
	}
	saveVideoCap(t, h, database, 2500)
	for _, source := range []string{"none", "buffer", "db"} {
		if got := authOKVideoCap(t, h, u, source); got != 2_500_000 {
			t.Errorf("auth_ok (%s) cap = %d, want 2500000", source, got)
		}
	}
}

// Edge case 1: a save racing connections. A connection registers and then builds
// its auth_ok (the handshake order), and its queued frames drain after auth_ok.
// One connection registers before the save (it must get the frame) and one right
// after the save's snapshot, through the hook: it is not sent the frame, so its
// auth_ok must already read the new value. Each must end on the save.
func TestVideoBitrateCap_SaveRacingConnect_EndsOnLastSave(t *testing.T) {
	h, database, connect := presenceBatchHub(t)
	before := connect("vcracebefore", true)
	beforeAuth := authOKVideoCap(t, h, before.user, "none")
	drain(before.send)

	var inWindow *Client
	var inWindowAuth int
	applyVideoCapAfterSnapshotHook = func() {
		inWindow = connect("vcracewindow", true)
		inWindowAuth = authOKVideoCap(t, h, inWindow.user, "none")
	}
	t.Cleanup(func() { applyVideoCapAfterSnapshotHook = nil })
	saveVideoCap(t, h, database, 900)
	applyVideoCapAfterSnapshotHook = nil

	endsOn := func(auth int, c *Client) int {
		if frames := videoCapFrames(t, c); len(frames) > 0 {
			return frames[len(frames)-1]
		}
		return auth
	}
	if got := endsOn(beforeAuth, before); got != 900_000 {
		t.Errorf("connection registered before the save ended on %d, want 900000", got)
	}
	if got := endsOn(inWindowAuth, inWindow); got != 900_000 {
		t.Errorf("connection registered inside the save ended on %d, want 900000", got)
	}

	// Many saves and connects at once, under -race: still none ends stale.
	const conns = 12
	clients := make([]*Client, conns)
	authVals := make([]int, conns)
	var wg sync.WaitGroup
	wg.Go(func() {
		for _, kbps := range []int{300, 1000, 4000, 700} {
			saveVideoCap(t, h, database, kbps)
		}
	})
	for i := range conns {
		wg.Go(func() {
			c := connect("vcrace"+strconv.Itoa(i), true)
			clients[i] = c
			authVals[i] = authOKVideoCap(t, h, c.user, "none")
		})
	}
	wg.Wait()
	for i, c := range clients {
		if got := endsOn(authVals[i], c); got != 700_000 {
			t.Errorf("connection %d ended on cap %d, want the last save 700000", i, got)
		}
	}
}

type videoCapSettingsStub struct {
	real SettingsReader
	err  error
}

func (s *videoCapSettingsStub) Setting(ctx context.Context, key string) (string, error) {
	if key == service.VoiceMaxVideoKbpsKey && s.err != nil {
		return "", s.err
	}
	return s.real.Setting(ctx, key)
}

// Edge case 2: the PATCH committed but the hub's re-read fails. The value the
// admin just saved is used, and clients are still told.
func TestVideoBitrateCap_ApplyReadErrorUsesSavedValue(t *testing.T) {
	database := newTeardownTestDB(t)
	stub := &videoCapSettingsStub{real: service.NewSettingsService(database)}
	h := newTestHubWith(t, HubOptions{DB: database, Settings: stub})
	buf := captureWarns(t)
	stub.err = errors.New("settings read failed")

	h.ApplyVideoBitrateCap(1500)
	if got := h.videoBitrateCap(); got != 1_500_000 {
		t.Fatalf("cap after a failed re-read = %d, want the saved 1500000", got)
	}
	if !bytes.Contains(buf.Bytes(), []byte("video_bitrate_cap: reading the setting failed")) || !bytes.Contains(buf.Bytes(), []byte("stage=apply")) {
		t.Fatalf("warn log = %q, want the apply warning", buf.String())
	}
}

func TestVideoBitrateCap_InitReadsStoredValue(t *testing.T) {
	database := newTeardownTestDB(t)
	if err := database.SetSetting(context.Background(), service.VoiceMaxVideoKbpsKey, "8000"); err != nil {
		t.Fatal(err)
	}
	h := newTestHubWith(t, HubOptions{DB: database})
	if got := h.videoBitrateCap(); got != 8_000_000 {
		t.Fatalf("cap at start = %d, want 8000000", got)
	}
	// A hand-edited row outside the range reads as no cap.
	db2 := newTeardownTestDB(t)
	if err := db2.SetSetting(context.Background(), service.VoiceMaxVideoKbpsKey, "12"); err != nil {
		t.Fatal(err)
	}
	if got := newTestHubWith(t, HubOptions{DB: db2}).videoBitrateCap(); got != 0 {
		t.Fatalf("cap from an out-of-range row = %d, want 0", got)
	}
}

func TestVideoBitrateCap_InitReadErrorMeansNoCap(t *testing.T) {
	database := newTeardownTestDB(t)
	buf := captureWarns(t)
	h := newTestHubWith(t, HubOptions{
		DB:       database,
		Settings: &videoCapSettingsStub{real: service.NewSettingsService(database), err: errors.New("settings read failed")},
	})
	if got := h.videoBitrateCap(); got != 0 {
		t.Fatalf("cap after an unreadable setting = %d, want 0", got)
	}
	if !bytes.Contains(buf.Bytes(), []byte("stage=init")) {
		t.Fatalf("warn log = %q, want the init warning", buf.String())
	}
}
