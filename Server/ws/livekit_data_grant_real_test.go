package ws

import (
	"context"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/livekit/protocol/livekit"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/livekitproc"
)

// The real-SFU proof for voice.restrict_data_publishing. A decoded grant only
// shows what OwnCord asked for; whether a media server honours it can only be
// seen on one. So a real livekit-server runs here and real WebRTC clients
// join with credentials from the production issuance path (GenerateToken) and
// are updated through the production live path (updateParticipantPublishing).
//
// Skipped unless OWNCORD_LIVEKIT_TEST_BINARY names a livekit-server binary,
// the same skip-not-pass convention as livekitproc's single-port proof. Both
// bind LiveKit's fixed ports (7880, 7881), so the two packages must not run
// in parallel with the variable set: CI runs them with -p 1.
const realLiveKitEnv = "OWNCORD_LIVEKIT_TEST_BINARY"

const (
	dataProofChannel = int64(7)
	dataProofWait    = 20 * time.Second
	// dataProofSettlePackets is how many fresh 20 ms audio packets must cross
	// the media server before a withheld grant is restored.
	dataProofSettlePackets = 15
)

// dataProofRoom is one participant's connection plus what it has received.
type dataProofRoom struct {
	room *lksdk.Room

	mu       sync.Mutex
	payloads []string // user data payloads, in arrival order

	rtp sync.Map // publisher identity -> *atomic.Int64 packets received
}

func (r *dataProofRoom) received() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.payloads)
}

func (r *dataProofRoom) rtpFrom(identity string) int64 {
	if n, ok := r.rtp.Load(identity); ok {
		return n.(*atomic.Int64).Load()
	}
	return 0
}

// dataProofEventually polls an external process's state. The condition is the
// barrier; the deadline only turns a hang into a failure.
func dataProofEventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(dataProofWait)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func dataProofJoin(t *testing.T, url, token string) *dataProofRoom {
	t.Helper()
	r := &dataProofRoom{}
	room, err := lksdk.ConnectToRoomWithToken(url, token, &lksdk.RoomCallback{
		OnDataPacket: func(data lksdk.DataPacket, _ lksdk.DataReceiveParams) {
			if user, ok := data.(*lksdk.UserDataPacket); ok {
				r.mu.Lock()
				r.payloads = append(r.payloads, string(user.Payload))
				r.mu.Unlock()
			}
		},
		OnTrackSubscribed: func(track *webrtc.TrackRemote, _ *lksdk.RemoteTrackPublication, from *lksdk.RemoteParticipant) {
			counter, _ := r.rtp.LoadOrStore(from.Identity(), &atomic.Int64{})
			go func() {
				for {
					if _, _, err := track.ReadRTP(); err != nil {
						return
					}
					counter.(*atomic.Int64).Add(1)
				}
			}()
		},
	})
	if err != nil {
		t.Fatalf("joining the room: %v", err)
	}
	t.Cleanup(room.Disconnect)
	r.room = room
	return r
}

// publishAudio starts a microphone track that keeps sending until the test ends.
func (r *dataProofRoom) publishAudio(t *testing.T) {
	t.Helper()
	track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus})
	if err != nil {
		t.Fatalf("local track: %v", err)
	}
	if _, err := r.room.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{
		Name:   "audio",
		Source: livekit.TrackSource_MICROPHONE,
	}); err != nil {
		t.Fatalf("publishing audio: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	t.Cleanup(func() {
		cancel()
		<-done
	})
	go func() {
		defer close(done)
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				_ = track.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}, nil)
			}
		}
	}()
}

func (r *dataProofRoom) send(t *testing.T, payload string, reliable bool) {
	t.Helper()
	if err := r.room.LocalParticipant.PublishDataPacket(lksdk.UserData([]byte(payload)), lksdk.WithDataPublishReliable(reliable)); err != nil {
		t.Fatalf("sending %q: %v", payload, err)
	}
}

func (r *dataProofRoom) mayPublishData() bool {
	return r.room.LocalParticipant.Permissions().GetCanPublishData()
}

// startDataProofSFU runs the real binary on OwnCord's generated config and
// returns the voice config both policy clients are built from.
func startDataProofSFU(t *testing.T) config.VoiceConfig {
	t.Helper()
	binary := os.Getenv(realLiveKitEnv)
	if binary == "" {
		t.Skipf("set %s to a real livekit-server binary to run this proof", realLiveKitEnv)
	}
	// Set but unusable is a failure, not a skip: a bad path on the CI leg that
	// installed the binary must not read as a pass.
	if _, err := os.Stat(binary); err != nil {
		t.Fatalf("%s=%q is not a usable file: %v", realLiveKitEnv, binary, err)
	}
	cfg := config.VoiceConfig{
		LiveKitAPIKey:     "dataproofkey",
		LiveKitAPISecret:  "dataproof-secret-at-least-32-characters",
		LiveKitURL:        "ws://127.0.0.1:7880",
		LiveKitBinaryPath: binary,
		NodeIP:            "127.0.0.1",
	}
	proc := livekitproc.New(&cfg, &config.TLSConfig{}, t.TempDir())
	if err := proc.Start(); err != nil {
		t.Fatalf("starting livekit: %v", err)
	}
	t.Cleanup(proc.Stop)
	dataProofEventually(t, "livekit to become healthy", func() bool {
		ok, _ := proc.HealthCheck(context.Background())
		return ok
	})
	return cfg
}

func dataProofClient(t *testing.T, cfg config.VoiceConfig, restrict bool) *LiveKitClient {
	t.Helper()
	cfg.RestrictDataPublishing = restrict
	client, err := NewLiveKitClient(&cfg)
	if err != nil {
		t.Fatalf("NewLiveKitClient: %v", err)
	}
	return client
}

func dataProofToken(t *testing.T, client *LiveKitClient, userID int64, joinToken string, microphone bool) string {
	t.Helper()
	token, err := client.GenerateToken(userID, "member", dataProofChannel, joinToken, microphone, microphone, microphone)
	if err != nil {
		t.Fatalf("GenerateToken: %v", err)
	}
	return token
}

// assertWithheld sends a marker the grant must stop, then has the rollback
// path hand the data grant back and sends a second marker. Both travel the
// same ordered reliable channel from the same sender, so once the listener
// holds the second one, the first was either forwarded before it or never:
// a media server that ignored the grant cannot pass.
//
// The restore travels a different path (HTTP) than the withheld marker, and
// nothing orders the two at the media server. So the restore waits until
// fresh audio has crossed the media server after the marker was sent: a
// margin of a few hundred milliseconds over a channel that needs well under
// one, not a strict barrier. Too short a margin can only fail this test,
// never pass it.
func assertWithheld(t *testing.T, stage string, sender, listener *dataProofRoom, open *LiveKitClient, userID int64, joinToken, speakerIdentity string) {
	t.Helper()
	identity := participantIdentity(userID, joinToken)
	if sender.mayPublishData() {
		t.Fatalf("%s: the media server still reports the data grant", stage)
	}
	sender.send(t, stage+" withheld", true)
	sender.send(t, stage+" withheld lossy", false)
	settleBeforeRestore(t, stage, listener, speakerIdentity)

	// Rollback: the setting off puts the data grant back with the microphone.
	if err := open.updateParticipantPublishing(context.Background(), dataProofChannel, userID, joinToken, true, true, true); err != nil {
		t.Fatalf("%s: restoring the grant: %v", stage, err)
	}
	dataProofEventually(t, stage+": the restored data grant", sender.mayPublishData)
	sender.send(t, stage+" restored", true)
	dataProofEventually(t, stage+": the restored marker", func() bool {
		return slices.Contains(listener.received(), stage+" restored")
	})
	for _, got := range listener.received() {
		if got == stage+" withheld" || got == stage+" withheld lossy" {
			t.Fatalf("%s: the media server forwarded %q from %s", stage, got, identity)
		}
	}
}

// assertAudioFlows requires fresh RTP from the publisher after this call, so a
// grant change that also withdrew the microphone would fail here.
func assertAudioFlows(t *testing.T, stage string, listener *dataProofRoom, identity string) {
	t.Helper()
	before := listener.rtpFrom(identity)
	dataProofEventually(t, stage+": audio from "+identity, func() bool {
		return listener.rtpFrom(identity) > before+5
	})
}

// settleBeforeRestore gives the media server time to handle what was just
// sent on the data channels: it returns once a run of fresh audio packets from
// the speaker, all sent after this call, has come through.
func settleBeforeRestore(t *testing.T, stage string, listener *dataProofRoom, speakerIdentity string) {
	t.Helper()
	before := listener.rtpFrom(speakerIdentity)
	dataProofEventually(t, stage+": audio before the grant is restored", func() bool {
		return listener.rtpFrom(speakerIdentity) > before+dataProofSettlePackets
	})
}

// assertNothingWithheldArrived is the closing sweep: no marker sent without
// the data grant reached the listener at any point, on either channel. It
// also covers a lossy marker, which has no ordered channel to wait on.
func assertNothingWithheldArrived(t *testing.T, listener *dataProofRoom) {
	t.Helper()
	for _, got := range listener.received() {
		if strings.Contains(got, " withheld") {
			t.Fatalf("the media server forwarded %q", got)
		}
	}
}

func TestRealLiveKit_DataPublishingGrant(t *testing.T) {
	cfg := startDataProofSFU(t)
	open := dataProofClient(t, cfg, false)
	restricted := dataProofClient(t, cfg, true)
	ctx := context.Background()

	listener := dataProofJoin(t, cfg.LiveKitURL, dataProofToken(t, restricted, 1, "listener", false))

	// A credential minted with the setting on: media publishes, data does not.
	const speakerJoin = "speaker"
	speakerIdentity := participantIdentity(2, speakerJoin)
	speaker := dataProofJoin(t, cfg.LiveKitURL, dataProofToken(t, restricted, 2, speakerJoin, true))
	speaker.publishAudio(t)
	assertAudioFlows(t, "fresh grant", listener, speakerIdentity)
	assertWithheld(t, "fresh grant", speaker, listener, open, 2, speakerJoin, speakerIdentity)
	assertAudioFlows(t, "fresh grant, after rollback", listener, speakerIdentity)

	// A participant connected under the default grant is brought to the
	// restricted grant by the live update.
	const earlierJoin = "earlier"
	earlierToken := dataProofToken(t, open, 3, earlierJoin, true)
	earlier := dataProofJoin(t, cfg.LiveKitURL, earlierToken)
	earlier.publishAudio(t)
	dataProofEventually(t, "the default grant to carry data", earlier.mayPublishData)
	earlier.send(t, "default delivered", true)
	dataProofEventually(t, "the default grant's marker", func() bool {
		return slices.Contains(listener.received(), "default delivered")
	})
	if err := restricted.updateParticipantPublishing(ctx, dataProofChannel, 3, earlierJoin, true, true, true); err != nil {
		t.Fatalf("live update: %v", err)
	}
	dataProofEventually(t, "the live update to withhold data", func() bool { return !earlier.mayPublishData() })
	assertAudioFlows(t, "live update", listener, participantIdentity(3, earlierJoin))
	assertWithheld(t, "live update", earlier, listener, open, 3, earlierJoin, speakerIdentity)

	// A new connection under the default grant is brought to the restricted
	// grant by the same live update.
	earlier.room.Disconnect()
	dataProofEventually(t, "the earlier connection to leave", func() bool {
		ids, err := open.ListParticipants(ctx, dataProofChannel)
		return err == nil && !slices.Contains(ids, participantIdentity(3, earlierJoin))
	})
	again := dataProofJoin(t, cfg.LiveKitURL, earlierToken)
	if err := restricted.updateParticipantPublishing(ctx, dataProofChannel, 3, earlierJoin, true, true, true); err != nil {
		t.Fatalf("live update after reconnect: %v", err)
	}
	dataProofEventually(t, "the live update after reconnect", func() bool { return !again.mayPublishData() })
	assertWithheld(t, "reconnect", again, listener, open, 3, earlierJoin, speakerIdentity)
	assertNothingWithheldArrived(t, listener)
}
