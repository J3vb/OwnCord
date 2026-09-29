package ws_test

import (
	"context"
	"net"
	"os"
	"testing"
	"time"

	"github.com/J3vb/OwnCord/Server/config"
	"github.com/J3vb/OwnCord/Server/ws"
	"github.com/livekit/protocol/auth"
	lksdk "github.com/livekit/server-sdk-go/v2"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

// This is the real-SFU proof for single-port UDP (O1): OwnCord's *generated*
// livekit.yaml is handed to a real livekit-server binary, a real WebRTC client
// joins, publishes audio, and a second client receives RTP over it — once with
// the shipped 50000-60000 range and once with voice.udp_port. Single-port mode
// is untested upstream, and a YAML-only assertion cannot tell whether LiveKit
// accepts the result, so this is the only test that proves the mode carries
// media.
//
// It is skipped unless OWNCORD_LIVEKIT_TEST_BINARY names a real livekit-server,
// the same skip-not-pass convention as the smoke drill: CI's Server Build & Test
// (ubuntu) leg installs the pinned binary and sets it, and a local run without
// it reports skipped rather than a false pass.
//
// The binary binds the ports in the generated config (HTTP 7880, TCP 7881, and
// the UDP port), so the test is designed for the dedicated CI runner, not for a
// machine already running LiveKit.
const livekitEnv = "OWNCORD_LIVEKIT_TEST_BINARY"

func realLiveKitBinary(t *testing.T) string {
	t.Helper()
	bin := os.Getenv(livekitEnv)
	if bin == "" {
		t.Skipf("set %s to a real livekit-server binary to run this proof", livekitEnv)
	}
	// Set but unusable is a failure, not a skip: CI sets it on the leg that
	// installed the binary, and a bad path there must not read as a pass.
	if _, err := os.Stat(bin); err != nil {
		t.Fatalf("%s=%q is not a usable file: %v", livekitEnv, bin, err)
	}
	return bin
}

func freeUDPPort(t *testing.T) int {
	t.Helper()
	conn, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserving a UDP port: %v", err)
	}
	port := conn.LocalAddr().(*net.UDPAddr).Port
	_ = conn.Close()
	return port
}

// runVoiceOverGeneratedConfig generates OwnCord's config for cfg, starts the
// real binary on it, and returns once media published by one client reaches
// another. It fails the test if no RTP arrives.
func runVoiceOverGeneratedConfig(t *testing.T, cfg *config.VoiceConfig, binary string) {
	t.Helper()

	dataDir := t.TempDir()
	cfg.LiveKitBinaryPath = binary
	cfg.LiveKitURL = "ws://127.0.0.1:7880"
	proc := ws.NewLiveKitProcess(cfg, &config.TLSConfig{}, dataDir)

	if err := proc.Start(); err != nil {
		t.Fatalf("starting livekit: %v", err)
	}
	t.Cleanup(proc.Stop)

	ctx := context.Background()
	waited := time.Now()
	for {
		ok, herr := proc.HealthCheck(ctx)
		if ok {
			break
		}
		if time.Since(waited) > 20*time.Second {
			t.Fatalf("livekit did not become healthy: %v", herr)
		}
		time.Sleep(250 * time.Millisecond)
	}

	const (
		key    = "testkey"
		secret = "testsecret-at-least-32-characters-long"
	)
	token := func(identity string) string {
		at := auth.NewAccessToken(key, secret)
		at.SetVideoGrant(&auth.VideoGrant{RoomJoin: true, Room: "single-port-proof"})
		at.SetIdentity(identity)
		s, err := at.ToJWT()
		if err != nil {
			t.Fatalf("minting token: %v", err)
		}
		return s
	}

	received := make(chan struct{}, 1)
	subscribed := make(chan *lksdk.RemoteTrackPublication, 1)
	sub, err := lksdk.ConnectToRoomWithToken(cfg.LiveKitURL, token("subscriber"), &lksdk.RoomCallback{
		OnTrackSubscribed: func(track *webrtc.TrackRemote, remote *lksdk.RemoteTrackPublication, _ *lksdk.RemoteParticipant) {
			select {
			case subscribed <- remote:
			default:
			}
			go func() {
				for {
					if _, _, rerr := track.ReadRTP(); rerr != nil {
						return
					}
					select {
					case received <- struct{}{}:
					default:
					}
				}
			}()
		},
	})
	if err != nil {
		t.Fatalf("subscriber join: %v", err)
	}
	defer sub.Disconnect()

	pub, err := lksdk.ConnectToRoomWithToken(cfg.LiveKitURL, token("publisher"), &lksdk.RoomCallback{})
	if err != nil {
		t.Fatalf("publisher join: %v", err)
	}
	defer pub.Disconnect()

	track, err := lksdk.NewLocalTrack(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus})
	if err != nil {
		t.Fatalf("local track: %v", err)
	}
	if _, err := pub.LocalParticipant.PublishTrack(track, &lksdk.TrackPublicationOptions{Name: "audio"}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		tick := time.NewTicker(20 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case <-tick.C:
				_ = track.WriteSample(media.Sample{Data: []byte{0xf8, 0xff, 0xfe}, Duration: 20 * time.Millisecond}, nil)
			}
		}
	}()

	select {
	case <-received:
	case <-time.After(20 * time.Second):
		t.Fatal("no RTP received — the generated config does not carry media")
	}

	// RTP arriving is not enough: it must have come over the configured UDP
	// port (or range), not a fallback such as the TCP 7881 candidate.
	remote := <-subscribed
	var pair *webrtc.ICECandidatePair
	for deadline := time.Now().Add(5 * time.Second); pair == nil; time.Sleep(100 * time.Millisecond) {
		pair, err = remote.Receiver().Transport().ICETransport().GetSelectedCandidatePair()
		if err != nil {
			t.Fatalf("selected candidate pair: %v", err)
		}
		if pair == nil && time.Now().After(deadline) {
			t.Fatal("no selected ICE candidate pair on the subscriber")
		}
	}
	if pair.Remote.Protocol != webrtc.ICEProtocolUDP {
		t.Fatalf("media travelled over %s, want UDP (pair %s)", pair.Remote.Protocol, pair)
	}
	if cfg.UDPPort > 0 {
		if pair.Remote.Port != uint16(cfg.UDPPort) {
			t.Fatalf("media travelled on SFU port %d, want the single udp_port %d", pair.Remote.Port, cfg.UDPPort)
		}
	} else if pair.Remote.Port < 50000 || pair.Remote.Port > 60000 {
		t.Fatalf("media travelled on SFU port %d, want one in 50000-60000", pair.Remote.Port)
	}
}

// Single-port mode carries real media.
func TestRealLiveKit_SinglePortUDPCarriesMedia(t *testing.T) {
	binary := realLiveKitBinary(t)
	runVoiceOverGeneratedConfig(t, &config.VoiceConfig{
		LiveKitAPIKey:    "testkey",
		LiveKitAPISecret: "testsecret-at-least-32-characters-long",
		NodeIP:           "127.0.0.1",
		UDPPort:          freeUDPPort(t),
	}, binary)
}

// The shipped range mode still carries media, so the new option does not
// regress the default.
func TestRealLiveKit_PortRangeCarriesMedia(t *testing.T) {
	binary := realLiveKitBinary(t)
	runVoiceOverGeneratedConfig(t, &config.VoiceConfig{
		LiveKitAPIKey:    "testkey",
		LiveKitAPISecret: "testsecret-at-least-32-characters-long",
		NodeIP:           "127.0.0.1",
		UDPPort:          0,
	}, binary)
}
