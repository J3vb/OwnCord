package ws_test

import (
	"testing"

	"github.com/owncord/server/config"
	"github.com/owncord/server/ws"
)

func testVoiceConfig() *config.VoiceConfig {
	return &config.VoiceConfig{
		Quality:      "medium",
		MediaPortMin: 50000,
		MediaPortMax: 50100,
	}
}

func TestNewSFU_Success(t *testing.T) {
	sfu, err := ws.NewSFU(testVoiceConfig())
	if err != nil {
		t.Fatalf("NewSFU() returned error: %v", err)
	}
	if sfu == nil {
		t.Fatal("NewSFU() returned nil SFU")
	}
	defer sfu.Close()
}

func TestNewSFU_CreatesValidPeerConnection(t *testing.T) {
	sfu, err := ws.NewSFU(testVoiceConfig())
	if err != nil {
		t.Fatalf("NewSFU() returned error: %v", err)
	}
	defer sfu.Close()

	pc, err := sfu.NewPeerConnection()
	if err != nil {
		t.Fatalf("NewPeerConnection() returned error: %v", err)
	}
	if pc == nil {
		t.Fatal("NewPeerConnection() returned nil PeerConnection")
	}
	if err := pc.Close(); err != nil {
		t.Fatalf("PeerConnection.Close() returned error: %v", err)
	}
}

func TestSFU_QualityBitrate_Presets(t *testing.T) {
	tests := []struct {
		quality string
		want    int
	}{
		{"low", 32000},
		{"medium", 64000},
		{"high", 128000},
		{"unknown", 64000},
		{"", 64000},
	}

	for _, tt := range tests {
		t.Run(tt.quality, func(t *testing.T) {
			cfg := testVoiceConfig()
			cfg.Quality = tt.quality

			sfu, err := ws.NewSFU(cfg)
			if err != nil {
				t.Fatalf("NewSFU() returned error: %v", err)
			}
			defer sfu.Close()

			got := sfu.QualityBitrate()
			if got != tt.want {
				t.Errorf("QualityBitrate() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestSFU_Close(t *testing.T) {
	sfu, err := ws.NewSFU(testVoiceConfig())
	if err != nil {
		t.Fatalf("NewSFU() returned error: %v", err)
	}

	// Close should not panic.
	sfu.Close()
}

func TestNewSFU_WithExternalIP(t *testing.T) {
	cfg := testVoiceConfig()
	cfg.ExternalIP = "203.0.113.1"

	sfu, err := ws.NewSFU(cfg)
	if err != nil {
		t.Fatalf("NewSFU() returned error: %v", err)
	}
	defer sfu.Close()

	pc, err := sfu.NewPeerConnection()
	if err != nil {
		t.Fatalf("NewPeerConnection() returned error: %v", err)
	}
	if err := pc.Close(); err != nil {
		t.Fatalf("PeerConnection.Close() returned error: %v", err)
	}
}
