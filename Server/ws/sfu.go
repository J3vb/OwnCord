package ws

import (
	"fmt"
	"strconv"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"

	"github.com/owncord/server/config"
)

// SFU wraps Pion's WebRTC API with pre-configured MediaEngine,
// InterceptorRegistry, and SettingEngine.
type SFU struct {
	api    *webrtc.API
	config *config.VoiceConfig
}

// NewSFU creates a new SFU with the given voice configuration. It sets up
// the Pion MediaEngine with default codecs, registers the ssrc-audio-level
// RTP header extension, configures interceptors, and applies NAT/port settings.
func NewSFU(cfg *config.VoiceConfig) (*SFU, error) {
	var me webrtc.MediaEngine
	if err := me.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}

	// Register ssrc-audio-level header extension for active speaker detection.
	const audioLevelURI = "urn:ietf:params:rtp-hdrext:ssrc-audio-level"
	for _, dir := range []webrtc.RTPTransceiverDirection{
		webrtc.RTPTransceiverDirectionSendonly,
		webrtc.RTPTransceiverDirectionRecvonly,
	} {
		if err := me.RegisterHeaderExtension(
			webrtc.RTPHeaderExtensionCapability{URI: audioLevelURI},
			webrtc.RTPCodecTypeAudio,
			dir,
		); err != nil {
			return nil, err
		}
	}

	var ir interceptor.Registry
	if err := webrtc.RegisterDefaultInterceptors(&me, &ir); err != nil {
		return nil, err
	}

	var se webrtc.SettingEngine
	_ = se.SetEphemeralUDPPortRange(uint16(cfg.MediaPortMin), uint16(cfg.MediaPortMax))

	if cfg.ExternalIP != "" {
		if err := se.SetICEAddressRewriteRules(webrtc.ICEAddressRewriteRule{
			External:        []string{cfg.ExternalIP},
			AsCandidateType: webrtc.ICECandidateTypeHost,
			Mode:            webrtc.ICEAddressRewriteReplace,
		}); err != nil {
			return nil, fmt.Errorf("setting ICE address rewrite rules: %w", err)
		}
	}

	api := webrtc.NewAPI(
		webrtc.WithMediaEngine(&me),
		webrtc.WithInterceptorRegistry(&ir),
		webrtc.WithSettingEngine(se),
	)

	return &SFU{api: api, config: cfg}, nil
}

// NewPeerConnection creates a new PeerConnection using the SFU's pre-configured
// WebRTC API and ICE server settings from config.
func (s *SFU) NewPeerConnection() (*webrtc.PeerConnection, error) {
	pcConfig := webrtc.Configuration{}

	// Add STUN server if port is configured.
	if s.config.STUNPort > 0 {
		pcConfig.ICEServers = append(pcConfig.ICEServers, webrtc.ICEServer{
			URLs: []string{"stun:localhost:" + strconv.Itoa(s.config.STUNPort)},
		})
	}

	// Add TURN server if enabled.
	if s.config.TURNEnabled && s.config.TURNPort > 0 {
		pcConfig.ICEServers = append(pcConfig.ICEServers, webrtc.ICEServer{
			URLs:       []string{"turn:localhost:" + strconv.Itoa(s.config.TURNPort)},
			Username:   "owncord",
			Credential: s.config.TURNSecret,
		})
	}

	return s.api.NewPeerConnection(pcConfig)
}

// Close is a placeholder for SFU cleanup. Future implementations may close
// active peer connections or release resources.
func (s *SFU) Close() {
	// Placeholder for cleanup.
}

// QualityBitrate returns the target audio bitrate in bits/s based on the
// configured quality preset.
func (s *SFU) QualityBitrate() int {
	switch s.config.Quality {
	case "low":
		return 32000
	case "high":
		return 128000
	default:
		return 64000
	}
}

